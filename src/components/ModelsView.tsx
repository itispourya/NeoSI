import { useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AdminOverviewPayload } from '../types/neo';

interface ModelsViewProps {
  data: AdminOverviewPayload;
  onRefresh: () => Promise<void>;
}

export function ModelsView({ data, onRefresh }: ModelsViewProps) {
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const compatMap = new Map(data.modelCompatibility.map((c) => [c.id, c]));

  const runBenchmark = async (modelId: string) => {
    setBusyModel(modelId);
    setError(null);
    try {
      const res = await apiFetch<{ evaluation: { overall_score: number; passed_cases: number; total_cases: number; avg_latency_ms: number } }>(
        '/api/v1/models/evaluate',
        { method: 'POST', body: JSON.stringify({ modelId }) }
      );
      setStatusMsg(
        `Evaluated ${modelId}: ${res.evaluation.overall_score}% (${res.evaluation.passed_cases}/${res.evaluation.total_cases} cases, ${res.evaluation.avg_latency_ms}ms avg)`
      );
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Evaluation failed');
    } finally {
      setBusyModel(null);
    }
  };

  const installModel = async (modelId: string) => {
    setBusyModel(modelId);
    setError(null);
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>('/api/v1/models/install', {
        method: 'POST',
        body: JSON.stringify({ modelId }),
      });
      setStatusMsg(res.message);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed');
    } finally {
      setBusyModel(null);
    }
  };

  const verifyModel = async (modelId: string) => {
    setBusyModel(modelId);
    setError(null);
    try {
      const result = await apiFetch<{ ready: boolean; message: string }>(`/api/v1/models/${encodeURIComponent(modelId)}/verify`, { method: 'POST', body: '{}' });
      setStatusMsg(result.message);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Runtime verification failed');
    } finally {
      setBusyModel(null);
    }
  };

  const activateModel = async (modelId: string) => {
    setBusyModel(modelId);
    setError(null);
    try {
      await apiFetch('/api/v1/models/activate', {
        method: 'POST',
        body: JSON.stringify({ modelId, role: 'primary' }),
      });
      setStatusMsg(`Activated ${modelId} as primary runtime model.`);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed');
    } finally {
      setBusyModel(null);
    }
  };

  const rollbackPrimary = async () => {
    setBusyModel('rollback');
    setError(null);
    try {
      const res = await apiFetch<{ deployment: { modelId: string } }>('/api/v1/models/rollback', {
        method: 'POST',
        body: JSON.stringify({ role: 'primary' }),
      });
      setStatusMsg(`Rolled back primary model to ${res.deployment.modelId}.`);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollback failed');
    } finally {
      setBusyModel(null);
    }
  };

  const latestEval = data.evaluations[0];

  return (
    <div className="space-y-6">
      {statusMsg && <div className="p-3 rounded bg-blue-500/10 border border-blue-500/30 text-xs text-blue-200">{statusMsg}</div>}
      {error && <div className="p-3 rounded bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">{error}</div>}

      {/* Registered Models Table */}
      <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-100">Open-Weight Model Registry</h2>
            <p className="text-xs text-slate-400">
              Hardware Profile: {data.hardware.recommendedProfile} ({data.hardware.cpuCores} vCPU, {data.hardware.totalRamGb} GB RAM, {data.hardware.totalVramGb} GB VRAM)
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void runBenchmark('neo-embedded-core-v1')}
              disabled={busyModel !== null}
              className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              {busyModel === 'neo-embedded-core-v1' ? 'Benchmarking...' : 'Run Benchmark'}
            </button>
            <button
              type="button"
              onClick={() => void rollbackPrimary()}
              disabled={busyModel !== null}
              className="px-3 py-1.5 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 whitespace-nowrap shrink-0"
            >
              Rollback Primary
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-400 border-b border-slate-800 font-mono">
              <tr>
                <th className="py-2 pr-4">Model ID</th>
                <th className="py-2 pr-4">Runtime / License</th>
                <th className="py-2 pr-4">Hardware Fit</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {data.models.map((m) => {
                const compat = compatMap.get(m.id);
                return (
                  <tr key={m.id}>
                    <td className="py-3 pr-4">
                      <div className="font-mono text-slate-100">{m.id}</div>
                      <div className="text-[11px] text-slate-400">{m.architecture} · {m.quantization} · ctx {m.context_length}</div>
                    </td>
                    <td className="py-3 pr-4 font-mono text-slate-300">
                      <div>{m.runtime}</div>
                      <div className="text-[11px] text-slate-400">{m.license}</div>
                    </td>
                    <td className="py-3 pr-4 text-[11px] font-mono">
                      <div className={compat?.compatible ? 'text-emerald-400' : 'text-amber-400'}>
                        {compat?.compatible ? 'Compatible' : 'Insufficient HW'}
                      </div>
                      <div className="text-slate-500">VRAM {m.vram_gb}G / RAM {m.ram_gb}G</div>
                    </td>
                    <td className="py-3 pr-4 font-mono text-[11px]">
                      <div className={m.deployment_status === 'active' ? 'text-emerald-400' : 'text-slate-300'}>
                        {m.deployment_status} ({m.download_status})
                      </div>
                    </td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {m.download_status === 'available' && (
                          <button
                            type="button"
                            onClick={() => void verifyModel(m.id)}
                            disabled={busyModel !== null}
                            className="px-2.5 py-1 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 text-[11px] whitespace-nowrap"
                          >
                            Verify Runtime
                          </button>
                        )}
                        {m.download_status !== 'ready' && m.download_status !== 'available' && (
                          <button
                            type="button"
                            onClick={() => void installModel(m.id)}
                            disabled={busyModel !== null}
                            className="px-2.5 py-1 rounded border border-slate-700 hover:bg-slate-800 text-[11px] text-slate-200 whitespace-nowrap"
                          >
                            Install
                          </button>
                        )}
                        {m.download_status === 'ready' && m.deployment_status !== 'active' && (
                          <button
                            type="button"
                            onClick={() => void activateModel(m.id)}
                            disabled={busyModel !== null}
                            className="px-2.5 py-1 rounded border border-blue-500/40 text-blue-300 hover:bg-blue-500/10 text-[11px] whitespace-nowrap"
                          >
                            Activate
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void runBenchmark(m.id)}
                          disabled={busyModel !== null}
                          className="px-2.5 py-1 rounded border border-slate-700 hover:bg-slate-800 text-[11px] text-slate-300 whitespace-nowrap"
                        >
                          Benchmark
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Latest Benchmark Breakdown + Multimodal Capabilities */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <h3 className="font-display text-sm font-semibold text-slate-100">
            Latest Intelligence Benchmark {latestEval ? `(${latestEval.model_id} · ${latestEval.overall_score}%)` : ''}
          </h3>
          {!latestEval ? (
            <div className="text-xs text-slate-400 py-4">Run the focused regression suite to inspect model behavior. Results are task-specific and are not a standardized intelligence score.</div>
          ) : (
            <div className="space-y-2.5">
              {Object.entries(latestEval.category_scores).map(([cat, score]) => (
                <div key={cat} className="space-y-1 text-xs">
                  <div className="flex justify-between font-mono">
                    <span className="text-slate-300">{cat}</span>
                    <span className="tabular-nums text-slate-200">{score}%</span>
                  </div>
                  <div className="h-1.5 bg-[#0B0F17] rounded overflow-hidden">
                    <div
                      className={`h-full ${score >= 80 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-rose-500'}`}
                      style={{ width: `${Math.min(100, Math.max(2, score))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
          <h3 className="font-display text-sm font-semibold text-slate-100">Multimodal Capability Matrix (Honest Host Inspection)</h3>
          <div className="divide-y divide-slate-800/80">
            {(Array.isArray(data.capabilities) ? data.capabilities : []).map((cap) => (
              <div key={cap.modality} className="py-2.5 flex items-start justify-between gap-4 text-xs">
                <div>
                  <div className="font-mono text-slate-200">{cap.modality}</div>
                  <div className="text-[11px] text-slate-400">{cap.notes}</div>
                </div>
                <div className="text-right font-mono shrink-0">
                  <div className={cap.supported ? 'text-emerald-400' : 'text-amber-400'}>
                    {cap.supported ? 'ready' : 'unavailable'}
                  </div>
                  <div className="text-[11px] text-slate-500">{cap.engine}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
