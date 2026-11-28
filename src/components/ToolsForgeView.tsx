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
  const [openApiSpec, setOpenApiSpec] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [neosMod, setNeosMod] = useState('finance');
  const [neosCapId, setNeosCapId] = useState('finance.invoice.post');
  const [neosTitle, setNeosTitle] = useState('Post Supplier Invoice');
  const [neosRisk, setNeosRisk] = useState<'low' | 'medium' | 'high'>('high');
  const [neosPayloadJson, setNeosPayloadJson] = useState('{"invoiceId":"INV-1042","amount":1250}');
  const [neosStatusMsg, setNeosStatusMsg] = useState<string | null>(null);

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
    setBusy(true);
    try {
      await apiFetch(`/api/v1/forge/${slug}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      await onRefresh();
    } catch (err) {
      setForgeOut(err instanceof Error ? err.message : 'Failed to toggle endpoint');
    } finally {
      setBusy(false);
    }
  };

  const inspectOpenApi = async () => {
    if (openApiSpec) {
      setOpenApiSpec(null);
      return;
    }
    setBusy(true);
    try {
      const spec = await apiFetch<Record<string, unknown>>('/api/v1/openapi.json');
      setOpenApiSpec(JSON.stringify(spec, null, 2));
    } catch (err) {
      setForgeOut(err instanceof Error ? err.message : 'Failed to load OpenAPI spec');
    } finally {
      setBusy(false);
    }
  };

  const syncNeosCapability = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNeosStatusMsg(null);
    try {
      await apiFetch('/api/v1/neos/capabilities/sync', {
        method: 'POST',
        body: JSON.stringify({
          capabilities: [
            {
              module_name: neosMod.trim(),
              capability_id: neosCapId.trim(),
              title: neosTitle.trim(),
              description: `Registered via Control Plane for ${neosMod.trim()}`,
              risk_level: neosRisk,
              requires_confirmation: neosRisk === 'high',
              required_scopes: ['write'],
            },
          ],
        }),
      });
      setNeosStatusMsg(`Synced Neos capability '${neosCapId.trim()}'.`);
      await onRefresh();
    } catch (err) {
      setNeosStatusMsg(err instanceof Error ? err.message : 'Capability sync failed');
    } finally {
      setBusy(false);
    }
  };

  const proposeNeosAction = async (capabilityId: string) => {
    setBusy(true);
    setNeosStatusMsg(null);
    try {
      const payload = JSON.parse(neosPayloadJson);
      const res = await apiFetch<{ status: string; approval?: { id: string } }>('/api/v1/neos/actions/execute', {
        method: 'POST',
        body: JSON.stringify({ capabilityId, payload }),
      });
      setNeosStatusMsg(
        res.status === 'confirmation_required'
          ? `Action queued for human confirmation (approval ${res.approval?.id.slice(0, 8)}).`
          : `Executed capability '${capabilityId}' cleanly.`
      );
      await onRefresh();
    } catch (err) {
      setNeosStatusMsg(err instanceof Error ? err.message : 'Neos action failed');
    } finally {
      setBusy(false);
    }
  };

  const decideNeosApproval = async (id: string, decision: 'confirm' | 'reject') => {
    setBusy(true);
    setNeosStatusMsg(null);
    try {
      await apiFetch(`/api/v1/neos/approvals/${id}/${decision}`, { method: 'POST', body: '{}' });
      setNeosStatusMsg(`Approval ${id.slice(0, 8)} ${decision === 'confirm' ? 'confirmed' : 'rejected'}.`);
      await onRefresh();
    } catch (err) {
      setNeosStatusMsg(err instanceof Error ? err.message : `Failed to ${decision} approval`);
    } finally {
      setBusy(false);
    }
  };

  const neosCapabilities = data.neosCapabilities ?? [];
  const neosApprovals = data.neosApprovals ?? [];

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
            <button
              type="button"
              onClick={() => void inspectOpenApi()}
              disabled={busy}
              className="text-xs font-mono text-blue-400 hover:text-blue-300 whitespace-nowrap"
            >
              {openApiSpec ? 'Hide OpenAPI 3.1' : 'Inspect OpenAPI 3.1'}
            </button>
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
          {openApiSpec && (
            <pre className="p-3 bg-[#0B0F17] border border-slate-800 rounded text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-64 overflow-y-auto">
              {openApiSpec}
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

      {/* Deep Neos Integration & Human Confirmation Queue */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <h3 className="font-display text-sm font-semibold text-slate-100">
            Deep Neos Capability Contract ({neosCapabilities.length})
          </h3>
          {neosStatusMsg && (
            <div className="p-2.5 rounded bg-blue-500/10 border border-blue-500/30 text-xs text-blue-200">{neosStatusMsg}</div>
          )}
          <form onSubmit={syncNeosCapability} className="grid grid-cols-2 gap-2 text-xs">
            <input
              type="text"
              value={neosMod}
              onChange={(e) => setNeosMod(e.target.value)}
              placeholder="Module (finance)"
              aria-label="Neos module name"
              required
              className="px-2.5 py-1.5 bg-[#0B0F17] border border-slate-700 rounded text-slate-100"
            />
            <select
              aria-label="Capability risk level"
              value={neosRisk}
              onChange={(e) => setNeosRisk(e.target.value as 'low' | 'medium' | 'high')}
              className="px-2.5 py-1.5 bg-[#0B0F17] border border-slate-700 rounded text-slate-200"
            >
              <option value="low">low risk</option>
              <option value="medium">medium risk</option>
              <option value="high">high risk (gated)</option>
            </select>
            <input
              type="text"
              value={neosCapId}
              onChange={(e) => setNeosCapId(e.target.value)}
              placeholder="Capability ID (finance.invoice.post)"
              aria-label="Capability ID"
              required
              className="px-2.5 py-1.5 bg-[#0B0F17] border border-slate-700 rounded font-mono text-slate-100"
            />
            <input
              type="text"
              value={neosTitle}
              onChange={(e) => setNeosTitle(e.target.value)}
              placeholder="Title"
              aria-label="Capability title"
              required
              className="px-2.5 py-1.5 bg-[#0B0F17] border border-slate-700 rounded text-slate-100"
            />
            <input
              type="text"
              value={neosPayloadJson}
              onChange={(e) => setNeosPayloadJson(e.target.value)}
              placeholder='Test payload JSON e.g. {"amount":500}'
              aria-label="Action test payload JSON"
              className="col-span-2 px-2.5 py-1.5 bg-[#0B0F17] border border-slate-700 rounded font-mono text-slate-100"
            />
            <button
              type="submit"
              disabled={busy}
              className="col-span-2 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium whitespace-nowrap"
            >
              Sync Neos Capability
            </button>
          </form>
          <div className="divide-y divide-slate-800/80 max-h-44 overflow-y-auto">
            {neosCapabilities.map((c) => (
              <div key={c.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <div className="font-mono text-slate-200 truncate">{c.capability_id}</div>
                  <div className="font-mono text-[11px] text-slate-400">
                    {c.module_name} · {c.risk_level} · {c.requires_confirmation ? 'confirmation gated' : 'auto'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void proposeNeosAction(c.capability_id)}
                  disabled={busy}
                  className="px-2.5 py-1 rounded border border-slate-700 hover:bg-slate-800 text-[11px] text-slate-200 whitespace-nowrap shrink-0"
                >
                  Propose Action
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <h3 className="font-display text-sm font-semibold text-slate-100">
            Human Confirmation Approval Queue ({neosApprovals.length})
          </h3>
          {neosApprovals.length === 0 ? (
            <div className="text-xs text-slate-400">No high-risk Neos actions waiting in the confirmation queue.</div>
          ) : (
            <div className="divide-y divide-slate-800/80 max-h-72 overflow-y-auto">
              {neosApprovals.map((app) => (
                <div key={app.id} className="py-2.5 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-100 truncate">{app.action_summary}</span>
                    <span className={`font-mono text-[11px] shrink-0 ${app.status === 'pending' ? 'text-amber-400' : app.status === 'rejected' ? 'text-rose-400' : 'text-emerald-400'}`}>
                      {app.status}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-slate-400 truncate">
                    {app.capability_id} · actor {app.actor}
                  </div>
                  {app.status === 'pending' && (
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => void decideNeosApproval(app.id, 'confirm')}
                        disabled={busy}
                        className="px-2.5 py-1 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 text-[11px] whitespace-nowrap"
                      >
                        Confirm Action
                      </button>
                      <button
                        type="button"
                        onClick={() => void decideNeosApproval(app.id, 'reject')}
                        disabled={busy}
                        className="px-2.5 py-1 rounded border border-rose-500/40 text-rose-300 hover:bg-rose-500/10 text-[11px] whitespace-nowrap"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
