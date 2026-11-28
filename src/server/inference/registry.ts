import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import type { ModelRecord } from '../db/schema.ts';
import { safeExternalFetch } from '../security/crypto.ts';
import { inspectHardware } from './hardware.ts';
import {
  CircuitBreakerRegistry,
  estimateInferenceCostUsd,
  estimateTokensRough,
  trimPromptToContextWindow,
  withRetryAndBackoff,
} from './resilience.ts';
import { createRuntimes } from './runtimes.ts';
import type {
  CircuitBreakerStatus,
  InferenceEngine,
  InferenceRequest,
  InferenceResponse,
  InferenceStream,
  ModelDeployment,
  ModelHealth,
  ModelRegistry,
  ModelRole,
  RuntimeKind,
} from './types.ts';

const ALLOWED_OPEN_LICENSES = /^(apache-2\.0|mit|bsd-3-clause|bsd-2-clause|mpl-2\.0|llama|qwen|gemma|openrail|self-hosted)/i;

export const circuitBreakers = new CircuitBreakerRegistry(3, 20_000);

function isLoopbackOrPrivateHost(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

function isMetadataEndpoint(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      host === '169.254.169.254' ||
      host.startsWith('169.254.') ||
      host === 'metadata.google.internal' ||
      host === 'metadata' ||
      host.startsWith('fd00:ec2::')
    );
  } catch {
    return true;
  }
}

const ROLE_ALIAS_MAP: Record<string, ModelRole> = {
  fast: 'fast',
  lightweight: 'lightweight',
  reasoning: 'reasoning',
  deep: 'deep',
  coding: 'coding',
  business: 'business',
  research: 'research',
};

export class NeoModelRegistry implements ModelRegistry {
  private runtimes = createRuntimes();

  async discoverCompatibleModels() {
    const db = await getDb();
    const [models, hw] = await Promise.all([db.listModels(), inspectHardware()]);

    return models.map((m) => {
      const fitsVram = m.vram_gb === 0 || (hw.hasGpu && hw.totalVramGb >= m.vram_gb);
      const fitsRam = hw.totalRamGb >= m.ram_gb || m.runtime === 'embedded';
      const fitsDisk = hw.diskFreeGb === 0 || hw.diskFreeGb >= Math.max(0.5, m.ram_gb * 0.6);
      const compatible = fitsVram && fitsRam && fitsDisk;

      let compatibilityReason = 'Compatible with current host hardware';
      if (!fitsVram) {
        compatibilityReason = `Requires ${m.vram_gb} GB VRAM (host has ${hw.totalVramGb} GB VRAM)`;
      } else if (!fitsRam) {
        compatibilityReason = `Requires ${m.ram_gb} GB RAM (host has ${hw.totalRamGb} GB RAM)`;
      } else if (!fitsDisk) {
        compatibilityReason = `Insufficient free disk space (${hw.diskFreeGb} GB free)`;
      }

      return {
        id: m.id,
        name: m.name,
        runtime: m.runtime,
        license: m.license,
        vramGb: m.vram_gb,
        ramGb: m.ram_gb,
        compatible,
        compatibilityReason,
        deploymentStatus: m.deployment_status,
        downloadStatus: m.download_status,
      };
    });
  }

  async registerCandidateModel(input: {
    id: string;
    name: string;
    version?: string;
    runtime: RuntimeKind;
    architecture: string;
    source_repo: string;
    license: string;
    quantization?: string;
    context_length?: number;
    vram_gb?: number;
    ram_gb?: number;
    roles?: string[];
    costPer1kInputUsd?: number;
    costPer1kOutputUsd?: number;
  }): Promise<ModelRecord> {
    if (!ALLOWED_OPEN_LICENSES.test(input.license)) {
      throw new Error(`Model license '${input.license}' is not in Neo's verified open-weight license allowlist.`);
    }
    const db = await getDb();
    return db.upsertModel({
      id: input.id,
      name: input.name,
      version: input.version || '1.0',
      runtime: input.runtime,
      architecture: input.architecture,
      source_repo: input.source_repo,
      license: input.license,
      weight_location: null,
      checksum_sha256: null,
      download_status: input.runtime === 'embedded' ? 'ready' : 'available',
      quantization: input.quantization || 'Q4_K_M',
      context_length: input.context_length || 32768,
      vram_gb: input.vram_gb ?? 4,
      ram_gb: input.ram_gb ?? 6,
      modalities: ['text', 'code'],
      roles: input.roles || ['primary'],
      capabilities: { toolCalling: true, reasoning: 0.8, coding: 0.8, multilingual: 0.8, persian: 0.75 },
      benchmark_results: {},
      deployment_status: 'standby',
      health_status: 'unknown',
      performance_metrics: {
        ...(input.costPer1kInputUsd !== undefined ? { costPer1kInputUsd: input.costPer1kInputUsd } : {}),
        ...(input.costPer1kOutputUsd !== undefined ? { costPer1kOutputUsd: input.costPer1kOutputUsd } : {}),
      },
      last_validated_at: null,
    });
  }

