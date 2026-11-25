import { useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AdminOverviewPayload, TaskInfo } from '../types/neo';

interface TasksViewProps {
  data: AdminOverviewPayload;
  onRefresh: () => Promise<void>;
}

interface TaskDetailPayload {
  task: TaskInfo;
  steps: Array<{ step_index: number; title: string; action_type: string; tool_id: string | null; status: string; error: string | null }>;
  events: Array<{ id: string; event_type: string; payload: Record<string, unknown>; created_at: string }>;
}

export function TasksView({ data, onRefresh }: TasksViewProps) {
  const [goal, setGoal] = useState('Audit double-entry ledger balance and evaluate (145 * 12) + 260');
  const [autonomy, setAutonomy] = useState<'low' | 'balanced' | 'high'>('balanced');
  const [submitting, setSubmitting] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState<TaskDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const launchTask = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<{ task: TaskInfo }>('/api/v1/tasks', {
        method: 'POST',
        body: JSON.stringify({ goal, autonomy, priority: 'user_task' }),
      });
      await new Promise((r) => setTimeout(r, 400));
      const detail = await apiFetch<TaskDetailPayload>(`/api/v1/tasks/${res.task.id}`);
      setSelectedDetail(detail);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start task');
    } finally {
      setSubmitting(false);
    }
  };

  const inspectTask = async (taskId: string) => {
    setError(null);
    try {
      const detail = await apiFetch<TaskDetailPayload>(`/api/v1/tasks/${taskId}`);
      setSelectedDetail(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect task');
    }
  };

  const cancelTask = async (taskId: string) => {
    await apiFetch(`/api/v1/tasks/${taskId}/cancel`, { method: 'POST', body: '{}' });
    await inspectTask(taskId);
    await onRefresh();
  };

  return (
    <div className="space-y-6">
      <form onSubmit={launchTask} className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-100">Launch Durable Autonomous Task</h2>
            <p className="text-xs text-slate-400">Persists DAG steps, checkpoints, tool budgets, loop detection, and Critic verification.</p>
          </div>
          <select
            value={autonomy}
            onChange={(e) => setAutonomy(e.target.value as 'low' | 'balanced' | 'high')}
            className="px-3 py-1.5 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-200"
            aria-label="Autonomy level"
          >
            <option value="low">Low Autonomy</option>
            <option value="balanced">Balanced</option>
            <option value="high">High Autonomy</option>
          </select>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            required
            placeholder="Describe an autonomous goal..."
            className="flex-1 px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100 focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            {submitting ? 'Executing...' : 'Execute Autonomous Task'}
          </button>
        </div>
        {error && <div className="text-xs text-rose-400">{error}</div>}
      </form>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
          <h3 className="font-display text-sm font-semibold text-slate-100">Persisted Task Queue ({data.tasks.length})</h3>
          <div className="divide-y divide-slate-800/80 max-h-[420px] overflow-y-auto">
            {data.tasks.length === 0 ? (
              <div className="py-6 text-xs text-slate-400">No autonomous tasks recorded yet.</div>
            ) : (
              data.tasks.map((task) => (
                <div key={task.id} className="py-3 flex items-start justify-between gap-3 text-xs">
                  <button
                    type="button"
                    onClick={() => void inspectTask(task.id)}
                    className="text-left min-w-0 flex-1 hover:text-blue-300"
                  >
                    <div className="text-slate-100 font-medium truncate">{task.goal}</div>
                    <div className="font-mono text-[11px] text-slate-400 mt-0.5 tabular-nums">
                      {task.status} · steps:{task.usage.stepsExecuted} · tools:{task.usage.toolCalls} · {task.usage.durationMs}ms
                    </div>
                  </button>
                  {(task.status === 'running' || task.status === 'planning') && (
                    <button
                      type="button"
                      onClick={() => void cancelTask(task.id)}
                      className="px-2.5 py-1 rounded border border-rose-500/40 text-rose-300 text-[11px] hover:bg-rose-500/10 whitespace-nowrap shrink-0"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <h3 className="font-display text-sm font-semibold text-slate-100">DAG Steps & Event Stream</h3>
          {!selectedDetail ? (
            <div className="text-xs text-slate-400 py-6">Select a task or launch a new one to inspect DAG steps, checkpoints, and Critic verdict.</div>
          ) : (
            <div className="space-y-4 text-xs">
              <div className="bg-[#0B0F17] border border-slate-800 rounded p-3 font-mono space-y-1">
                <div className="text-slate-200">Status: {selectedDetail.task.status}</div>
                <div className="text-slate-400">
                  Budgets: maxSteps={selectedDetail.task.budgets.maxSteps}, maxTools={selectedDetail.task.budgets.maxToolCalls}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-[11px] font-mono uppercase text-slate-400">Execution Steps</div>
                {selectedDetail.steps.map((st) => (
                  <div key={st.step_index} className="bg-[#0B0F17] border border-slate-800 rounded px-3 py-2 flex items-center justify-between gap-2">
                    <div className="min-w-0 truncate">
                      <span className="font-mono text-slate-400 mr-2">#{st.step_index}</span>
                      <span className="text-slate-200">{st.title}</span>
                    </div>
                    <span className={`font-mono text-[11px] shrink-0 ${st.status === 'completed' ? 'text-emerald-400' : st.status === 'failed' ? 'text-rose-400' : 'text-amber-400'}`}>
                      {st.status}
                    </span>
                  </div>
                ))}
              </div>

              {selectedDetail.task.result && (
                <div className="bg-[#0B0F17] border border-slate-800 rounded p-3 space-y-1">
                  <div className="text-[11px] font-mono uppercase text-slate-400">Verified Output</div>
                  <pre className="text-[11px] font-mono text-slate-200 whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {String(selectedDetail.task.result.answer || JSON.stringify(selectedDetail.task.result, null, 2))}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
        <h3 className="font-display text-sm font-semibold text-slate-100">Recent Tool Executions ({data.toolExecutions.length})</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="text-slate-400 border-b border-slate-800">
              <tr>
                <th className="py-2 pr-4">Tool</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Duration</th>
                <th className="py-2">Actor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {data.toolExecutions.slice(0, 10).map((ex) => (
                <tr key={ex.id}>
                  <td className="py-2 pr-4 text-slate-200">{ex.tool_id}</td>
                  <td className={`py-2 pr-4 ${ex.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{ex.ok ? 'ok' : ex.error || 'err'}</td>
                  <td className="py-2 pr-4 tabular-nums text-slate-400">{ex.duration_ms}ms</td>
                  <td className="py-2 text-slate-400">{ex.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
