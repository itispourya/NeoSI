import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { computeDeterministicBusinessMetrics, type BusinessPayload } from '../business/analyzer.ts';
import { getDb } from '../db/adapter.ts';
import type { MemoryType, ToolRecord } from '../db/schema.ts';
import { indexWorkspaceCodebase } from '../engineer/repoIndex.ts';
import { embeddingEngine } from '../inference/embeddings.ts';
import { safeArithmeticEval } from '../inference/runtimes.ts';
import { knowledgeGraph } from '../knowledge/graph.ts';
import { retrieveRagContext, storeMemory } from '../knowledge/memory.ts';
import { runAutonomousResearch } from '../knowledge/research.ts';
import { executeHandlerInSandbox } from '../sandbox/runner.ts';

export interface ToolContext {
  tenantId: string;
  actor: string;
  taskId?: string | null;
  scopes: string[];
}

export interface NeoToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  name: string;
  version: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high';
  requiredScopes: string[];
  timeoutMs: number;
  executionEnv: string;
  inputJsonSchema: Record<string, unknown>;
  outputJsonSchema: Record<string, unknown>;
  inputSchema: I;
  execute: (input: z.infer<I>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

const WORKSPACE_ROOT = path.resolve(process.cwd());
const FORBIDDEN_WORKSPACE_NAMES = /(^|\/)(\.env(\..*)?|data\/.*\.sqlite.*|node_modules|\.git)(\/|$)/i;

function resolveConfinedWorkspacePath(relPath: string): string {
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('..') || FORBIDDEN_WORKSPACE_NAMES.test(cleaned)) {
    throw new Error(`Access denied: path '${relPath}' is outside safe workspace read boundaries.`);
  }
  const abs = path.resolve(WORKSPACE_ROOT, cleaned);
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error(`Path traversal blocked for '${relPath}'.`);
  }
  const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
  if (real !== WORKSPACE_ROOT && !real.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error(`Symlink escape blocked for '${relPath}'.`);
  }
  return abs;
}

function hasRequiredScopes(granted: string[], required: string[]): boolean {
  if (granted.includes('admin')) return true;
  return required.every((r) => granted.includes(r));
}

export class NeoToolRegistry {
  private tools = new Map<string, NeoToolDefinition<z.ZodTypeAny>>();

  constructor() {
    this.registerDefaults();
  }

  register<I extends z.ZodTypeAny>(tool: NeoToolDefinition<I>): void {
    this.tools.set(tool.id, tool as NeoToolDefinition<z.ZodTypeAny>);
  }

  get(id: string): NeoToolDefinition<z.ZodTypeAny> | undefined {
    return this.tools.get(id);
  }

  list(): NeoToolDefinition<z.ZodTypeAny>[] {
    return Array.from(this.tools.values());
  }

  async syncBuiltInToolsToDb(): Promise<void> {
    const db = await getDb();
    for (const t of this.tools.values()) {
      await db.upsertTool({
        id: t.id,
        name: t.name,
        version: t.version,
        description: t.description,
        input_schema: t.inputJsonSchema,
        output_schema: t.outputJsonSchema,
        risk_level: t.riskLevel,
        required_scopes: t.requiredScopes,
        timeout_ms: t.timeoutMs,
        execution_env: t.executionEnv,
        enabled: true,
      });
    }
  }

