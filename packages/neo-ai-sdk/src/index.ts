export interface NeoClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export type SupportedLanguage = 'en' | 'fa' | 'ar' | 'nl';
export type MemoryType = 'working' | 'episodic' | 'semantic' | 'procedural' | 'personal' | 'organizational' | 'temporal';

export class NeoApiError extends Error {
  public readonly status: number;
  public readonly details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'NeoApiError';
    this.status = status;
    this.details = details;
  }
}

export class NeoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: NeoClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { signal?: AbortSignal } = {}
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const signal = init.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal;

      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            ...(init.headers || {}),
          },
        });
        clearTimeout(timer);
        if (res.status >= 500 && attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        const data = (await res.json().catch(() => ({}))) as T & { error?: string };
        if (!res.ok) {
          throw new NeoApiError(data?.error || `HTTP ${res.status}`, res.status, data);
        }
        return data;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (err instanceof NeoApiError && err.status < 500) throw err;
        if (attempt >= this.maxRetries) throw err;
      }
    }
    throw lastErr;
  }

  // System
  health() {
    return this.request<Record<string, unknown>>('/api/v1/health');
  }
  ready() {
    return this.request<{ ready: boolean; status: string; storage: string; sandboxMode: string }>('/api/v1/ready');
  }
  status() {
    return this.request<Record<string, unknown>>('/api/v1/status');
  }
  capabilities() {
    return this.request<Record<string, unknown>>('/api/v1/capabilities');
  }
  metrics() {
    return this.request<Record<string, unknown>>('/api/v1/metrics');
  }

  // Chat & Cognitive Engine
  chat(input: { message: string; conversationId?: string; language?: SupportedLanguage; workspaceContext?: Record<string, unknown> }) {
    return this.request<{ conversationId: string; reply: string; language?: string; runtime: string; model: string; confidence: number }>('/api/v1/chat', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  chatCompletions(input: {
    model?: string;
    messages: Array<{
      role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
      content?: string | Array<{ type: string; text?: string }> | null;
      name?: string;
      tool_call_id?: string;
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    }>;
    temperature?: number;
    max_tokens?: number;
    tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
    tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
    response_format?:
      | { type: 'text' }
      | { type: 'json_object' }
      | { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };
    language?: SupportedLanguage;
    workspaceContext?: Record<string, unknown>;
  }) {
    return this.request<{
      id: string;
      object: 'chat.completion';
      created: number;
      model: string;
      choices: Array<{
        index: number;
        message: {
          role: 'assistant';
          content: string | null;
          tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
        };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    }>('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...input, stream: false }),
    });
  }

  async *chatStream(
    input: { message: string; conversationId?: string; language?: SupportedLanguage; mode?: 'neural' | 'sovereign-local'; workspaceContext?: Record<string, unknown> },
    signal?: AbortSignal
  ): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}/api/v1/chat/stream`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok || !res.body) {
      throw new NeoApiError(`Stream error HTTP ${res.status}`, res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const blk of blocks) {
        const evtMatch = blk.match(/^event:\s*(.+)$/m);
        const dataMatch = blk.match(/^data:\s*(.+)$/m);
        if (evtMatch && dataMatch) {
          yield { event: evtMatch[1].trim(), data: JSON.parse(dataMatch[1]) as Record<string, unknown> };
        }
      }
    }
  }

  reason(input: { query: string; language?: SupportedLanguage; autonomy?: 'low' | 'balanced' | 'high'; context?: Record<string, unknown> }) {
    return this.request<Record<string, unknown>>('/api/v1/reason', { method: 'POST', body: JSON.stringify(input) });
  }

  plan(goal: string, autonomy: 'low' | 'balanced' | 'high' = 'balanced') {
    return this.request<Record<string, unknown>>('/api/v1/plan', { method: 'POST', body: JSON.stringify({ goal, autonomy }) });
  }

  verify(input: { goal: string; response: string; evidence?: string[] }) {
    return this.request<Record<string, unknown>>('/api/v1/verify', { method: 'POST', body: JSON.stringify(input) });
  }

  // Autonomous Durable Tasks & Objectives
  createTask(input: { goal: string; autonomy?: 'low' | 'balanced' | 'high'; priority?: string }) {
    return this.request<{ task: Record<string, unknown> }>('/api/v1/tasks', { method: 'POST', body: JSON.stringify(input) });
  }
  listTasks(limit = 30) {
    return this.request<{ tasks: unknown[] }>(`/api/v1/tasks?limit=${limit}`);
  }
  getTask(taskId: string) {
    return this.request<{ task: Record<string, unknown>; steps: unknown[]; events: unknown[] }>(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
  }
  cancelTask(taskId: string) {
    return this.request<{ task: Record<string, unknown> }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: '{}' });
  }
  resumeTask(taskId: string) {
    return this.request<{ task: Record<string, unknown> }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/resume`, { method: 'POST', body: '{}' });
  }

  objectives = {
    list: (limit = 30) => this.request<{ objectives: unknown[] }>(`/api/v1/objectives?limit=${limit}`),
    create: (input: { title: string; description: string; category?: string; priority_score?: number; success_criteria?: string }) =>
      this.request<{ objective: Record<string, unknown> }>('/api/v1/objectives', { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, patch: { status?: 'active' | 'paused' | 'achieved' | 'abandoned' | 'blocked'; progress_pct?: number; priority_score?: number }) =>
      this.request<{ objective: Record<string, unknown> }>(`/api/v1/objectives/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  };

  // Memory & Knowledge Graph
  memory = {
    store: (input: { memoryType: MemoryType; topic: string; title: string; content: string; sourceUrl?: string }) =>
      this.request<{ memory: Record<string, unknown> }>('/api/v1/memory', { method: 'POST', body: JSON.stringify(input) }),
    search: (q: string, type?: MemoryType, limit = 10) => {
      const params = new URLSearchParams({ q, limit: String(limit) });
      if (type) params.set('type', type);
      return this.request<{ query: string; matches: unknown[] }>(`/api/v1/memory/search?${params.toString()}`);
    },
    update: (id: string, patch: { title?: string; content?: string; topic?: string; importance_score?: number; confidence_score?: number }) =>
      this.request<{ memory: Record<string, unknown> }>(`/api/v1/memory/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    delete: (id: string, hard = false) =>
      this.request<{ deleted: boolean; hard: boolean }>(`/api/v1/memory/${encodeURIComponent(id)}${hard ? '?hard=true' : ''}`, { method: 'DELETE' }),
    consolidate: () => this.request<Record<string, unknown>>('/api/v1/memory/consolidate', { method: 'POST', body: '{}' }),
    reindex: (opts?: { force?: boolean; limit?: number }) =>
      this.request<{ totalScanned: number; reindexed: number; targetModel: string; targetDim: number }>('/api/v1/memory/reindex', {
        method: 'POST',
        body: JSON.stringify(opts || {}),
      }),
    graphEntities: (q?: string) =>
      this.request<{ entities: unknown[]; relationships: unknown[] }>(`/api/v1/graph/entities${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  };

  // Research & Skills
  research(query: string, urls?: string[]) {
    return this.request<{ report: Record<string, unknown> }>('/api/v1/research', { method: 'POST', body: JSON.stringify({ query, urls }) });
  }

  // Tools & Models
  tools = {
    list: () => this.request<{ tools: unknown[] }>('/api/v1/tools'),
    execute: (toolId: string, input: Record<string, unknown>) =>
      this.request<{ ok: boolean; output?: Record<string, unknown>; durationMs: number }>(
        `/api/v1/tools/${encodeURIComponent(toolId)}/execute`,
        { method: 'POST', body: JSON.stringify({ input }) }
      ),
  };

  models = {
    list: () => this.request<{ models: unknown[]; compatibility: unknown[]; evaluations: unknown[]; hardware: unknown }>('/api/v1/models'),
    register: (input: { id: string; name: string; runtime: 'embedded' | 'ollama' | 'vllm' | 'tensorrt-llm' | 'transformers'; architecture: string; source_repo: string; license: string }) =>
      this.request<{ model: Record<string, unknown> }>('/api/v1/models', { method: 'POST', body: JSON.stringify(input) }),
    evaluate: (modelId = 'neo-embedded-core-v1') =>
      this.request<{ evaluation: Record<string, unknown> }>('/api/v1/models/evaluate', { method: 'POST', body: JSON.stringify({ modelId }) }),
    install: (modelId: string) =>
      this.request<{ ok: boolean; message: string }>('/api/v1/models/install', { method: 'POST', body: JSON.stringify({ modelId }) }),
    verify: (modelId: string) =>
      this.request<{ ready: boolean; message: string }>(`/api/v1/models/${encodeURIComponent(modelId)}/verify`, { method: 'POST', body: '{}' }),
    activate: (modelId: string, role = 'primary') =>
      this.request<{ deployment: Record<string, unknown> }>('/api/v1/models/activate', { method: 'POST', body: JSON.stringify({ modelId, role }) }),
    rollback: (role = 'primary') =>
      this.request<{ deployment: Record<string, unknown> }>('/api/v1/models/rollback', { method: 'POST', body: JSON.stringify({ role }) }),
    delete: (modelId: string) =>
      this.request<Record<string, unknown>>(`/api/v1/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' }),
  };

  // Business, Engineering & API Forge
  analyzeBusiness(payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('/api/v1/business/analyze', { method: 'POST', body: JSON.stringify(payload) });
  }
  runEngineerTask(input: { task: string; stack?: string; existingCode?: string }) {
    return this.request<Record<string, unknown>>('/api/v1/engineer/task', { method: 'POST', body: JSON.stringify(input) });
  }
  forgeApi(requirement: string) {
    return this.request<{ endpoint: Record<string, unknown> }>('/api/v1/forge/create', { method: 'POST', body: JSON.stringify({ requirement }) });
  }
}

export default NeoClient;
