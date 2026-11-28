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
    messages: Array<{ role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'; content: string | Array<{ type: string; text?: string }> }>;
    temperature?: number;
    max_tokens?: number;
    language?: NeosLanguage;
    workspaceContext?: Record<string, unknown>;
  }) {
    return this.request<{
      id: string;
      object: 'chat.completion';
      created: number;
      model: string;
      choices: Array<{ index: number; message: { role: 'assistant'; content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    }>('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...input, stream: false }),
    });
  }

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
