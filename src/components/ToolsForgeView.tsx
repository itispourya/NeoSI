import { useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AdminOverviewPayload } from '../types/neo';

interface ToolsForgeViewProps {
  data: AdminOverviewPayload;
  onRefresh: () => Promise<void>;
}

export function ToolsForgeView({ data, onRefresh }: ToolsForgeViewProps) {
  const [selectedToolId, setSelectedToolId] = useState(data.tools[0]?.id || 'math_evaluate');
  const [toolInputJson, setToolInputJson] = useState('{"expression":"(145 * 12) + 260"}');
  const [toolResult, setToolResult] = useState<string | null>(null);

  const [requirement, setRequirement] = useState('Compute VAT invoice total from amount, taxRate, and discountPct');
  const [forgeOut, setForgeOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const executeTool = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setToolResult(null);
    try {
      const parsedInput = JSON.parse(toolInputJson);
      const res = await apiFetch<Record<string, unknown>>(`/api/v1/tools/${selectedToolId}/execute`, {
        method: 'POST',
        body: JSON.stringify({ input: parsedInput }),
      });
      setToolResult(JSON.stringify(res, null, 2));
      await onRefresh();
    } catch (err) {
      setToolResult(err instanceof Error ? err.message : 'Tool execution error');
    } finally {
      setBusy(false);
    }
  };

  const createForgedApi = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setForgeOut(null);
    try {
      const res = await apiFetch<{ endpoint: Record<string, unknown> }>('/api/v1/forge/create', {
        method: 'POST',
        body: JSON.stringify({ requirement }),
      });
      setForgeOut(JSON.stringify(res.endpoint, null, 2));
      await onRefresh();
    } catch (err) {
      setForgeOut(err instanceof Error ? err.message : 'Forge creation failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleEndpoint = async (slug: string, enabled: boolean) => {
    await apiFetch(`/api/v1/forge/${slug}/toggle`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    await onRefresh();
  };

  return (
    <div className="space-y-6">
      {/* Tool Runner */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <h2 className="font-display text-sm font-semibold text-slate-100">Standardized Tool Runner & MCP ({data.tools.length} Tools)</h2>
          <form onSubmit={executeTool} className="space-y-3">
            <select
              value={selectedToolId}
              onChange={(e) => setSelectedToolId(e.target.value)}
              className="w-full px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs font-mono text-slate-100"
            >
              {data.tools.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} ({t.risk_level} risk · {t.execution_env})
                </option>
              ))}
            </select>
            <textarea
              value={toolInputJson}
              onChange={(e) => setToolInputJson(e.target.value)}
              rows={3}
              className="w-full p-3 bg-[#0B0F17] border border-slate-700 rounded text-xs font-mono text-slate-100"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap"
            >
              Execute Zod-Validated Tool
            </button>
          </form>
          {toolResult && (
            <pre className="p-3 bg-[#0B0F17] border border-slate-800 rounded text-[11px] font-mono text-slate-200 whitespace-pre-wrap max-h-56 overflow-y-auto">
              {toolResult}
            </pre>
          )}
        </div>

        {/* Dynamic API Forge */}
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-slate-100">Autonomous API Forge (OpenAPI 3.1)</h2>
            <a
              href="/api/v1/openapi.json"
              target="_blank"
              rel="noreferrer"
              className="text-xs font-mono text-blue-400 hover:text-blue-300 whitespace-nowrap"
            >
              /api/v1/openapi.json
            </a>
          </div>
          <form onSubmit={createForgedApi} className="space-y-3">
            <textarea
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              rows={3}
              placeholder="Describe the endpoint logic, inputs, and validation..."
              required
              className="w-full p-3 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap"
            >
              Synthesize, Sandbox-Test & Register API
            </button>
          </form>
          {forgeOut && (
            <pre className="p-3 bg-[#0B0F17] border border-slate-800 rounded text-[11px] font-mono text-slate-200 whitespace-pre-wrap max-h-48 overflow-y-auto">
              {forgeOut}
            </pre>
          )}
        </div>
      </div>

      {/* Forged Endpoints List */}
      <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
        <h3 className="font-display text-sm font-semibold text-slate-100">Registered Custom APIs ({data.dynamicApis.length})</h3>
        {data.dynamicApis.length === 0 ? (
          <div className="text-xs text-slate-400">No dynamic endpoints forged yet.</div>
        ) : (
          <div className="divide-y divide-slate-800/80">
            {data.dynamicApis.map((api) => (
              <div key={api.id} className="py-3 flex items-center justify-between gap-4 text-xs">
                <div className="min-w-0">
                  <div className="font-mono text-slate-100">
                    {api.method} /api/v1/custom/{api.slug}
                  </div>
                  <div className="text-slate-400 truncate">
                    {api.description} · tests {api.test_report.passed}/{api.test_report.total} · calls {api.call_count}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void toggleEndpoint(api.slug, !api.enabled)}
                  className={`px-3 py-1 rounded border text-[11px] whitespace-nowrap shrink-0 ${
                    api.enabled ? 'border-emerald-500/40 text-emerald-300' : 'border-slate-700 text-slate-400'
                  }`}
                >
                  {api.enabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
