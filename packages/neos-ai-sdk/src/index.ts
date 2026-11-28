export type NeosLanguage = 'en' | 'fa' | 'ar' | 'nl';

export interface NeoAiClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class NeoAiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: NeoAiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.headers || {}),
      },
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || `Neo AI request failed with HTTP ${res.status}`);
    }
    return data;
  }

  async *chatStream(params: {
    message: string;
    language?: NeosLanguage;
    workspaceContext?: Record<string, unknown>;
  }): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}/api/v1/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Stream failed with HTTP ${res.status}`);
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
      for (const block of blocks) {
        const eventMatch = block.match(/^event:\s*(.+)$/m);
        const dataMatch = block.match(/^data:\s*(.+)$/m);
        if (eventMatch && dataMatch) {
          yield {
            event: eventMatch[1].trim(),
            data: JSON.parse(dataMatch[1]) as Record<string, unknown>,
          };
        }
      }
    }
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
    language?: NeosLanguage;
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

  neos = {
    contract: () => this.request<Record<string, unknown>>('/api/v1/neos/contract'),
    listCapabilities: () => this.request<{ capabilities: unknown[] }>('/api/v1/neos/capabilities'),
    syncCapabilities: (capabilities: Array<Record<string, unknown>>) =>
      this.request<{ synced: number; capabilities: unknown[] }>('/api/v1/neos/capabilities/sync', {
        method: 'POST',
        body: JSON.stringify({ capabilities }),
      }),
    pushContext: (input: { moduleName: string; summary: string; data: Record<string, unknown>; sessionId?: string }) =>
      this.request<{ stored: boolean; memoryId: string }>('/api/v1/neos/context', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    executeAction: (input: { capabilityName?: string; moduleName?: string; actionName?: string; payload: Record<string, unknown> }) =>
      this.request<Record<string, unknown>>('/api/v1/neos/actions/execute', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    listApprovals: (status?: 'pending' | 'approved' | 'rejected' | 'expired') =>
      this.request<{ approvals: unknown[] }>(`/api/v1/neos/approvals${status ? `?status=${status}` : ''}`),
    confirmApproval: (approvalId: string, note?: string) =>
      this.request<Record<string, unknown>>(`/api/v1/neos/approvals/${encodeURIComponent(approvalId)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      }),
    rejectApproval: (approvalId: string, note?: string) =>
      this.request<Record<string, unknown>>(`/api/v1/neos/approvals/${encodeURIComponent(approvalId)}/reject`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      }),
  };

  analyzeBusiness(payload: Record<string, unknown>) {
    return this.request('/api/v1/business/analyze', { method: 'POST', body: JSON.stringify(payload) });
  }

  runEngineeringTask(params: { task: string; stack?: string; existingCode?: string }) {
    return this.request('/api/v1/engineer/task', { method: 'POST', body: JSON.stringify(params) });
  }

  queryKnowledge(query: string, limit = 6) {
    return this.request('/api/v1/knowledge/query', { method: 'POST', body: JSON.stringify({ query, limit }) });
  }

  learnTopic(topic: string) {
    return this.request('/api/v1/knowledge/learn', { method: 'POST', body: JSON.stringify({ topic }) });
  }

  forgeEndpoint(requirement: string) {
    return this.request('/api/v1/forge/create', { method: 'POST', body: JSON.stringify({ requirement }) });
  }

  callCustomEndpoint<T = unknown>(slug: string, payload: Record<string, unknown>) {
    return this.request<T>(`/api/v1/custom/${slug}`, { method: 'POST', body: JSON.stringify(payload) });
  }
}
