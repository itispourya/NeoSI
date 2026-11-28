import { useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AdminOverviewPayload } from '../types/neo';

interface EvolutionViewProps {
  data: AdminOverviewPayload;
  onRefresh: () => Promise<void>;
}

export function EvolutionView({ data, onRefresh }: EvolutionViewProps) {
  const [focusArea, setFocusArea] = useState('Prompt caching and latency diagnostics');
  const [policyTitle, setPolicyTitle] = useState('Tighter Reliability Threshold');
  const [policyHypothesis, setPolicyHypothesis] = useState('Raise minReliability to 0.5 and ragTopK to 5 for cleaner grounding.');
  const [policyTopK, setPolicyTopK] = useState(5);
  const [policyMinRel, setPolicyMinRel] = useState(0.5);
  const [sysEvalOut, setSysEvalOut] = useState<{
    overallScore: number;
    previousOverallScore: number | null;
    scoreDelta: number | null;
    categoryScores: Record<string, number>;
  } | null>(null);
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
      setMsg(`Created a standalone candidate proposal (status=${res.proposal.status}); it has not been integrated into the Neo source tree.`);
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
      setMsg(action === 'approve'
        ? `Proposal ${id.slice(0, 8)} promoted into the candidate modules directory.`
        : `Proposal ${id.slice(0, 8)} ${action}d.`);
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
      setMsg(`Dataset prepared: ${res.job.dataset_size} privacy-filtered JSONL samples. No model training was started and no adapter weights were produced.`);
      await onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Dataset preparation failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleScheduledJob = async (id: string, enabled: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch(`/api/admin/scheduler/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      await onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Scheduler toggle failed');
    } finally {
      setBusy(false);
    }
  };

  const runSchedulerTick = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ ran: string[]; skippedBusy: boolean }>('/api/admin/scheduler/tick', {
        method: 'POST',
        body: JSON.stringify({ force: false }),
      });
      setMsg(res.skippedBusy ? 'Scheduler deferred: active user tasks have priority.' : `Scheduler tick ran: ${res.ran.join(', ') || 'no due jobs'}`);
      await onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Scheduler tick failed');
    } finally {
      setBusy(false);
    }
  };

  const runSystemEval = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{
        evaluation: { overall_score: number; category_scores: Record<string, number>; passed_cases: number; total_cases: number };
        previousOverallScore: number | null;
        scoreDelta: number | null;
      }>('/api/v1/evolution/evaluate', { method: 'POST', body: '{}' });
      setSysEvalOut({
        overallScore: res.evaluation.overall_score,
        previousOverallScore: res.previousOverallScore,
        scoreDelta: res.scoreDelta,
        categoryScores: res.evaluation.category_scores,
      });
      setMsg(
        `System evaluation completed: ${res.evaluation.overall_score}% (${res.evaluation.passed_cases}/${res.evaluation.total_cases} passed)${
          res.scoreDelta !== null ? ` · delta ${res.scoreDelta >= 0 ? '+' : ''}${res.scoreDelta}%` : ''
        }.`
      );
      await onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'System evaluation failed');
    } finally {
      setBusy(false);
    }
  };

  const proposePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ policy: { version: number; status: string }; experiment: { status: string } }>(
        '/api/v1/evolution/policies',
        {
          method: 'POST',
          body: JSON.stringify({
            title: policyTitle.trim(),
            hypothesis: policyHypothesis.trim(),
            patch: { ragTopK: policyTopK, minReliability: policyMinRel },
            autoPromote: false,
          }),
        }
      );
      setMsg(`Behavioral policy v${res.policy.version} evaluated (policy=${res.policy.status}, experiment=${res.experiment.status}).`);
      await onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Policy proposal failed');
    } finally {
      setBusy(false);
    }
  };

  const promotePolicy = async (id: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ policy: { version: number } }>(`/api/v1/evolution/policies/${id}/promote`, {
        method: 'POST',
        body: '{}',
      });
      setMsg(`Promoted behavioral policy v${res.policy.version} to active.`);
      await onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Policy promotion failed');
    } finally {
      setBusy(false);
    }
  };

  const rollbackPolicy = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ policy: { version: number } }>('/api/v1/evolution/policies/rollback', {
        method: 'POST',
        body: '{}',
      });
      setMsg(`Rolled back active behavioral policy to v${res.policy.version}.`);
      await onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Policy rollback failed');
    } finally {
      setBusy(false);
    }
  };

  const behavioralPolicies = data.behavioralPolicies ?? [];

  return (
    <div className="space-y-6">
      {msg && <div className="p-3 rounded bg-blue-500/10 border border-blue-500/30 text-xs text-blue-200">{msg}</div>}

      {/* System Evaluation & Behavioral Policy Lifecycle (Layer 3) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-100">System Intelligence Evaluation Suite</h2>
              <p className="text-xs text-slate-400">
                Measures task correctness, RAG provenance separation, critic grounding, tool calling, and injection defense.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void runSystemEval()}
              disabled={busy}
              className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap shrink-0"
            >
              Run System Eval
            </button>
          </div>
          {sysEvalOut ? (
            <div className="space-y-2 text-xs font-mono tabular-nums">
              <div className="p-2.5 bg-[#0B0F17] border border-slate-800 rounded flex justify-between">
                <span className="text-slate-200">Overall Score: {sysEvalOut.overallScore}%</span>
                <span className="text-slate-400">
                  {sysEvalOut.scoreDelta !== null
                    ? `Delta: ${sysEvalOut.scoreDelta >= 0 ? '+' : ''}${sysEvalOut.scoreDelta}%`
                    : 'Baseline recorded'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                {Object.entries(sysEvalOut.categoryScores).map(([k, v]) => (
                  <div key={k} className="p-2 bg-[#0B0F17] border border-slate-800 rounded flex justify-between">
                    <span className="text-slate-400 truncate">{k}</span>
                    <span className="text-slate-200">{v}%</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-xs text-slate-400">Click Run System Eval to compare current configuration against prior baseline.</div>
          )}
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Layer 3 — Behavioral Policy Versions ({behavioralPolicies.length})
            </h2>
            <button
              type="button"
              onClick={() => void rollbackPolicy()}
              disabled={busy}
              className="px-2.5 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-200 whitespace-nowrap shrink-0"
            >
              Rollback Policy
            </button>
          </div>
          <form onSubmit={proposePolicy} className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <input
              type="text"
              value={policyTitle}
              onChange={(e) => setPolicyTitle(e.target.value)}
              placeholder="Policy version title"
              aria-label="Policy title"
              required
              className="px-3 py-1.5 bg-[#0B0F17] border border-slate-700 rounded text-slate-100"
            />
            <div className="flex gap-2">
              <input
                type="number"
                min={1}
                max={12}
                value={policyTopK}
                onChange={(e) => setPolicyTopK(Number(e.target.value))}
                aria-label="RAG top K"
                title="ragTopK"
                className="w-20 px-2 py-1.5 bg-[#0B0F17] border border-slate-700 rounded text-slate-100 font-mono tabular-nums"
              />
              <input
                type="number"
                step="0.05"
                min={0.1}
                max={0.95}
                value={policyMinRel}
                onChange={(e) => setPolicyMinRel(Number(e.target.value))}
                aria-label="Minimum reliability"
                title="minReliability"
                className="w-24 px-2 py-1.5 bg-[#0B0F17] border border-slate-700 rounded text-slate-100 font-mono tabular-nums"
              />
              <button
                type="submit"
                disabled={busy}
                className="flex-1 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium whitespace-nowrap"
              >
                Propose & Test
              </button>
            </div>
            <input
              type="text"
              value={policyHypothesis}
              onChange={(e) => setPolicyHypothesis(e.target.value)}
              placeholder="Experiment hypothesis..."
              aria-label="Policy hypothesis"
              required
              className="sm:col-span-2 px-3 py-1.5 bg-[#0B0F17] border border-slate-700 rounded text-slate-100"
            />
          </form>
          <div className="divide-y divide-slate-800/80 max-h-36 overflow-y-auto">
            {behavioralPolicies.map((p) => (
              <div key={p.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <div className="text-slate-200 truncate">v{p.version} · {p.title}</div>
                  <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                    {p.status} · topK={p.config.ragTopK} · minRel={p.config.minReliability}
                  </div>
                </div>
                {(p.status === 'candidate' || p.status === 'rolled_back') && (
                  <button
                    type="button"
                    onClick={() => void promotePolicy(p.id)}
                    className="px-2.5 py-1 rounded border border-emerald-500/40 text-emerald-300 text-[11px] whitespace-nowrap shrink-0"
                  >
                    Promote
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Layer C Proposal Launcher + Layer D Dataset Builder */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form onSubmit={diagnoseProposal} className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
          <h2 className="font-display text-sm font-semibold text-slate-100">Layer C — Standalone Candidate Module Validation</h2>
          <p className="text-xs text-slate-400">
            Generates a candidate module and tests it in a temporary isolated workspace. It does not test integration with the full Neo codebase or measure candidate impact on the model benchmark. Promotion requires an administrator.
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
              <h2 className="font-display text-sm font-semibold text-slate-100">Layer D — Training Dataset Preparation Only</h2>
              <p className="text-xs text-slate-400">Builds deduplicated, PII-redacted JSONL datasets. This workflow does not invoke a trainer or produce model adapter weights.</p>
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
                    {(u.status === 'promoted' || u.status === 'merged') && (
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
                    Candidate integration benchmark: not run
                    <div className="mt-1 text-slate-400">Standalone tests: {u.test_results.passed}/{u.test_results.total}</div>
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
