// Admin session token held strictly in JS memory (never localStorage/sessionStorage)
let inMemoryAdminToken: string | null = null;

export function setAdminToken(token: string | null) {
  inMemoryAdminToken = token;
}

export function getAdminToken(): string | null {
  return inMemoryAdminToken;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Neo-Console': '1',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (inMemoryAdminToken && !headers.Authorization) {
    headers.Authorization = `Bearer ${inMemoryAdminToken}`;
  }

  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const errObj = data as { error?: string; authRequired?: boolean };
    const err = new Error(errObj.error || `Request failed (${res.status})`) as Error & { authRequired?: boolean };
    err.authRequired = errObj.authRequired;
    throw err;
  }
  return data as T;
}

export async function streamChat(
  body: {
    message: string;
    language?: string;
    mode?: 'neural' | 'sovereign-local';
    workspaceContext?: Record<string, unknown>;
  },
  handlers: {
    onMeta?: (meta: { language: string; ragMatches: number; piiRedacted: boolean; engine?: string }) => void;
    onDelta: (chunk: string) => void;
    onDone?: (meta: Record<string, unknown>) => void;
    onError: (msg: string) => void;
  }
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Neo-Console': '1',
  };
  if (inMemoryAdminToken) {
    headers.Authorization = `Bearer ${inMemoryAdminToken}`;
  }

  const res = await fetch('/api/v1/chat/stream', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text();
    throw new Error(errText || `Stream failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      const eventLine = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
      const dataLine = frame.match(/^data:\s*(.+)$/m)?.[1]?.trim();
      if (!eventLine || !dataLine) continue;
      const parsed = JSON.parse(dataLine);
      if (eventLine === 'meta') handlers.onMeta?.(parsed);
      else if (eventLine === 'delta') handlers.onDelta(String(parsed.text || ''));
      else if (eventLine === 'done') handlers.onDone?.(parsed);
      else if (eventLine === 'error') handlers.onError(String(parsed.error || 'Stream error'));
    }
  }
}
