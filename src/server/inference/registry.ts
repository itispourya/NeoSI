import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import type { ModelRecord } from '../db/schema.ts';
import { safeExternalFetch } from '../security/crypto.ts';
import { inspectHardware } from './hardware.ts';
import { createRuntimes } from './runtimes.ts';
import type {
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

const ALLOWED_OPEN_LICENSES = /^(apache-2\.0|mit|bsd-3-clause|bsd-2-clause|mpl-2\.0|llama|qwen|gemma|openrail)/i;

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
      performance_metrics: {},
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

    // Install via Ollama /api/pull when runtime is ollama
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

    // Download a checksum-pinned artifact. Downloading a file is not proof that a runtime can load it.
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

  async deleteModel(modelId: string): Promise<boolean> {
    const db = await getDb();
    const model = await db.getModelById(modelId);
    if (!model || model.deployment_status === 'active') return false;
    const deleted = await db.deleteModel(modelId);
    if (!deleted) return false;

    // Delete only artifacts stored inside Neo's configured model directory.
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

    // Demote current active model for this role so rollback remains available
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

  private async selectExecutionChain(req: InferenceRequest): Promise<Array<{ runtime: RuntimeKind; modelId: string }>> {
    const chain: Array<{ runtime: RuntimeKind; modelId: string }> = [];
    const seen = new Set<string>();
    const pushUnique = (runtime: RuntimeKind, modelId: string) => {
      const k = `${runtime}:${modelId}`;
      if (seen.has(k)) return;
      seen.add(k);
      chain.push({ runtime, modelId });
    };

    if (req.preferredRuntime && this.runtimes[req.preferredRuntime]?.isConfigured()) {
      pushUnique(req.preferredRuntime, req.preferredModelId || env.primaryModel);
    }

    const db = await getDb();
    const models = await db.listModels();
    const role = req.role || 'primary';
    const activeForRole = models.filter(
      (m) => m.deployment_status === 'active' && m.download_status === 'ready' && (m.roles.includes(role) || m.roles.includes('primary'))
    );

    // Prefer non-embedded active self-hosted models when healthy/configured, then embedded fallback
    for (const m of activeForRole) {
      if (m.runtime !== 'embedded' && this.runtimes[m.runtime]?.isConfigured()) {
        pushUnique(m.runtime, m.id);
      }
    }

    if (env.runtimeDefault !== 'auto' && env.runtimeDefault !== 'embedded' && this.runtimes[env.runtimeDefault]?.isConfigured()) {
      pushUnique(env.runtimeDefault, env.primaryModel);
    }

    if (req.strictTarget) {
      if (chain.length === 0) {
        throw new Error('Strict inference target requires a registered model and a configured runtime.');
      }
      return chain.slice(0, 1);
    }

    pushUnique('embedded', 'neo-embedded-core-v1');
    return chain;
  }

  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    const chain = await this.selectExecutionChain(req);
    const db = await getDb();
    const errors: string[] = [];

    for (const candidate of chain) {
      const rt = this.runtimes[candidate.runtime];
      const start = Date.now();
      try {
        const res = await rt.generate(req, candidate.modelId);
        if (res.modelId !== candidate.modelId) {
          throw new Error(`Runtime returned model '${res.modelId}' instead of requested target '${candidate.modelId}'.`);
        }
        await db.recordTelemetry({
          tenant_id: req.tenantId || 'global',
          provider: `neo-runtime:${res.runtime}`,
          model: res.modelId,
          task_type: req.taskType || req.role || 'general',
          prompt_tokens: res.promptTokens,
          completion_tokens: res.completionTokens,
          estimated_cost_usd: 0, // Self-hosted / sovereign compute
          latency_ms: res.latencyMs,
          success: true,
          error_message: null,
        });
        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${candidate.runtime}/${candidate.modelId}: ${msg}`);
        await db.recordTelemetry({
          tenant_id: req.tenantId || 'global',
          provider: `neo-runtime:${candidate.runtime}`,
          model: candidate.modelId,
          task_type: req.taskType || 'general',
          prompt_tokens: Math.ceil(req.prompt.length / 4),
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
    const chain = await this.selectExecutionChain(req);
    const db = await getDb();

    for (const candidate of chain) {
      const rt = this.runtimes[candidate.runtime];
      try {
        for await (const chunk of rt.stream(req, candidate.modelId)) {
          if (chunk.type === 'done') {
            await db.recordTelemetry({
              tenant_id: req.tenantId || 'global',
              provider: `neo-runtime:${chunk.response.runtime}`,
              model: chunk.response.modelId,
              task_type: req.taskType || 'chat_stream',
              prompt_tokens: chunk.response.promptTokens,
              completion_tokens: chunk.response.completionTokens,
              estimated_cost_usd: 0,
              latency_ms: chunk.response.latencyMs,
              success: true,
              error_message: null,
            });
          }
          yield chunk;
        }
        return;
      } catch {
        // Try next runtime in sovereign chain
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
