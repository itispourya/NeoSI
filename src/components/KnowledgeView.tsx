import { useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AdminOverviewPayload, MemoryInfo } from '../types/neo';

interface KnowledgeViewProps {
  data: AdminOverviewPayload;
  onRefresh: () => Promise<void>;
}

export function KnowledgeView({ data, onRefresh }: KnowledgeViewProps) {
  const [topicInput, setTopicInput] = useState('');
  const [learning, setLearning] = useState(false);
  const [learnResult, setLearnResult] = useState<string | null>(null);
  const [learnError, setLearnError] = useState<string | null>(null);

  const [newStreamTopic, setNewStreamTopic] = useState('');
  const [newStreamCategory, setNewStreamCategory] = useState<'engineering' | 'business' | 'custom'>('engineering');

  const [ragQuery, setRagQuery] = useState('');
  const [ragMatches, setRagMatches] = useState<MemoryInfo[] | null>(null);
  const [querying, setQuerying] = useState(false);

  const [memoryFilter, setMemoryFilter] = useState<'all' | 'semantic' | 'procedural' | 'episodic'>('all');

  const handleLearnTopic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topicInput.trim()) return;
    setLearning(true);
    setLearnError(null);
    setLearnResult(null);
    try {
      const res = await apiFetch<{ topic: string; sourcesDiscovered: number; memoriesStored: number; skillsUpdated: number }>(
        '/api/v1/knowledge/learn',
        {
          method: 'POST',
          body: JSON.stringify({ topic: topicInput.trim() }),
        }
      );
      setLearnResult(
        `Crawled "${res.topic}": ${res.sourcesDiscovered} sources discovered, ${res.memoriesStored} memories stored, ${res.skillsUpdated} skills updated.`
      );
      setTopicInput('');
      await onRefresh();
    } catch (err) {
      setLearnError(err instanceof Error ? err.message : 'Learning crawl failed');
    } finally {
      setLearning(false);
    }
  };

  const handleAddStream = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStreamTopic.trim()) return;
    await apiFetch('/api/admin/streams', {
      method: 'POST',
      body: JSON.stringify({ topic: newStreamTopic.trim(), category: newStreamCategory, interval_minutes: 120 }),
    });
    setNewStreamTopic('');
    await onRefresh();
  };

  const handleToggleStream = async (id: string, enabled: boolean) => {
    await apiFetch(`/api/admin/streams/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !enabled }),
    });
    await onRefresh();
  };

  const handleRagSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ragQuery.trim()) return;
    setQuerying(true);
    try {
      const res = await apiFetch<{ matches: MemoryInfo[] }>('/api/v1/knowledge/query', {
        method: 'POST',
        body: JSON.stringify({ query: ragQuery.trim(), limit: 8 }),
      });
      setRagMatches(res.matches);
    } finally {
      setQuerying(false);
    }
  };

  const displayedMemories = data.recentMemories.filter((m) => memoryFilter === 'all' || m.memory_type === memoryFilter);

  return (
    <div className="space-y-8">
      {/* Live Learning & Semantic RAG Query */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-100">Trigger Autonomous Web Research</h2>
            <p className="mt-1 text-xs text-slate-400">
              Discovers real web docs, GitHub repositories, and arXiv papers, scores source reliability, chunks, and embeds into vector memory.
            </p>
          </div>
          <form onSubmit={handleLearnTopic} className="flex flex-col sm:flex-row gap-3">
            <label className="sr-only" htmlFor="learn-topic-input">Research topic</label>
            <input
              id="learn-topic-input"
              type="text"
              value={topicInput}
              onChange={(e) => setTopicInput(e.target.value)}
              placeholder="e.g., PostgreSQL pgvector HNSW tuning or IFRS 15 SaaS revenue"
              className="flex-1 px-3 py-2 text-sm bg-[#0B0F17] border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
            />
            <button
              type="submit"
              disabled={learning || !topicInput.trim()}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {learning ? 'Researching...' : 'Learn Topic'}
            </button>
          </form>
          {learnResult && <p className="text-xs text-emerald-400">{learnResult}</p>}
          {learnError && <p className="text-xs text-rose-400">{learnError}</p>}
        </div>

        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-100">Vector Semantic RAG Query</h2>
            <p className="mt-1 text-xs text-slate-400">
              Query Episodic, Semantic, and Procedural long-term memory using cosine similarity over 768-d embeddings.
            </p>
          </div>
          <form onSubmit={handleRagSearch} className="flex flex-col sm:flex-row gap-3">
            <label className="sr-only" htmlFor="rag-query-input">Semantic memory query</label>
            <input
              id="rag-query-input"
              type="text"
              value={ragQuery}
              onChange={(e) => setRagQuery(e.target.value)}
              placeholder="Search distilled lessons, accounting rules, or engineering idioms..."
              className="flex-1 px-3 py-2 text-sm bg-[#0B0F17] border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
            />
            <button
              type="submit"
              disabled={querying || !ragQuery.trim()}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-slate-800 text-slate-100 hover:bg-slate-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {querying ? 'Searching...' : 'Query Memory'}
            </button>
          </form>
          {ragMatches && (
            <div className="space-y-2 max-h-48 overflow-y-auto pt-1">
              {ragMatches.length === 0 ? (
                <p className="text-xs text-slate-500">No semantic matches above threshold.</p>
              ) : (
                ragMatches.map((m) => (
                  <div key={m.id} className="p-2.5 rounded-md bg-[#0B0F17] border border-slate-800 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-200 truncate">{m.title}</span>
                      <span className="font-mono text-blue-400 tabular-nums shrink-0">
                        sim {((m.similarity ?? 0) * 100).toFixed(1)}%
                      </span>
                    </div>
                    <p className="mt-1 text-slate-400 line-clamp-2">{m.content}</p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </section>

      {/* Topic Streams */}
      <section className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <h2 className="font-display text-sm font-semibold text-slate-100">24/7 Daemon Topic Streams</h2>
          <form onSubmit={handleAddStream} className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={newStreamTopic}
              onChange={(e) => setNewStreamTopic(e.target.value)}
              placeholder="New continuous topic stream..."
              aria-label="New topic stream"
              className="px-3 py-1.5 text-xs bg-[#0B0F17] border border-slate-700 rounded-md text-slate-100"
            />
            <select
              value={newStreamCategory}
              onChange={(e) => setNewStreamCategory(e.target.value as 'engineering' | 'business' | 'custom')}
              aria-label="Topic category"
              className="px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-slate-700 rounded-md text-slate-200"
            >
              <option value="engineering">Engineering</option>
              <option value="business">Business</option>
              <option value="custom">Custom</option>
            </select>
            <button
              type="submit"
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-500 whitespace-nowrap shrink-0"
            >
              Add Stream
            </button>
          </form>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2 font-medium">Topic</th>
                <th className="py-2 font-medium">Category</th>
                <th className="py-2 font-medium text-right">Interval</th>
                <th className="py-2 font-medium text-right">Ingested</th>
                <th className="py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {data.streams.map((s) => (
                <tr key={s.id} className="h-10">
                  <td className="py-2 text-slate-200 font-medium">{s.topic}</td>
                  <td className="py-2 text-slate-400">{s.category}</td>
                  <td className="py-2 text-right font-mono tabular-nums text-slate-400">{s.interval_minutes}m</td>
                  <td className="py-2 text-right font-mono tabular-nums text-slate-200">{s.items_ingested}</td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleToggleStream(s.id, s.enabled)}
                      className={`px-2.5 py-1 text-xs rounded-md font-medium whitespace-nowrap shrink-0 ${
                        s.enabled
                          ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                          : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {s.enabled ? 'Enabled' : 'Paused'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Memory Feed & Skill Registry */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-sm font-semibold text-slate-100">Long-Term Memory Feed</h2>
            <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded-lg">
              {(['all', 'semantic', 'procedural', 'episodic'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setMemoryFilter(t)}
                  className={`px-2.5 py-1 text-xs rounded-md font-medium capitalize transition-colors ${
                    memoryFilter === t ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-slate-800/70">
            {displayedMemories.slice(0, 12).map((m) => (
              <article key={m.id} className="py-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium text-slate-100">{m.title}</h3>
                  <span className="text-xs text-slate-400 font-mono shrink-0">
                    {m.memory_type} · rel {m.reliability_score}
                  </span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">{m.content}</p>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>{m.topic}</span>
                  {m.source_url && (
                    <>
                      <span aria-hidden="true">·</span>
                      <a
                        href={m.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-400 hover:underline truncate max-w-xs"
                      >
                        {m.source_url}
                      </a>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
          <h2 className="font-display text-sm font-semibold text-slate-100">Skill & Pattern Registry</h2>
          <div className="divide-y divide-slate-800/70">
            {data.skills.map((skill) => (
              <div key={skill.id} className="py-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-100">{skill.title}</span>
                  <span className="text-xs font-mono text-blue-400 shrink-0">v{skill.version}</span>
                </div>
                <p className="text-xs text-slate-500">{skill.domain}</p>
                <pre className="p-2.5 rounded bg-[#0B0F17] border border-slate-800 text-[11px] font-mono text-slate-300 whitespace-pre-wrap leading-relaxed">
                  {skill.content.slice(0, 260)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
