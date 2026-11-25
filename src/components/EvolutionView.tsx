import { useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AdminOverviewPayload } from '../types/neo';

interface EvolutionViewProps {
  data: AdminOverviewPayload;
  onRefresh: () => Promise<void>;
}

export function EvolutionView({ data, onRefresh }: EvolutionViewProps) {
  const [focusArea, setFocusArea] = useState('Prompt caching and latency diagnostics');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const diagnoseProposal = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ proposal: { id: string; status: string; branch_name: string } }>(
        '/api/v1/evolution/proposals',
        { method: 'POST', body: JSON.stringify({ focusArea }) }
      );
      setMsg(`Created isolated proposal on branch ${res.proposal.branch_name} (status=${res.proposal.status}).`);
      await onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Proposal failed');
    } finally {
      setBusy(false);
    }
  };

  const actProposal = async (id: string, action: 'approve' | 'reject' | 'rollback') => {
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch(`/api/v1/evolution/proposals/${id}/${action}`, { method: 'POST', body: '{}' });
      setMsg(`Proposal ${id.slice(0, 8)} ${action}d.`);
      await onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : `Action ${action} failed`);
    } finally {
      setBusy(false);
    }
  };

  const triggerTraining = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ job: { id: string; dataset_size: number; status: string } }>('/api/v1/evolution/training', {
        method: 'POST',
        body: JSON.stringify({ baseModelId: 'qwen2.5:3b-instruct', method: 'lora', minReliability: 0.75 }),
      });
      setMsg(`Layer D training dataset prepared (${res.job.dataset_size} privacy-filtered JSONL samples, status=${res.job.status}).`);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const toggleScheduledJob = async (id: string, enabled: boolean) => {
    await apiFetch(`/api/admin/scheduler/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    await onRefresh();
  };

  const runSchedulerTick = async () => {
    setBusy(true);
    try {
      const res = await apiFetch<{ ran: string[]; skippedBusy: boolean }>('/api/admin/scheduler/tick', {
        method: 'POST',
        body: JSON.stringify({ force: false }),
      });
      setMsg(res.skippedBusy ? 'Scheduler deferred: active user tasks have priority.' : `Scheduler tick ran: ${res.ran.join(', ') || 'no due jobs'}`);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {msg && <div className="p-3 rounded bg-blue-500/10 border border-blue-500/30 text-xs text-blue-200">{msg}</div>}

      {/* Layer C Proposal Launcher + Layer D Dataset Builder */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form onSubmit={diagnoseProposal} className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
          <h2 className="font-display text-sm font-semibold text-slate-100">Layer C — Isolated Git & Benchmark Evolution</h2>
          <p className="text-xs text-slate-400">
            Measures real baseline benchmark, isolates candidate code in temp Git branch + subprocess tests, then re-measures candidate score before gating promotion.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={focusArea}
              onChange={(e) => setFocusArea(e.target.value)}
              className="flex-1 px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap shrink-0"
            >
              Diagnose & Propose
            </button>
          </div>
        </form>

        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-100">Layer D — SFT / LoRA Dataset & Adapter Jobs</h2>
              <p className="text-xs text-slate-400">Builds deduplicated, PII-redacted JSONL datasets from verified semantic & procedural memory.</p>
            </div>
            <button
              type="button"
              onClick={() => void triggerTraining()}
              disabled={busy}
              className="px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap shrink-0"
            >
              Build Dataset
            </button>
          </div>
          <div className="divide-y divide-slate-800/80 max-h-28 overflow-y-auto">
            {data.trainingJobs.map((j) => (
              <div key={j.id} className="py-1.5 flex justify-between text-xs font-mono">
                <span className="text-slate-200">{j.base_model_id} ({j.method})</span>
                <span className="text-slate-400">{j.dataset_size} rows · {j.status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Proposals List */}
      <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
        <h3 className="font-display text-sm font-semibold text-slate-100">Code Evolution Proposals ({data.upgrades.length})</h3>
        {data.upgrades.length === 0 ? (
          <div className="text-xs text-slate-400">No code evolution proposals generated yet.</div>
        ) : (
          <div className="space-y-4">
            {data.upgrades.map((u) => (
              <div key={u.id} className="bg-[#0B0F17] border border-slate-800 rounded p-4 space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-slate-100">{u.title}</div>
                    <div className="font-mono text-[11px] text-slate-400">
                      {u.branch_name} · status={u.status} · tests {u.test_results.passed}/{u.test_results.total}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {u.status === 'sandbox_passed' && (
                      <>
                        <button
                          type="button"
                          onClick={() => void actProposal(u.id, 'approve')}
                          className="px-2.5 py-1 rounded bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 text-[11px] whitespace-nowrap"
                        >
                          Approve & Promote
                        </button>
                        <button
                          type="button"
                          onClick={() => void actProposal(u.id, 'reject')}
                          className="px-2.5 py-1 rounded border border-rose-500/40 text-rose-300 text-[11px] whitespace-nowrap"
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {u.status === 'merged' && (
                      <button
                        type="button"
                        onClick={() => void actProposal(u.id, 'rollback')}
                        className="px-2.5 py-1 rounded border border-amber-500/40 text-amber-300 text-[11px] whitespace-nowrap"
                      >
                        Rollback
                      </button>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 font-mono text-[11px] tabular-nums">
                  <div className="p-2 bg-[#111827] border border-slate-800 rounded">
                    Before: {u.benchmark_before.accuracyScore}% · {u.benchmark_before.avgLatencyMs}ms
                  </div>
                  <div className="p-2 bg-[#111827] border border-slate-800 rounded">
                    After: {u.benchmark_after.accuracyScore}% · {u.benchmark_after.avgLatencyMs}ms
                  </div>
                </div>
                <pre className="p-2.5 bg-[#111827] border border-slate-800 rounded font-mono text-[11px] text-slate-300 overflow-x-auto max-h-40">
                  {u.unified_diff}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Autonomous Scheduler */}
      <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-display text-sm font-semibold text-slate-100">Priority-Aware Autonomous Scheduler</h3>
          <button
            type="button"
            onClick={() => void runSchedulerTick()}
            disabled={busy}
            className="px-3 py-1.5 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 whitespace-nowrap shrink-0"
          >
            Run Scheduler Tick
          </button>
        </div>
        <div className="divide-y divide-slate-800/80">
          {data.scheduledJobs.map((job) => (
            <div key={job.id} className="py-2.5 flex items-center justify-between gap-4 text-xs">
              <div>
                <div className="text-slate-100 font-medium">{job.name}</div>
                <div className="font-mono text-[11px] text-slate-400">
                  {job.job_kind} · every {Math.round(job.interval_ms / 60000)}m · runs: {job.run_count} · last: {job.last_status || 'pending'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void toggleScheduledJob(job.id, !job.enabled)}
                className={`px-3 py-1 rounded border text-[11px] whitespace-nowrap shrink-0 ${
                  job.enabled ? 'border-emerald-500/40 text-emerald-300' : 'border-slate-700 text-slate-400'
                }`}
              >
                {job.enabled ? 'Enabled' : 'Paused'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
