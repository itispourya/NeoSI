import { useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AdminOverviewPayload, SelfUpgradeInfo } from '../types/neo';

interface UpgradesViewProps {
  data: AdminOverviewPayload;
  onRefresh: () => Promise<void>;
}

export function UpgradesView({ data, onRefresh }: UpgradesViewProps) {
  const [focusArea, setFocusArea] = useState('');
  const [diagnosing, setDiagnosing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [moduleOutput, setModuleOutput] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelfUpgradeInfo | null>(data.upgrades[0] || null);

  const handleDiagnose = async (e: React.FormEvent) => {
    e.preventDefault();
    setDiagnosing(true);
    setErrorMsg(null);
    try {
      const res = await apiFetch<{ proposal: SelfUpgradeInfo }>('/api/v1/upgrades/diagnose', {
        method: 'POST',
        body: JSON.stringify({ focusArea: focusArea.trim() || undefined }),
      });
      setFocusArea('');
      setSelected(res.proposal);
      await onRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Diagnostic failed');
    } finally {
      setDiagnosing(false);
    }
  };

  const handleApprove = async (id: string) => {
    setBusyId(id);
    setErrorMsg(null);
    try {
      const res = await apiFetch<{ proposal: SelfUpgradeInfo }>(`/api/v1/upgrades/${id}/approve`, { method: 'POST' });
      setSelected(res.proposal);
      await onRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleRollback = async (id: string) => {
    setBusyId(id);
    setErrorMsg(null);
    setModuleOutput(null);
    try {
      const res = await apiFetch<{ proposal: SelfUpgradeInfo }>(`/api/v1/upgrades/${id}/rollback`, { method: 'POST' });
      setSelected(res.proposal);
      await onRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Rollback failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleRunPromoted = async (id: string) => {
    setBusyId(id);
    setErrorMsg(null);
    try {
      const res = await apiFetch<unknown>(`/api/v1/modules/${id}/execute`, {
        method: 'POST',
        body: JSON.stringify({ input: { sample: true, source: 'neo-console' } }),
      });
      setModuleOutput(JSON.stringify(res, null, 2));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Module execution failed');
    } finally {
      setBusyId(null);
    }
  };

  const activeProposal = selected ? data.upgrades.find((u) => u.id === selected.id) || selected : data.upgrades[0] || null;

  return (
    <div className="space-y-8">
      <section className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
        <div>
          <h2 className="font-display text-sm font-semibold text-slate-100">Self-Diagnostic & Sandboxed Evolution</h2>
          <p className="mt-1 text-xs text-slate-400">
            Inspects telemetry & reflection failures, synthesizes an isolated branch module + unit tests, enforces security guardrails, and runs benchmark gates.
          </p>
        </div>
        <form onSubmit={handleDiagnose} className="flex flex-col sm:flex-row gap-3">
          <label className="sr-only" htmlFor="upgrade-focus-input">Diagnostic focus area</label>
          <input
            id="upgrade-focus-input"
            type="text"
            value={focusArea}
            onChange={(e) => setFocusArea(e.target.value)}
            placeholder="Optional focus area (e.g., ledger batch deduplication, prompt latency)..."
            className="flex-1 px-3 py-2 text-sm bg-[#0B0F17] border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={diagnosing}
            className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {diagnosing ? 'Running Sandbox Pipeline...' : 'Run Self-Diagnostic'}
          </button>
        </form>
        {errorMsg && <p className="text-xs text-rose-400">{errorMsg}</p>}
      </section>

      {data.upgrades.length === 0 ? (
        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-8 text-center space-y-2">
          <p className="text-sm font-medium text-slate-200">No Self-Upgrade Proposals Recorded Yet</p>
          <p className="text-xs text-slate-400">
            Click &ldquo;Run Self-Diagnostic&rdquo; above to scan telemetry and generate a verified sandboxed upgrade proposal.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Proposal List */}
          <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-3">
            <h3 className="font-display text-sm font-semibold text-slate-100">Proposals ({data.upgrades.length})</h3>
            <div className="divide-y divide-slate-800/70">
              {data.upgrades.map((u) => {
                const isSelected = activeProposal?.id === u.id;
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setSelected(u)}
                    className={`w-full text-left py-3 px-2.5 rounded-md transition-colors ${
                      isSelected ? 'bg-blue-600/15' : 'hover:bg-slate-800/40'
                    }`}
                  >
                    <p className="text-xs font-medium text-slate-100 line-clamp-1">{u.title}</p>
                    <div className="mt-1 flex items-center justify-between text-[11px] font-mono">
                      <span
                        className={
                          u.status === 'merged'
                            ? 'text-emerald-400'
                            : u.status === 'sandbox_passed'
                            ? 'text-blue-400'
                            : u.status === 'rejected' || u.status === 'rolled_back'
                            ? 'text-rose-400'
                            : 'text-amber-400'
                        }
                      >
                        {u.status}
                      </span>
                      <span className="text-slate-400 tabular-nums">
                        {u.test_results.passed}/{u.test_results.total} pass
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Selected Proposal Evidence & Diff */}
          {activeProposal && (
            <div className="lg:col-span-2 bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-4">
                <div className="space-y-1">
                  <h3 className="font-display text-base font-semibold text-slate-100">{activeProposal.title}</h3>
                  <p className="text-xs font-mono text-slate-400">
                    Branch: {activeProposal.branch_name} · Files: {activeProposal.target_files.join(', ')}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {activeProposal.status === 'sandbox_passed' && (
                    <button
                      type="button"
                      disabled={busyId === activeProposal.id}
                      onClick={() => handleApprove(activeProposal.id)}
                      className="px-3.5 py-2 text-xs font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      Approve & Merge
                    </button>
                  )}
                  {activeProposal.status === 'merged' && (
                    <button
                      type="button"
                      disabled={busyId === activeProposal.id}
                      onClick={() => handleRunPromoted(activeProposal.id)}
                      className="px-3.5 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      Run Promoted Module
                    </button>
                  )}
                  {(activeProposal.status === 'merged' || activeProposal.status === 'sandbox_passed') && (
                    <button
                      type="button"
                      disabled={busyId === activeProposal.id}
                      onClick={() => handleRollback(activeProposal.id)}
                      className="px-3.5 py-2 text-xs font-medium rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      Rollback
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-400">Diagnosis</p>
                <p className="text-xs text-slate-200 leading-relaxed">{activeProposal.diagnosis}</p>
              </div>

              {/* Before vs After Benchmarks */}
              <div className="grid grid-cols-3 gap-4 p-3 rounded-md bg-[#0B0F17] border border-slate-800 text-xs font-mono tabular-nums">
                <div>
                  <span className="text-slate-500 block">Accuracy</span>
                  <span className="text-slate-200">
                    {activeProposal.benchmark_before.accuracyScore}% →{' '}
                    <span className="text-emerald-400">{activeProposal.benchmark_after.accuracyScore}%</span>
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">Avg Latency</span>
                  <span className="text-slate-200">
                    {activeProposal.benchmark_before.avgLatencyMs}ms →{' '}
                    <span className="text-emerald-400">{activeProposal.benchmark_after.avgLatencyMs}ms</span>
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">Sandbox Tests</span>
                  <span className="text-emerald-400">
                    {activeProposal.test_results.passed}/{activeProposal.test_results.total} ({activeProposal.test_results.durationMs}ms)
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-slate-400">Sandbox Test Output</p>
                <pre className="p-3 rounded-md bg-[#0B0F17] border border-slate-800 text-xs font-mono text-emerald-300 whitespace-pre-wrap">
                  {activeProposal.test_results.output || 'No output'}
                </pre>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-slate-400">Unified Diff</p>
                <pre className="p-3 rounded-md bg-[#0B0F17] border border-slate-800 text-xs font-mono text-slate-300 overflow-x-auto max-h-64">
                  {activeProposal.unified_diff}
                </pre>
              </div>

              {moduleOutput && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-slate-400">Live Promoted Module Output</p>
                  <pre className="p-3 rounded-md bg-[#0B0F17] border border-slate-800 text-xs font-mono text-blue-300 whitespace-pre-wrap">
                    {moduleOutput}
                  </pre>
                </div>
              )}

              <p className="text-xs text-slate-400">
                <span className="font-medium text-slate-300">Rollback Plan:</span> {activeProposal.rollback_plan}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
