import { useState } from 'react';
import type { AdminOverviewPayload, NavSection } from '../types/neo';

interface OverviewViewProps {
  data: AdminOverviewPayload;
  onNavigate: (section: NavSection) => void;
}

export function OverviewView({ data, onNavigate }: OverviewViewProps) {
  const [copiedSdk, setCopiedSdk] = useState(false);

  const sdkSnippet = `import { NeoAiClient } from '@neos/ai-sdk';

const neo = new NeoAiClient({
  baseUrl: '${window.location.origin}',
  apiKey: process.env.NEOS_AI_API_KEY!,
});

const audit = await neo.analyzeBusiness({
  workspaceName: 'Neos Europe',
  language: 'en',
  accounting: { cashBalance: 240000, monthlyRevenue: 65000, monthlyExpenses: 52000 },
});`;

  const copySdk = async () => {
    await navigator.clipboard.writeText(sdkSnippet);
    setCopiedSdk(true);
    setTimeout(() => setCopiedSdk(false), 1800);
  };

  return (
    <div className="space-y-8">
      {/* KPI Grid */}
      <section aria-label="Core telemetry metrics" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5">
          <p className="text-xs text-slate-400">Memories Indexed</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100 font-mono tabular-nums">
            {data.memoryCounts.total}
          </p>
          <p className="mt-2 text-xs text-slate-500 font-mono tabular-nums">
            {data.memoryCounts.semantic} sem · {data.memoryCounts.procedural} proc · {data.memoryCounts.episodic} ep
          </p>
        </div>

        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5">
          <p className="text-xs text-slate-400">Forged APIs & Modules</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100 font-mono tabular-nums">
            {data.dynamicApis.filter((a) => a.enabled).length}
          </p>
          <p className="mt-2 text-xs text-slate-500 font-mono tabular-nums">
            {data.dynamicApis.reduce((s, a) => s + a.call_count, 0)} calls · {data.promotedModules?.length || 0} promoted
          </p>
        </div>

        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5">
          <p className="text-xs text-slate-400">Cognitive Calls & Success</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100 font-mono tabular-nums">
            {data.telemetrySummary.totalCalls}
          </p>
          <p className="mt-2 text-xs text-emerald-400 font-mono tabular-nums">
            {data.telemetrySummary.successRate}% success · {data.telemetrySummary.avgLatencyMs}ms avg
          </p>
        </div>

        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5">
          <p className="text-xs text-slate-400">Token Cost & Codebase</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100 font-mono tabular-nums">
            ${data.telemetrySummary.totalCostUsd.toFixed(4)}
          </p>
          <p className="mt-2 text-xs text-slate-500 font-mono tabular-nums">
            {data.telemetrySummary.totalTokens.toLocaleString()} tokens · {data.repoSummary.totalFiles} files
          </p>
        </div>
      </section>

      {/* Multi-Provider Router & Search Matrix */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-sm font-semibold text-slate-100">Neo Core Subsystems</h2>
            <span className="text-xs text-slate-400">Queue: {data.providers.queue}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 font-medium">Subsystem</th>
                  <th className="py-2 font-medium">Engine</th>
                  <th className="py-2 font-medium text-right">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {data.providers.llm.map((p) => (
                  <tr key={p.id} className="h-9">
                    <td className="py-2 text-slate-200 font-medium">{p.name}</td>
                    <td className="py-2 text-slate-400 font-mono">{p.defaultModel}</td>
                    <td className={`py-2 text-right font-medium ${p.configured ? 'text-emerald-400' : 'text-slate-500'}`}>
                      {p.configured ? 'Active' : 'Standby'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-sm font-semibold text-slate-100">Neo Autonomous Discovery</h2>
            <button
              type="button"
              onClick={() => onNavigate('knowledge')}
              className="text-xs text-blue-400 hover:underline whitespace-nowrap shrink-0"
            >
              Manage Streams
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 font-medium">Source Engine</th>
                  <th className="py-2 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {data.providers.search.map((s) => (
                  <tr key={s.id} className="h-9">
                    <td className="py-2 text-slate-200 font-medium">{s.name}</td>
                    <td className={`py-2 text-right font-medium ${s.configured ? 'text-emerald-400' : 'text-slate-500'}`}>
                      {s.configured ? 'Active' : 'Optional'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Background Jobs & Neos SDK */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5">
          <h2 className="font-display text-sm font-semibold text-slate-100 mb-4">Recent Background Jobs</h2>
          {data.jobs.length === 0 ? (
            <p className="text-xs text-slate-400 py-6">
              No background jobs executed yet. Trigger a Knowledge Learn run or Neos Brain task to populate worker telemetry.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2 font-medium">Job Type</th>
                    <th className="py-2 font-medium">Queue</th>
                    <th className="py-2 font-medium text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {data.jobs.slice(0, 8).map((job) => (
                    <tr key={job.id} className="h-9">
                      <td className="py-2 font-mono text-slate-200">{job.job_type}</td>
                      <td className="py-2 text-slate-400">{job.queue_name}</td>
                      <td
                        className={`py-2 text-right font-medium ${
                          job.status === 'completed'
                            ? 'text-emerald-400'
                            : job.status === 'failed'
                            ? 'text-rose-400'
                            : 'text-amber-400'
                        }`}
                      >
                        {job.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-sm font-semibold text-slate-100">Neos TypeScript SDK Quick-Connect</h2>
            <button
              type="button"
              onClick={copySdk}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
            >
              {copiedSdk ? 'Copied' : 'Copy Snippet'}
            </button>
          </div>
          <pre className="p-3 rounded-md bg-[#0B0F17] border border-slate-800 text-xs font-mono text-slate-300 overflow-x-auto leading-relaxed">
            {sdkSnippet}
          </pre>
        </div>
      </section>
    </div>
  );
}
