import type { AdminOverviewPayload, NavSection } from '../types/neo';

interface OverviewViewProps {
  data: AdminOverviewPayload;
  onNavigate: (section: NavSection) => void;
}

export function OverviewView({ data, onNavigate }: OverviewViewProps) {
  const hw = data.hardware;
  const activeModels = data.models.filter((m) => m.deployment_status === 'active');
  const mem = data.memoryCounts;
  const completedTasks = data.tasks.filter((t) => t.status === 'completed').length;
  const latestEval = data.evaluations[0];

  return (
    <div className="space-y-6">
      <div className="bg-[#111827] border border-slate-800 rounded p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="font-display text-sm font-semibold text-slate-100">Interactive Neo Chatbot</div>
          <div className="text-xs text-slate-400">
            Start a persistent multilingual conversation grounded in Neo&apos;s 7-layer memory and 13-stage verified reasoning.
          </div>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('chat')}
          className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap shrink-0 self-start sm:self-auto"
        >
          Open Chatbot →
        </button>
      </div>

      {/* Primary KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#111827] border border-slate-800 rounded p-4">
          <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">Host Compute</div>
          <div className="mt-1 font-mono tabular-nums text-xl font-semibold text-slate-100">
            {hw.cpuCores} vCPU / {hw.totalRamGb} GB RAM
          </div>
          <div className="mt-1 text-xs font-mono text-slate-400">
            {hw.hasGpu ? `${hw.totalVramGb} GB VRAM` : 'CPU-only'} · {hw.diskFreeGb} GB free
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded p-4">
          <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">Active Models</div>
          <div className="mt-1 font-mono tabular-nums text-xl font-semibold text-slate-100">
            {activeModels.length} Active / {data.models.length} Registered
          </div>
          <div className="mt-1 text-xs font-mono text-slate-400 truncate">
            {activeModels.map((m) => m.id).join(', ') || 'neo-embedded-core-v1'}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded p-4">
          <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">7-Layer Memory</div>
          <div className="mt-1 font-mono tabular-nums text-xl font-semibold text-slate-100">
            {mem.total} Records
          </div>
          <div className="mt-1 text-xs font-mono text-slate-400">
            S:{mem.semantic} · P:{mem.procedural} · E:{mem.episodic} · T:{mem.temporal}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded p-4">
          <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">Benchmarks & Tasks</div>
          <div className="mt-1 font-mono tabular-nums text-xl font-semibold text-slate-100">
            {latestEval ? `${latestEval.overall_score}% Bench` : 'Ready'}
          </div>
          <div className="mt-1 text-xs font-mono text-slate-400">
            {completedTasks}/{data.tasks.length} Tasks · {data.telemetrySummary.totalCalls} Infer Calls
          </div>
        </div>
      </div>

      {/* Subsystems + Runtime Health */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-slate-100">Inference Runtime Health</h2>
            <button
              type="button"
              onClick={() => onNavigate('models')}
              className="text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap"
            >
              Manage Models →
            </button>
          </div>
          <div className="divide-y divide-slate-800/80">
            {data.runtimeHealth.map((rt) => (
              <div key={`${rt.runtime}:${rt.modelId}`} className="py-2.5 flex items-center justify-between gap-4 text-xs">
                <div className="min-w-0">
                  <div className="font-mono text-slate-200">{rt.runtime}</div>
                  <div className="text-[11px] text-slate-400 truncate">{rt.message}</div>
                </div>
                <div className="text-right font-mono tabular-nums shrink-0">
                  <div className={rt.status === 'healthy' ? 'text-emerald-400' : 'text-amber-400'}>{rt.status}</div>
                  <div className="text-[11px] text-slate-500">{rt.latencyMs}ms</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-slate-100">7-Layer Cognitive Memory Breakdown</h2>
            <button
              type="button"
              onClick={() => onNavigate('memory')}
              className="text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap"
            >
              Open Memory & Graph →
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            {(['working', 'episodic', 'semantic', 'procedural', 'personal', 'organizational', 'temporal'] as const).map((layer) => (
              <div key={layer} className="bg-[#0B0F17] border border-slate-800 rounded p-3">
                <div className="text-[11px] font-mono text-slate-400 uppercase">{layer}</div>
                <div className="mt-1 font-mono tabular-nums text-lg font-semibold text-slate-100">{mem[layer] ?? 0}</div>
              </div>
            ))}
            <div className="bg-[#0B0F17] border border-slate-800 rounded p-3">
              <div className="text-[11px] font-mono text-slate-400 uppercase">Graph</div>
              <div className="mt-1 font-mono tabular-nums text-lg font-semibold text-slate-100">
                {data.graph.entities.length} / {data.graph.relationships.length}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Infrastructure Subsystems + Scheduler Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
          <h2 className="font-display text-sm font-semibold text-slate-100">Infrastructure & Security Boundaries</h2>
          <div className="grid grid-cols-2 gap-3 text-xs font-mono">
            <div className="bg-[#0B0F17] border border-slate-800 rounded p-3">
              <div className="text-slate-400 text-[11px]">DATABASE</div>
              <div className="text-slate-200 mt-1">{data.subsystems.storage}</div>
            </div>
            <div className="bg-[#0B0F17] border border-slate-800 rounded p-3">
              <div className="text-slate-400 text-[11px]">QUEUE BACKEND</div>
              <div className="text-slate-200 mt-1">{data.subsystems.queue}</div>
            </div>
            <div className="bg-[#0B0F17] border border-slate-800 rounded p-3">
              <div className="text-slate-400 text-[11px]">EXECUTION SANDBOX</div>
              <div className="text-slate-200 mt-1">{data.subsystems.sandbox}</div>
            </div>
            <div className="bg-[#0B0F17] border border-slate-800 rounded p-3">
              <div className="text-slate-400 text-[11px]">REPO CODEBASE</div>
              <div className="text-slate-200 mt-1 tabular-nums">
                {data.repoSummary.totalFiles} files · {data.repoSummary.totalLines} LOC
              </div>
            </div>
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-slate-100">Autonomous Scheduler Jobs</h2>
            <button
              type="button"
              onClick={() => onNavigate('evolution')}
              className="text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap"
            >
              Configure →
            </button>
          </div>
          <div className="divide-y divide-slate-800/80">
            {data.scheduledJobs.map((job) => (
              <div key={job.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <div className="text-slate-200 font-medium truncate">{job.name}</div>
                  <div className="font-mono text-[11px] text-slate-400">
                    {job.job_kind} · {job.priority}
                  </div>
                </div>
                <div className="font-mono tabular-nums text-right shrink-0">
                  <div className={job.enabled ? 'text-emerald-400' : 'text-slate-500'}>
                    {job.enabled ? 'enabled' : 'paused'}
                  </div>
                  <div className="text-[11px] text-slate-500">runs: {job.run_count}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
