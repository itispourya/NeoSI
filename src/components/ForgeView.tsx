import { useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AdminOverviewPayload, DynamicApiInfo } from '../types/neo';

interface ForgeViewProps {
  data: AdminOverviewPayload;
  onRefresh: () => Promise<void>;
}

export function ForgeView({ data, onRefresh }: ForgeViewProps) {
  const [requirement, setRequirement] = useState('');
  const [forging, setForging] = useState(false);
  const [forgeError, setForgeError] = useState<string | null>(null);

  const [selectedSlug, setSelectedSlug] = useState<string>(data.dynamicApis[0]?.slug || '');
  const activeApi: DynamicApiInfo | undefined =
    data.dynamicApis.find((a) => a.slug === selectedSlug) || data.dynamicApis[0];

  const [testPayload, setTestPayload] = useState<string>(
    JSON.stringify({ invoiceId: 'INV-902', amount: 18500, currency: 'USD', daysOverdue: 52, priorDefaults: 1 }, null, 2)
  );
  const [invokeOutput, setInvokeOutput] = useState<string | null>(null);
  const [invoking, setInvoking] = useState(false);

  const [openApiJson, setOpenApiJson] = useState<string | null>(null);

  const handleSelectApi = (api: DynamicApiInfo) => {
    setSelectedSlug(api.slug);
    setInvokeOutput(null);
    const props = (api.input_schema?.properties || {}) as Record<string, { type?: string }>;
    const sample: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (v.type === 'number' || v.type === 'integer') sample[k] = 42;
      else if (v.type === 'boolean') sample[k] = true;
      else if (v.type === 'array') sample[k] = [];
      else sample[k] = `sample-${k}`;
    }
    setTestPayload(JSON.stringify(sample, null, 2));
  };

  const handleForge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirement.trim()) return;
    setForging(true);
    setForgeError(null);
    try {
      const res = await apiFetch<{ endpoint: DynamicApiInfo }>('/api/v1/forge/create', {
        method: 'POST',
        body: JSON.stringify({ requirement: requirement.trim() }),
      });
      setRequirement('');
      await onRefresh();
      handleSelectApi(res.endpoint);
    } catch (err) {
      setForgeError(err instanceof Error ? err.message : 'Forge synthesis failed');
    } finally {
      setForging(false);
    }
  };

  const handleInvoke = async () => {
    if (!activeApi) return;
    setInvoking(true);
    setInvokeOutput(null);
    try {
      const parsed = JSON.parse(testPayload);
      const res = await apiFetch<unknown>(`/api/v1/custom/${activeApi.slug}`, {
        method: 'POST',
        body: JSON.stringify(parsed),
      });
      setInvokeOutput(JSON.stringify(res, null, 2));
      await onRefresh();
    } catch (err) {
      setInvokeOutput(JSON.stringify({ error: err instanceof Error ? err.message : 'Execution error' }, null, 2));
    } finally {
      setInvoking(false);
    }
  };

  const handleToggle = async (api: DynamicApiInfo) => {
    await apiFetch(`/api/v1/forge/${api.slug}/toggle`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !api.enabled }),
    });
    await onRefresh();
  };

  const loadOpenApi = async () => {
    if (openApiJson) {
      setOpenApiJson(null);
      return;
    }
    const spec = await apiFetch<unknown>('/api/v1/openapi.json');
    setOpenApiJson(JSON.stringify(spec, null, 2));
  };

  return (
    <div className="space-y-8">
      {/* Forge Generator */}
      <section className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="font-display text-sm font-semibold text-slate-100">Autonomous API Forge</h2>
            <p className="mt-1 text-xs text-slate-400">
              Describe a capability in plain language. Neo synthesizes the handler, Zod validation schema, OpenAPI 3.1 spec, runs VM unit tests, and hot-registers /api/v1/custom/&lt;slug&gt;.
            </p>
          </div>
          <button
            type="button"
            onClick={loadOpenApi}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-slate-800 text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
          >
            {openApiJson ? 'Hide OpenAPI Spec' : 'View OpenAPI 3.1 Spec'}
          </button>
        </div>

        <form onSubmit={handleForge} className="flex flex-col sm:flex-row gap-3">
          <label className="sr-only" htmlFor="forge-requirement-input">Endpoint requirement</label>
          <input
            id="forge-requirement-input"
            type="text"
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="e.g., Create an endpoint that calculates EU VAT reverse charge and net margin from invoice line items"
            className="flex-1 px-3 py-2 text-sm bg-[#0B0F17] border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={forging || requirement.trim().length < 8}
            className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {forging ? 'Synthesizing & Testing...' : 'Forge Endpoint'}
          </button>
        </form>
        {forgeError && <p className="text-xs text-rose-400">{forgeError}</p>}

        {openApiJson && (
          <pre className="p-3 rounded-md bg-[#0B0F17] border border-slate-800 text-xs font-mono text-slate-300 overflow-x-auto max-h-72">
            {openApiJson}
          </pre>
        )}
      </section>

      {/* Endpoint Registry + Interactive Tester */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-3">
          <h3 className="font-display text-sm font-semibold text-slate-100">
            Registered Custom APIs ({data.dynamicApis.length})
          </h3>
          <div className="divide-y divide-slate-800/70">
            {data.dynamicApis.map((api) => (
              <button
                key={api.id}
                type="button"
                onClick={() => handleSelectApi(api)}
                className={`w-full text-left py-3 px-2.5 rounded-md transition-colors ${
                  activeApi?.slug === api.slug ? 'bg-blue-600/15' : 'hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-100 truncate">{api.name}</span>
                  <span className={`text-[11px] font-mono ${api.enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {api.enabled ? 'active' : 'off'}
                  </span>
                </div>
                <p className="mt-1 text-[11px] font-mono text-slate-400 truncate">
                  {api.method} /api/v1/custom/{api.slug} · {api.call_count} calls
                </p>
              </button>
            ))}
          </div>
        </div>

        {activeApi && (
          <div className="lg:col-span-2 bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-4">
              <div className="space-y-1">
                <h3 className="font-display text-base font-semibold text-slate-100">{activeApi.name}</h3>
                <p className="text-xs font-mono text-blue-400">
                  {activeApi.method} /api/v1/custom/{activeApi.slug}
                </p>
                <p className="text-xs text-slate-400">{activeApi.description}</p>
              </div>
              <button
                type="button"
                onClick={() => handleToggle(activeApi)}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-slate-800 text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
              >
                {activeApi.enabled ? 'Disable Route' : 'Enable Route'}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-400" htmlFor="custom-api-payload">
                  JSON Request Body
                </label>
                <textarea
                  id="custom-api-payload"
                  rows={7}
                  value={testPayload}
                  onChange={(e) => setTestPayload(e.target.value)}
                  className="w-full p-3 rounded-md bg-[#0B0F17] border border-slate-700 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  onClick={handleInvoke}
                  disabled={invoking || !activeApi.enabled}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                >
                  {invoking ? 'Executing in Sandbox...' : 'Invoke Live Endpoint'}
                </button>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-400">Live Execution Response</p>
                <pre className="h-[176px] p-3 rounded-md bg-[#0B0F17] border border-slate-800 text-xs font-mono text-emerald-300 overflow-auto whitespace-pre-wrap break-words">
                  {invokeOutput || '// Click "Invoke Live Endpoint" to test live validation & sandbox execution.'}
                </pre>
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-400">
                Sandbox Verification ({activeApi.test_report.passed}/{activeApi.test_report.total} passed · {activeApi.test_report.durationMs}ms)
              </p>
              <pre className="p-3 rounded-md bg-[#0B0F17] border border-slate-800 text-xs font-mono text-slate-300 overflow-x-auto max-h-48">
                {activeApi.handler_code}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