  async executeTool(
    toolId: string,
    rawInput: unknown,
    ctx: ToolContext
  ): Promise<{ ok: boolean; output?: Record<string, unknown>; error?: string; durationMs: number }> {
    const tool = this.tools.get(toolId);
    const start = Date.now();
    const db = await getDb();
    const inputObj = (rawInput && typeof rawInput === 'object' ? rawInput : { value: rawInput }) as Record<string, unknown>;

    if (!tool) {
      await db.recordToolExecution({
        tenant_id: ctx.tenantId,
        task_id: ctx.taskId ?? null,
        tool_id: toolId,
        actor: ctx.actor,
        input: inputObj,
        output: null,
        ok: false,
        error: `Tool '${toolId}' not found`,
        duration_ms: Date.now() - start,
      });
      return { ok: false, error: `Tool '${toolId}' not found`, durationMs: Date.now() - start };
    }

    const dbMeta = await db.getToolById(toolId);
    if (dbMeta && !dbMeta.enabled) {
      const durationMs = Date.now() - start;
      await db.recordToolExecution({
        tenant_id: ctx.tenantId,
        task_id: ctx.taskId ?? null,
        tool_id: toolId,
        actor: ctx.actor,
        input: inputObj,
        output: null,
        ok: false,
        error: `Tool '${toolId}' is disabled`,
        duration_ms: durationMs,
      });
      return { ok: false, error: `Tool '${toolId}' is disabled`, durationMs };
    }

    if (!hasRequiredScopes(ctx.scopes, tool.requiredScopes)) {
      const durationMs = Date.now() - start;
      const error = `Permission denied for tool '${toolId}'. Requires scopes: ${tool.requiredScopes.join(', ')}`;
      await db.recordToolExecution({
        tenant_id: ctx.tenantId,
        task_id: ctx.taskId ?? null,
        tool_id: toolId,
        actor: ctx.actor,
        input: inputObj,
        output: null,
        ok: false,
        error,
        duration_ms: durationMs,
      });
      return { ok: false, error, durationMs };
    }

    const parsed = tool.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const durationMs = Date.now() - start;
      const error = `Invalid tool input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
      await db.recordToolExecution({
        tenant_id: ctx.tenantId,
        task_id: ctx.taskId ?? null,
        tool_id: toolId,
        actor: ctx.actor,
        input: inputObj,
        output: null,
        ok: false,
        error,
        duration_ms: durationMs,
      });
      return { ok: false, error, durationMs };
    }

    try {
      const result = await Promise.race([
        tool.execute(parsed.data, ctx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool '${toolId}' timed out after ${tool.timeoutMs}ms`)), tool.timeoutMs)
        ),
      ]);
      const durationMs = Math.max(1, Date.now() - start);
      await db.recordToolExecution({
        tenant_id: ctx.tenantId,
        task_id: ctx.taskId ?? null,
        tool_id: toolId,
        actor: ctx.actor,
        input: inputObj,
        output: result,
        ok: true,
        error: null,
        duration_ms: durationMs,
      });
      return { ok: true, output: result, durationMs };
    } catch (err) {
      const durationMs = Math.max(1, Date.now() - start);
      const error = err instanceof Error ? err.message : String(err);
      await db.recordToolExecution({
        tenant_id: ctx.tenantId,
        task_id: ctx.taskId ?? null,
        tool_id: toolId,
        actor: ctx.actor,
        input: inputObj,
        output: null,
        ok: false,
        error,
        duration_ms: durationMs,
      });
      return { ok: false, error, durationMs };
    }
  }

  /**
   * Model Context Protocol (MCP) standard tool listing adapter
   */
  async mcpToolsList(): Promise<{ tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }> {
    const db = await getDb();
    const dbTools = await db.listTools();
    const enabledMap = new Map(dbTools.map((t) => [t.id, t]));
    const list = this.list()
      .filter((t) => enabledMap.get(t.id)?.enabled !== false)
      .map((t) => ({
        name: t.id,
        description: t.description,
        inputSchema: t.inputJsonSchema,
      }));
    return { tools: list };
  }

  async mcpCallTool(name: string, args: unknown, ctx: ToolContext) {
    const res = await this.executeTool(name, args, ctx);
    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: res.error || 'Tool error' }],
      };
    }
    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(res.output, null, 2) }],
      structuredContent: res.output,
    };
  }

  toPublicRecords(dbRows?: ToolRecord[]): Array<Omit<ToolRecord, 'updated_at'> & { updated_at: string }> {
    const map = new Map((dbRows || []).map((r) => [r.id, r]));
    return this.list().map((t) => {
      const row = map.get(t.id);
      return {
        id: t.id,
        name: t.name,
        version: t.version,
        description: t.description,
        input_schema: t.inputJsonSchema,
        output_schema: t.outputJsonSchema,
        risk_level: t.riskLevel,
        required_scopes: t.requiredScopes,
        timeout_ms: t.timeoutMs,
        execution_env: t.executionEnv,
        enabled: row ? row.enabled : true,
        updated_at: row?.updated_at || new Date().toISOString(),
      };
    });
  }

  private registerDefaults(): void {
    this.register({
      id: 'math_evaluate',
      name: 'Deterministic Arithmetic Evaluator',
      version: '1.0.0',
      description: 'Safely evaluates arithmetic expressions using recursive-descent parsing (no eval).',
      riskLevel: 'low',
      requiredScopes: ['read'],
      timeoutMs: 1000,
      executionEnv: 'in-process',
      inputJsonSchema: {
        type: 'object',
        required: ['expression'],
        properties: { expression: { type: 'string', description: 'Arithmetic expression e.g. (145 * 12) + 260' } },
      },
      outputJsonSchema: { type: 'object', properties: { expression: { type: 'string' }, value: { type: 'number' } } },
      inputSchema: z.object({ expression: z.string().min(1).max(120) }),
      execute: async (input) => {
        const val = safeArithmeticEval(input.expression);
        if (val === null) throw new Error(`Invalid arithmetic expression: ${input.expression}`);
        return { expression: input.expression, value: val };
      },
    });

    this.register({
      id: 'workspace_list_files',
      name: 'Workspace Repository Indexer',
      version: '1.0.0',
      description: 'Lists source files and exported symbols inside the Neo repository.',
      riskLevel: 'low',
      requiredScopes: ['read'],
      timeoutMs: 3000,
      executionEnv: 'host-readonly',
      inputJsonSchema: {
        type: 'object',
        properties: { prefix: { type: 'string', description: 'Optional path prefix filter e.g. src/server/security' } },
      },
      outputJsonSchema: { type: 'object', properties: { totalFiles: { type: 'number' }, files: { type: 'array' } } },
      inputSchema: z.object({ prefix: z.string().max(120).optional() }),
      execute: async (input) => {
        const idx = indexWorkspaceCodebase();
        const filtered = input.prefix
          ? idx.files.filter((f) => f.file.startsWith(input.prefix!))
          : idx.files;
        return { totalFiles: filtered.length, files: filtered.slice(0, 60) };
      },
    });

    this.register({
      id: 'workspace_read_file',
      name: 'Workspace File Reader',
      version: '1.0.0',
      description: 'Reads a non-secret source file confined strictly inside the workspace root.',
      riskLevel: 'low',
      requiredScopes: ['read'],
      timeoutMs: 2500,
      executionEnv: 'host-readonly',
      inputJsonSchema: {
        type: 'object',
        required: ['filePath'],
        properties: {
          filePath: { type: 'string' },
          maxChars: { type: 'number' },
        },
      },
      outputJsonSchema: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } } },
      inputSchema: z.object({ filePath: z.string().min(1).max(240), maxChars: z.number().int().min(100).max(24000).default(6000) }),
      execute: async (input) => {
        const abs = resolveConfinedWorkspacePath(input.filePath);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          throw new Error(`File not found: ${input.filePath}`);
        }
        const raw = fs.readFileSync(abs, 'utf8');
        return {
          filePath: input.filePath,
          length: raw.length,
          truncated: raw.length > input.maxChars,
          content: raw.slice(0, input.maxChars),
        };
      },
    });

    this.register({
      id: 'workspace_search_code',
      name: 'Workspace Code Search',
      version: '1.0.0',
      description: 'Searches indexed source files in src/ for matching identifiers or patterns.',
      riskLevel: 'low',
      requiredScopes: ['read'],
      timeoutMs: 3500,
      executionEnv: 'host-readonly',
      inputJsonSchema: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
      },
      outputJsonSchema: { type: 'object', properties: { matches: { type: 'array' } } },
      inputSchema: z.object({ query: z.string().min(2).max(120), limit: z.number().int().min(1).max(50).default(15) }),
      execute: async (input) => {
        const idx = indexWorkspaceCodebase();
        const q = input.query.toLowerCase();
        const matches: Array<{ file: string; line: number; snippet: string }> = [];
        for (const f of idx.files) {
          if (matches.length >= input.limit) break;
          try {
            const abs = resolveConfinedWorkspacePath(f.file);
            const lines = fs.readFileSync(abs, 'utf8').split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(q)) {
                matches.push({ file: f.file, line: i + 1, snippet: lines[i].trim().slice(0, 160) });
                if (matches.length >= input.limit) break;
              }
            }
          } catch {
            // skip unreadable files
          }
        }
        return { query: input.query, count: matches.length, matches };
      },
    });

    this.register({
      id: 'sandbox_execute_js',
      name: 'Isolated Subprocess JS Runner',
      version: '2.0.0',
      description: 'Executes pure JavaScript handle(input) inside an isolated OS subprocess (or Docker container) with zero host secrets.',
      riskLevel: 'medium',
      requiredScopes: ['write'],
      timeoutMs: 5000,
      executionEnv: 'isolated-subprocess',
      inputJsonSchema: {
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string' }, input: { type: 'object' } },
      },
      outputJsonSchema: { type: 'object', properties: { ok: { type: 'boolean' }, output: {}, logs: { type: 'array' } } },
      inputSchema: z.object({ code: z.string().min(10).max(16000), input: z.unknown().optional() }),
      execute: async (input) => {
        const res = executeHandlerInSandbox(input.code, input.input ?? {}, 2000);
        if (!res.ok) throw new Error(res.error || 'Sandbox execution failed');
        return {
          ok: true,
          isolation: res.isolation,
          durationMs: res.durationMs,
          output: res.output,
          logs: res.logs,
        };
      },
    });

    this.register({
      id: 'memory_search',
      name: '7-Layer Hybrid Memory Search',
      version: '2.0.0',
      description: 'Searches semantic, episodic, procedural, working, personal, organizational, and temporal memories with RRF hybrid ranking.',
      riskLevel: 'low',
      requiredScopes: ['read'],
      timeoutMs: 3000,
      executionEnv: 'database',
      inputJsonSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          memoryType: { type: 'string' },
          limit: { type: 'number' },
        },
      },
      outputJsonSchema: { type: 'object', properties: { matches: { type: 'array' } } },
      inputSchema: z.object({
        query: z.string().min(1).max(600),
        memoryType: z.enum(['working', 'episodic', 'semantic', 'procedural', 'personal', 'organizational', 'temporal']).optional(),
        limit: z.number().int().min(1).max(20).default(5),
      }),
      execute: async (input, ctx) => {
        const db = await getDb();
        const emb = await embeddingEngine.embed(input.query);
        const matches = await db.searchMemories(emb.vector, {
          tenantId: ctx.tenantId,
          includeGlobal: true,
          memoryType: input.memoryType as MemoryType | undefined,
          queryText: input.query,
          limit: input.limit,
          minScore: 0.02,
        });
        return {
          count: matches.length,
          matches: matches.map((m) => ({
            id: m.id,
            memory_type: m.memory_type,
            topic: m.topic,
            title: m.title,
            content: m.content.slice(0, 400),
            hybridScore: m.hybridScore,
            reliability: m.reliability_score,
            source_url: m.source_url,
          })),
        };
      },
    });

    this.register({
      id: 'memory_store',
      name: 'Structured Memory Writer',
      version: '1.0.0',
      description: 'Persists a verified fact, procedural rule, or temporal observation into tenant-scoped long-term memory.',
      riskLevel: 'low',
      requiredScopes: ['write'],
      timeoutMs: 3000,
      executionEnv: 'database',
      inputJsonSchema: {
        type: 'object',
        required: ['memoryType', 'topic', 'title', 'content'],
        properties: {
          memoryType: { type: 'string' },
          topic: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
        },
      },
      outputJsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
      inputSchema: z.object({
        memoryType: z.enum(['working', 'episodic', 'semantic', 'procedural', 'personal', 'organizational', 'temporal']),
        topic: z.string().min(2).max(120),
        title: z.string().min(2).max(200),
        content: z.string().min(4).max(8000),
        sourceUrl: z.string().optional(),
      }),
      execute: async (input, ctx) => {
        const rec = await storeMemory({
          tenantId: ctx.tenantId,
          memoryType: input.memoryType,
          topic: input.topic,
          title: input.title,
          content: input.content,
          sourceUrl: input.sourceUrl ?? null,
        });
        return { id: rec.id, memoryType: rec.memory_type, version: rec.version };
      },
    });

    this.register({
      id: 'graph_query',
      name: 'Knowledge Graph Explorer',
      version: '1.0.0',
      description: 'Queries entities and traverses typed relationships in Neo Knowledge Graph.',
      riskLevel: 'low',
      requiredScopes: ['read'],
      timeoutMs: 3000,
      executionEnv: 'database',
      inputJsonSchema: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' }, depth: { type: 'number' } },
      },
      outputJsonSchema: { type: 'object', properties: { entities: { type: 'array' } } },
      inputSchema: z.object({ query: z.string().min(1).max(200), depth: z.number().int().min(1).max(3).default(1) }),
      execute: async (input, ctx) => {
        const entities = await knowledgeGraph.searchEntities(ctx.tenantId, input.query, 8);
        const subgraph = entities[0]
          ? await knowledgeGraph.traverse(ctx.tenantId, entities[0].id, input.depth)
          : { nodes: [], edges: [] };
        return { entities: entities.map((e) => ({ id: e.id, name: e.name, type: e.entity_type, score: e.score })), subgraph };
      },
    });

    this.register({
      id: 'web_research',
      name: 'Autonomous Web Research Pipeline',
      version: '2.0.0',
      description: 'Runs the SSRF-guarded 16-stage autonomous web discovery, extraction, contradiction detection, and citation pipeline.',
      riskLevel: 'medium',
      requiredScopes: ['write'],
      timeoutMs: 15000,
      executionEnv: 'network-ssrf-guarded',
      inputJsonSchema: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' }, urls: { type: 'array' } },
      },
      outputJsonSchema: { type: 'object', properties: { reportId: { type: 'string' }, confidence: { type: 'number' } } },
      inputSchema: z.object({ query: z.string().min(3).max(400), urls: z.array(z.string()).max(3).optional() }),
      execute: async (input, ctx) => {
        const report = await runAutonomousResearch({
          tenantId: ctx.tenantId,
          query: input.query,
          urls: input.urls,
        });
        if (report.status !== 'completed' || report.citations.length === 0) {
          throw new Error('Web research did not obtain any usable external citations; the report is recorded as failed.');
        }
        return {
          reportId: report.id,
          confidence: report.confidence,
          summary: report.summary,
          citationCount: report.citations.length,
          contradictionCount: report.contradictions.length,
          citations: report.citations,
        };
      },
    });

    this.register({
      id: 'business_audit',
      name: 'Deterministic Neos Business KPI Auditor',
      version: '1.0.0',
      description: 'Computes exact double-entry ledger balance, Z-score anomalies, cash runway, LTV:CAC, and inventory reorder risk.',
      riskLevel: 'low',
      requiredScopes: ['read'],
      timeoutMs: 3000,
      executionEnv: 'in-process',
      inputJsonSchema: {
        type: 'object',
        properties: { accounting: { type: 'object' }, crm: { type: 'object' }, inventory: { type: 'array' } },
      },
      outputJsonSchema: { type: 'object', properties: { accounting: { type: 'object' }, crm: { type: 'object' }, inventory: { type: 'object' } } },
      inputSchema: z.object({
        accounting: z.record(z.string(), z.unknown()).optional(),
        crm: z.record(z.string(), z.unknown()).optional(),
        inventory: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
      execute: async (input) => {
        const metrics = computeDeterministicBusinessMetrics(input as BusinessPayload);
        return metrics as unknown as Record<string, unknown>;
      },
    });

    this.register({
      id: 'skill_lookup',
      name: 'Skill Registry Lookup',
      version: '1.0.0',
      description: 'Retrieves relevant operational skills & procedural playbooks for the active query.',
      riskLevel: 'low',
      requiredScopes: ['read'],
      timeoutMs: 2000,
      executionEnv: 'database',
      inputJsonSchema: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' } },
      },
      outputJsonSchema: { type: 'object', properties: { skills: { type: 'array' } } },
      inputSchema: z.object({ query: z.string().min(2).max(200) }),
      execute: async (input, ctx) => {
        const rag = await retrieveRagContext(input.query, ctx.tenantId, 3);
        return {
          skills: rag.skills.map((s) => ({ id: s.id, slug: s.slug, title: s.title, domain: s.domain, version: s.version, excerpt: s.content.slice(0, 320) })),
        };
      },
    });
  }
}

export const toolRegistry = new NeoToolRegistry();