  async installModel(
    modelId: string,
    options?: { sourceUrl?: string; expectedSha256?: string }
  ): Promise<{ ok: boolean; message: string }> {
    const db = await getDb();
    const model = await db.getModelById(modelId);
    if (!model) {
      return { ok: false, message: `Model '${modelId}' not found in Model Registry.` };
    }

    if (!ALLOWED_OPEN_LICENSES.test(model.license)) {
      return { ok: false, message: `Blocked install: unverified license '${model.license}'.` };
    }

    const hw = await inspectHardware(true);
    if (model.vram_gb > 0 && (!hw.hasGpu || hw.totalVramGb < model.vram_gb)) {
      return {
        ok: false,
        message: `Hardware check failed: model '${modelId}' requires ${model.vram_gb} GB VRAM, host has ${hw.totalVramGb} GB VRAM.`,
      };
    }
    if (hw.diskFreeGb > 0 && hw.diskFreeGb < model.ram_gb * 0.6) {
      return {
        ok: false,
        message: `Storage check failed: insufficient disk space (${hw.diskFreeGb} GB free).`,
      };
    }

    if (model.runtime === 'embedded') {
      await db.updateModel(model.id, { download_status: 'ready', health_status: 'healthy' });
      return { ok: true, message: `Embedded model '${model.id}' is built-in and ready.` };
    }

    if (model.runtime === 'ollama' && env.ollamaBaseUrl) {
      const base = env.ollamaBaseUrl.replace(/\/+$/, '');
      await db.updateModel(model.id, { download_status: 'downloading' });
      try {
        const res = await fetch(`${base}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: model.id, stream: false }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          await db.updateModel(model.id, { download_status: 'failed' });
          return { ok: false, message: `Ollama pull failed with HTTP ${res.status}` };
        }
        const verification = await this.verifyModelReady(model.id);
        if (!verification.ready) {
          await db.updateModel(model.id, { download_status: 'available', health_status: 'degraded' });
          return { ok: false, message: `Model pulled, but runtime readiness was not verified: ${verification.message}` };
        }
        await db.updateModel(model.id, {
          weight_location: `${base}/models/${model.id}`,
          last_validated_at: new Date().toISOString(),
        });
        return { ok: true, message: `Pulled and runtime-verified '${model.id}' in Ollama.` };
      } catch (err) {
        await db.updateModel(model.id, { download_status: 'failed' });
        return {
          ok: false,
          message: `Ollama service unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (options?.sourceUrl) {
      if (!options.expectedSha256 || !/^[a-f0-9]{64}$/i.test(options.expectedSha256)) {
        return { ok: false, message: 'A valid 64-character SHA-256 checksum is required for model artifact downloads.' };
      }
      await db.updateModel(model.id, { download_status: 'downloading' });
      try {
        const { response, bodyBuffer } = await safeExternalFetch(options.sourceUrl, {
          timeoutMs: 60_000,
          maxBytes: 100 * 1024 * 1024,
        });
        if (!response.ok) {
          await db.updateModel(model.id, { download_status: 'failed' });
          return { ok: false, message: `Artifact download failed HTTP ${response.status}` };
        }
        const sha256 = crypto.createHash('sha256').update(bodyBuffer).digest('hex');
        if (options.expectedSha256 && sha256.toLowerCase() !== options.expectedSha256.toLowerCase()) {
          await db.updateModel(model.id, { download_status: 'failed' });
          return { ok: false, message: `Checksum mismatch! Expected ${options.expectedSha256}, got ${sha256}` };
        }
        const modelsRoot = path.resolve(process.cwd(), env.modelsDir);
        fs.mkdirSync(modelsRoot, { recursive: true });
        const safeName = model.id.replace(/[^a-zA-Z0-9._-]/g, '_');
        const targetPath = path.join(modelsRoot, `${safeName}.bin`);
        fs.writeFileSync(targetPath, bodyBuffer);
        await db.updateModel(model.id, {
          download_status: 'available',
          weight_location: targetPath,
          checksum_sha256: sha256,
          health_status: 'unknown',
          last_validated_at: new Date().toISOString(),
        });
        return { ok: true, message: `Downloaded and checksum-verified (${sha256.slice(0, 12)}...). The artifact is not marked ready until its configured runtime confirms it can load the model.` };
      } catch (err) {
        await db.updateModel(model.id, { download_status: 'failed' });
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }

    return {
      ok: false,
      message: `No active runtime downloader for '${model.runtime}' or explicit artifact sourceUrl provided. Configure Ollama/vLLM endpoint or supply sourceUrl + expectedSha256.`,
    };
  }

  async verifyModelReady(modelId: string): Promise<{ ready: boolean; message: string }> {
    const db = await getDb();
    const model = await db.getModelById(modelId);
    if (!model) return { ready: false, message: `Model '${modelId}' is not registered.` };
    const runtime = this.runtimes[model.runtime];
    if (!runtime || !runtime.isConfigured()) {
      return { ready: false, message: `Runtime '${model.runtime}' is not configured.` };
    }
    if (!runtime.probeModelLoaded) {
      return { ready: false, message: `Runtime '${model.runtime}' cannot verify model availability.` };
    }
    const result = await runtime.probeModelLoaded(modelId);
    if (result.ready) {
      await db.updateModel(model.id, {
        download_status: 'ready',
        health_status: 'healthy',
        last_validated_at: new Date().toISOString(),
      });
    } else {
      await db.updateModel(model.id, { health_status: 'offline' });
    }
    return result;
  }

  async testRuntimeConnection(input: {
    runtime: RuntimeKind;
    baseUrl?: string;
    apiKey?: string;
    modelId?: string;
  }): Promise<{
    ok: boolean;
    runtime: RuntimeKind;
    endpoint: string;
    latencyMs: number;
    discoveredModels: string[];
    message: string;
  }> {
    const start = Date.now();
    if (input.runtime === 'embedded') {
      const health = await this.runtimes.embedded.healthCheck();
      return {
        ok: health.status === 'healthy',
        runtime: 'embedded',
        endpoint: 'in-process',
        latencyMs: Date.now() - start,
        discoveredModels: ['neo-embedded-core-v1'],
        message: health.message,
      };
    }

    const customUrl = input.baseUrl?.trim();
    if (customUrl) {
      let parsed: URL;
      try {
        parsed = new URL(customUrl);
      } catch {
        return {
          ok: false,
          runtime: input.runtime,
          endpoint: customUrl,
          latencyMs: Date.now() - start,
          discoveredModels: [],
          message: 'Invalid URL format.',
        };
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || isMetadataEndpoint(customUrl)) {
        return {
          ok: false,
          runtime: input.runtime,
          endpoint: customUrl,
          latencyMs: Date.now() - start,
          discoveredModels: [],
          message: 'Blocked runtime URL protocol or cloud metadata address.',
        };
      }

      const base = customUrl.replace(/\/+$/, '');
      const probePath = input.runtime === 'ollama' ? '/api/tags' : base.endsWith('/v1') ? '/models' : '/v1/models';
      try {
        const res = await fetch(`${base}${probePath}`, {
          headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {},
          signal: AbortSignal.timeout(5000),
        });
        const latencyMs = Date.now() - start;
        if (!res.ok) {
          return {
            ok: false,
            runtime: input.runtime,
            endpoint: base,
            latencyMs,
            discoveredModels: [],
            message: `HTTP ${res.status} from ${base}${probePath}`,
          };
        }
        const json = (await res.json().catch(() => ({}))) as {
          models?: Array<{ name?: string; model?: string }>;
          data?: Array<{ id?: string }>;
        };
        const discoveredModels = [
          ...(json.models?.map((m) => m.name || m.model || '').filter(Boolean) || []),
          ...(json.data?.map((d) => d.id || '').filter(Boolean) || []),
        ];
        if (input.modelId && !discoveredModels.includes(input.modelId)) {
          return {
            ok: false,
            runtime: input.runtime,
            endpoint: base,
            latencyMs,
            discoveredModels,
            message: `Connected cleanly, but requested model '${input.modelId}' was not listed.`,
          };
        }
        return {
          ok: true,
          runtime: input.runtime,
          endpoint: base,
          latencyMs,
          discoveredModels,
          message: `Connected successfully (${discoveredModels.length} model(s) discovered).`,
        };
      } catch (err) {
        return {
          ok: false,
          runtime: input.runtime,
          endpoint: base,
          latencyMs: Date.now() - start,
          discoveredModels: [],
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const rt = this.runtimes[input.runtime];
    if (!rt || !rt.isConfigured()) {
      return {
        ok: false,
        runtime: input.runtime,
        endpoint: 'unconfigured',
        latencyMs: Date.now() - start,
        discoveredModels: [],
        message: `Runtime '${input.runtime}' has no configured endpoint URL.`,
      };
    }

    const health = await rt.healthCheck();
    const discoveredModels = rt.discoverModels ? await rt.discoverModels() : [];
    return {
      ok: health.status === 'healthy',
      runtime: input.runtime,
      endpoint: health.endpoint,
      latencyMs: health.latencyMs,
      discoveredModels,
      message: health.message,
    };
  }

  async syncDiscoveredModels(): Promise<{
    scannedRuntimes: RuntimeKind[];
    registered: ModelRecord[];
    alreadyPresent: string[];
  }> {
    const db = await getDb();
    const existing = await db.listModels();
    const existingIds = new Set(existing.map((m) => m.id));
    const scannedRuntimes: RuntimeKind[] = [];
    const registered: ModelRecord[] = [];
    const alreadyPresent: string[] = [];

    for (const rt of Object.values(this.runtimes)) {
      if (!rt.isConfigured() || !rt.discoverModels) continue;
      scannedRuntimes.push(rt.kind);
      const ids = await rt.discoverModels().catch(() => []);
      for (const id of ids) {
        if (!id || id === 'neo-embedded-core-v1') continue;
        if (existingIds.has(id)) {
          alreadyPresent.push(id);
          await db.updateModel(id, {
            download_status: 'ready',
            health_status: 'healthy',
            last_validated_at: new Date().toISOString(),
          });
          continue;
        }
        const created = await db.upsertModel({
          id,
          name: id,
          version: 'discovered',
          runtime: rt.kind,
          architecture: rt.kind === 'custom-llm' ? 'openai-compatible' : rt.kind,
          source_repo: `runtime://${rt.kind}/${id}`,
          license: 'Self-Hosted',
          weight_location: rt.kind === 'embedded' ? 'in-process' : `runtime://${rt.kind}/${id}`,
          checksum_sha256: null,
          download_status: 'ready',
          quantization: 'runtime-managed',
          context_length: 32768,
          vram_gb: 0,
          ram_gb: 0,
          modalities: ['text', 'code'],
          roles: ['primary', 'reasoning'],
          capabilities: { toolCalling: true, reasoning: 0.85, coding: 0.85, multilingual: 0.85, persian: 0.8 },
          benchmark_results: {},
          deployment_status: 'standby',
          health_status: 'healthy',
          performance_metrics: {},
          last_validated_at: new Date().toISOString(),
        });
        existingIds.add(id);
        registered.push(created);
      }
    }

    return { scannedRuntimes, registered, alreadyPresent };
  }

  async deleteModel(modelId: string): Promise<boolean> {
    const db = await getDb();
    const model = await db.getModelById(modelId);
    if (!model || model.deployment_status === 'active') return false;
    const deleted = await db.deleteModel(modelId);
    if (!deleted) return false;

    if (model.weight_location) {
      const root = path.resolve(process.cwd(), env.modelsDir);
      const candidate = path.resolve(model.weight_location);
      const relative = path.relative(root, candidate);
      const insideRoot = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      if (insideRoot && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        fs.unlinkSync(candidate);
      }
    }
    return true;
  }

  async activateModel(modelId: string, role: ModelRole = 'primary'): Promise<ModelDeployment> {
    const db = await getDb();
    const target = await db.getModelById(modelId);
    if (!target) throw new Error(`Model '${modelId}' does not exist in Model Registry.`);
    const readiness = await this.verifyModelReady(modelId);
    if (!readiness.ready) throw new Error(`Model '${modelId}' failed runtime verification: ${readiness.message}`);

    const allModels = await db.listModels();
    let previousModelId: string | undefined;
    for (const m of allModels) {
      if (m.id !== target.id && m.deployment_status === 'active' && m.roles.includes(role)) {
        previousModelId = m.id;
        await db.updateModel(m.id, { deployment_status: 'standby' });
      }
    }

    const mergedRoles = Array.from(new Set([...target.roles, role]));
    await db.updateModel(target.id, {
      deployment_status: 'active',
      roles: mergedRoles,
      last_validated_at: new Date().toISOString(),
    });
    if (previousModelId) {
      await db.setAdminConfig(`previous_active_model:${role}`, previousModelId);
    }

    return {
      modelId: target.id,
      role,
      runtime: target.runtime,
      endpoint: target.weight_location || 'in-process',
      status: 'active',
      previousModelId,
      activatedAt: new Date().toISOString(),
    };
  }

  async rollbackModel(role: ModelRole = 'primary'): Promise<ModelDeployment | null> {
    const db = await getDb();
    const prevId = await db.getAdminConfig(`previous_active_model:${role}`);
    const fallbackId = prevId || 'neo-embedded-core-v1';
    const target = await db.getModelById(fallbackId);
    if (!target) return null;
    const readiness = await this.verifyModelReady(target.id);
    if (!readiness.ready) return null;

    const allModels = await db.listModels();
    for (const m of allModels) {
      if (m.id !== target.id && m.deployment_status === 'active' && m.roles.includes(role)) {
        await db.updateModel(m.id, { deployment_status: 'rolled_back' });
      }
    }
    await db.updateModel(target.id, { deployment_status: 'active', last_validated_at: new Date().toISOString() });
    return {
      modelId: target.id,
      role,
      runtime: target.runtime,
      endpoint: target.weight_location || 'in-process',
      status: 'active',
      activatedAt: new Date().toISOString(),
    };
  }

  async getHealth(): Promise<ModelHealth[]> {
    const checks = await Promise.all(
      Object.values(this.runtimes)
        .filter((rt) => rt.kind === 'embedded' || rt.isConfigured())
        .map((rt) => rt.healthCheck())
    );
    return checks;
  }
}

export class NeoInferenceEngine implements InferenceEngine {
  private runtimes = createRuntimes();
  private healthCache = new Map<RuntimeKind, { healthy: boolean; checkedAt: number }>();

  getCircuitBreakerStatuses(): CircuitBreakerStatus[] {
    return circuitBreakers.snapshot();
  }

  private async isRuntimeHealthyCached(kind: RuntimeKind): Promise<boolean> {
    const rt = this.runtimes[kind];
    if (!rt || !rt.isConfigured()) return false;
    if (kind === 'embedded') return true;
    if (!circuitBreakers.canExecute(kind)) return false;
    const cached = this.healthCache.get(kind);
    const now = Date.now();
    if (cached && now - cached.checkedAt < 15_000) {
      return cached.healthy;
    }
    const status = await rt.healthCheck().catch(() => null);
    const healthy = status?.status === 'healthy';
    this.healthCache.set(kind, { healthy, checkedAt: now });
    return healthy;
  }

  private isRuntimeAllowedByPrivacy(kind: RuntimeKind, req: InferenceRequest): boolean {
    if (req.routingHint?.privacyMode !== 'local_only') return true;
    if (kind !== 'custom-llm') return true;
    return isLoopbackOrPrivateHost(env.customInferenceUrl);
  }

  private scoreModelCandidate(m: ModelRecord, req: InferenceRequest, targetRole: ModelRole): number {
    let score = 0;
    if (m.deployment_status === 'active') score += 40;
    if (m.download_status === 'ready') score += 20;
    if (m.roles.includes(targetRole)) score += 30;
    if (m.runtime !== 'embedded') score += 15;

    if (req.language === 'fa' || req.language === 'ar') {
      score += (m.capabilities?.persian ?? 0.5) * 20;
    }
    if (targetRole === 'coding' || req.taskType?.includes('code') || req.taskType?.includes('engineer')) {
      score += (m.capabilities?.coding ?? 0.5) * 20;
    }
    if (targetRole === 'reasoning' || targetRole === 'deep' || req.routingHint?.complexity === 'complex') {
      score += (m.capabilities?.reasoning ?? 0.5) * 20;
    }
    if ((req.tools && req.tools.length > 0) || req.routingHint?.requireToolCalling) {
      if (m.capabilities?.toolCalling) score += 18;
      else score -= 35;
    }
    if (req.routingHint?.preferSpeed || req.routingHint?.complexity === 'simple' || targetRole === 'fast' || targetRole === 'lightweight') {
      const lat = Number(m.performance_metrics?.avgLatencyMs || 0);
      if (lat > 0) score += Math.max(0, 15 - lat / 250);
      if (m.ram_gb <= 8) score += 10;
    }
    if (req.routingHint?.maxCostUsd !== undefined) {
      const est = estimateInferenceCostUsd(m, estimateTokensRough(req.prompt), req.maxTokens || 512);
      if (est > req.routingHint.maxCostUsd) score -= 50;
    }
    return score;
  }

  private async selectExecutionChain(
    req: InferenceRequest
  ): Promise<{ chain: Array<{ runtime: RuntimeKind; modelId: string }>; modelsById: Map<string, ModelRecord> }> {
    const chain: Array<{ runtime: RuntimeKind; modelId: string }> = [];
    const seen = new Set<string>();
    const pushUnique = (runtime: RuntimeKind, modelId: string, force = false) => {
      if (!force && runtime !== 'embedded') {
        if (!circuitBreakers.canExecute(runtime)) return;
        if (!this.isRuntimeAllowedByPrivacy(runtime, req)) return;
      }
      const k = `${runtime}:${modelId}`;
      if (seen.has(k)) return;
      seen.add(k);
      chain.push({ runtime, modelId });
    };

    const db = await getDb();
    const models = await db.listModels();
    const modelsById = new Map(models.map((m) => [m.id, m]));

    if (req.strictTarget) {
      if (!req.preferredRuntime || !req.preferredModelId) throw new Error('Strict inference requires both preferredRuntime and preferredModelId.');
      const target = modelsById.get(req.preferredModelId);
      if (!target) throw new Error('Strict inference target is not registered.');
      if (target.runtime !== req.preferredRuntime) throw new Error('Strict inference runtime does not match the registered model runtime.');
      if (!this.runtimes[req.preferredRuntime]?.isConfigured()) throw new Error('Strict inference runtime is not configured.');
      pushUnique(req.preferredRuntime, req.preferredModelId, true);
      return { chain, modelsById };
    }

    const aliasNormalized = req.preferredModelId?.trim().toLowerCase();
    const aliasRole = aliasNormalized ? ROLE_ALIAS_MAP[aliasNormalized] : undefined;
    const effectiveRole: ModelRole = aliasRole || req.role || 'primary';
    const explicitModelId = aliasRole ? undefined : req.preferredModelId;

    if (req.preferredRuntime && this.runtimes[req.preferredRuntime]?.isConfigured()) {
      pushUnique(req.preferredRuntime, explicitModelId || env.primaryModel);
    }

    const activeOrReady = models
      .filter(
        (m) =>
          (m.deployment_status === 'active' || (aliasRole && m.download_status === 'ready')) &&
          m.download_status === 'ready' &&
          (m.roles.includes(effectiveRole) || m.roles.includes('primary'))
      )
      .sort((a, b) => this.scoreModelCandidate(b, req, effectiveRole) - this.scoreModelCandidate(a, req, effectiveRole));

    // 1. Prefer explicitly activated / role-scored non-embedded self-hosted models when configured
    for (const m of activeOrReady) {
      if (m.runtime !== 'embedded' && this.runtimes[m.runtime]?.isConfigured()) {
        pushUnique(m.runtime, m.id);
      }
    }

    // 2. Try explicitly requested model ID against registered or healthy local/private LLM runtimes
    if (explicitModelId && explicitModelId !== 'neo-embedded-core-v1' && explicitModelId !== 'neo-ai-v1') {
      const registered = modelsById.get(explicitModelId);
      if (registered && registered.runtime !== 'embedded' && this.runtimes[registered.runtime]?.isConfigured()) {
        pushUnique(registered.runtime, registered.id);
      } else {
        for (const rtKind of ['custom-llm', 'vllm', 'tensorrt-llm', 'transformers', 'ollama'] as const) {
          if (await this.isRuntimeHealthyCached(rtKind)) {
            pushUnique(rtKind, explicitModelId);
          }
        }
      }
    }

    // 3. Respect explicit NEO_RUNTIME_DEFAULT or auto-prefer healthy configured local LLM runtimes
    const preferredPrimaryModel =
      env.primaryModel && env.primaryModel !== 'neo-embedded-core-v1' ? env.primaryModel : 'qwen2.5:3b-instruct';

    if (env.runtimeDefault !== 'auto' && env.runtimeDefault !== 'embedded' && this.runtimes[env.runtimeDefault]?.isConfigured()) {
      pushUnique(env.runtimeDefault, preferredPrimaryModel);
    } else if (env.runtimeDefault === 'auto') {
      for (const rtKind of ['custom-llm', 'vllm', 'tensorrt-llm', 'transformers', 'ollama'] as const) {
        if (await this.isRuntimeHealthyCached(rtKind)) {
          pushUnique(rtKind, preferredPrimaryModel);
        }
      }
    }

    pushUnique('embedded', 'neo-embedded-core-v1', true);
    return { chain, modelsById };
  }

  private async updateModelMetricsBestEffort(
    model: ModelRecord | undefined,
    res: InferenceResponse
  ): Promise<void> {
    if (!model) return;
    try {
      const db = await getDb();
      const prevCalls = Number(model.performance_metrics?.calls || 0);
      const prevLat = Number(model.performance_metrics?.avgLatencyMs || res.latencyMs);
      const prevTps = Number(model.performance_metrics?.tokensPerSec || res.tokensPerSec);
      const nextCalls = prevCalls + 1;
      const alpha = prevCalls === 0 ? 1 : 0.25;
      await db.updateModel(model.id, {
        performance_metrics: {
          ...model.performance_metrics,
          calls: nextCalls,
          avgLatencyMs: Math.round(prevLat * (1 - alpha) + res.latencyMs * alpha),
          tokensPerSec: Math.round(prevTps * (1 - alpha) + res.tokensPerSec * alpha),
        },
      });
    } catch {
      // Never fail inference on telemetry metric rollup
    }
  }

  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    const { chain, modelsById } = await this.selectExecutionChain(req);
    const db = await getDb();
    const errors: string[] = [];

    for (const candidate of chain) {
      if (req.signal?.aborted) {
        throw new DOMException('Inference aborted by caller', 'AbortError');
      }
      const rt = this.runtimes[candidate.runtime];
      const candidateModel = modelsById.get(candidate.modelId);
      const trimmed = trimPromptToContextWindow(
        req.systemInstruction,
        req.prompt,
        candidateModel?.context_length || 32768,
        req.maxTokens || 1024
      );
      const effectiveReq: InferenceRequest = trimmed.trimmed
        ? { ...req, systemInstruction: trimmed.systemInstruction, prompt: trimmed.prompt }
        : req;

      const start = Date.now();
      try {
        const res = await withRetryAndBackoff(
          () => rt.generate(effectiveReq, candidate.modelId),
          {
            maxRetries: req.strictTarget ? 0 : 2,
            baseDelayMs: 120,
            maxDelayMs: 2500,
            signal: req.signal,
          }
        );
        if (res.modelId !== candidate.modelId) {
          throw new Error(`Runtime returned model '${res.modelId}' instead of requested target '${candidate.modelId}'.`);
        }

        const estimatedCostUsd = estimateInferenceCostUsd(candidateModel, res.promptTokens, res.completionTokens);
        res.estimatedCostUsd = estimatedCostUsd;
        circuitBreakers.recordSuccess(candidate.runtime);
        await this.updateModelMetricsBestEffort(candidateModel, res);

        await db.recordTelemetry({
          tenant_id: req.tenantId || 'global',
          provider: `neo-runtime:${res.runtime}`,
          model: res.modelId,
          task_type: req.taskType || req.role || 'general',
          prompt_tokens: res.promptTokens,
          completion_tokens: res.completionTokens,
          estimated_cost_usd: estimatedCostUsd,
          latency_ms: res.latencyMs,
          success: true,
          error_message: null,
        });
        return res;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${candidate.runtime}/${candidate.modelId}: ${msg}`);
        circuitBreakers.recordFailure(candidate.runtime, msg);
        await db.recordTelemetry({
          tenant_id: req.tenantId || 'global',
          provider: `neo-runtime:${candidate.runtime}`,
          model: candidate.modelId,
          task_type: req.taskType || 'general',
          prompt_tokens: estimateTokensRough(effectiveReq.prompt),
          completion_tokens: 0,
          estimated_cost_usd: 0,
          latency_ms: Date.now() - start,
          success: false,
          error_message: msg,
        });
      }
    }

    throw new Error(`All configured Neo local runtimes failed: ${errors.join(' | ')}`);
  }

  async inferJson<T>(req: InferenceRequest): Promise<{ data: T; response: InferenceResponse }> {
    const response = await this.infer({ ...req, responseFormat: 'json' });
    const cleaned = response.text
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const data = JSON.parse(cleaned) as T;
    return { data, response };
  }

  async *inferStream(req: InferenceRequest): InferenceStream {
    const { chain, modelsById } = await this.selectExecutionChain(req);
    const db = await getDb();

    for (const candidate of chain) {
      if (req.signal?.aborted) {
        throw new DOMException('Inference stream aborted by caller', 'AbortError');
      }
      const rt = this.runtimes[candidate.runtime];
      const candidateModel = modelsById.get(candidate.modelId);
      const trimmed = trimPromptToContextWindow(
        req.systemInstruction,
        req.prompt,
        candidateModel?.context_length || 32768,
        req.maxTokens || 1024
      );
      const effectiveReq: InferenceRequest = trimmed.trimmed
        ? { ...req, systemInstruction: trimmed.systemInstruction, prompt: trimmed.prompt }
        : req;

      try {
        for await (const chunk of rt.stream(effectiveReq, candidate.modelId)) {
          if (req.signal?.aborted) {
            throw new DOMException('Inference stream aborted by caller', 'AbortError');
          }
          if (chunk.type === 'done') {
            const estimatedCostUsd = estimateInferenceCostUsd(
              candidateModel,
              chunk.response.promptTokens,
              chunk.response.completionTokens
            );
            chunk.response.estimatedCostUsd = estimatedCostUsd;
            circuitBreakers.recordSuccess(candidate.runtime);
            await this.updateModelMetricsBestEffort(candidateModel, chunk.response);
            await db.recordTelemetry({
              tenant_id: req.tenantId || 'global',
              provider: `neo-runtime:${chunk.response.runtime}`,
              model: chunk.response.modelId,
              task_type: req.taskType || 'chat_stream',
              prompt_tokens: chunk.response.promptTokens,
              completion_tokens: chunk.response.completionTokens,
              estimated_cost_usd: estimatedCostUsd,
              latency_ms: chunk.response.latencyMs,
              success: true,
              error_message: null,
            });
          }
          yield chunk;
        }
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        circuitBreakers.recordFailure(candidate.runtime, msg);
      }
    }

    throw new Error('No healthy Neo inference runtime available for streaming.');
  }

  async listRuntimeHealth(): Promise<ModelHealth[]> {
    return Object.values(this.runtimes)
      .filter((rt) => rt.kind === 'embedded' || rt.isConfigured())
      .reduce<Promise<ModelHealth[]>>(async (accP, rt) => {
        const acc = await accP;
        acc.push(await rt.healthCheck());
        return acc;
      }, Promise.resolve([]));
  }
}

export const modelRegistry = new NeoModelRegistry();
export const neoInferenceEngine = new NeoInferenceEngine();
