import { useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AdminOverviewPayload, MemoryInfo, MemoryLayerType } from '../types/neo';

interface MemoryGraphViewProps {
  data: AdminOverviewPayload;
  onRefresh: () => Promise<void>;
}

const LAYERS: MemoryLayerType[] = ['semantic', 'procedural', 'episodic', 'working', 'personal', 'organizational', 'temporal'];

function safeCitationUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function MemoryGraphView({ data, onRefresh }: MemoryGraphViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLayer, setSelectedLayer] = useState<string>('all');
  const [searchResults, setSearchResults] = useState<MemoryInfo[] | null>(null);

  const [memType, setMemType] = useState<MemoryLayerType>('semantic');
  const [memTopic, setMemTopic] = useState('architecture');
  const [memTitle, setMemTitle] = useState('');
  const [memContent, setMemContent] = useState('');

  const [researchQuery, setResearchQuery] = useState('PostgreSQL pgvector indexing benchmarks');
  const [ingestUrl, setIngestUrl] = useState('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatusMsg(null);
    try {
      const params = new URLSearchParams({ q: searchQuery, limit: '20' });
      if (selectedLayer !== 'all') params.set('type', selectedLayer);
      const res = await apiFetch<{ matches: MemoryInfo[] }>(`/api/v1/memory/search?${params.toString()}`);
      setSearchResults(res.matches);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Memory search failed');
    } finally {
      setBusy(false);
    }
  };

  const addMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatusMsg(null);
    try {
      await apiFetch('/api/v1/memory', {
        method: 'POST',
        body: JSON.stringify({ memoryType: memType, topic: memTopic, title: memTitle, content: memContent }),
      });
      setMemTitle('');
      setMemContent('');
      setStatusMsg(`Stored ${memType} memory successfully.`);
      await onRefresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Store failed');
    } finally {
      setBusy(false);
    }
  };

  const consolidate = async () => {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await apiFetch<{ consolidatedSemantic: number; prunedExpiredWorking: number; contradictionsDetected: number }>(
        '/api/v1/memory/consolidate',
        { method: 'POST', body: '{}' }
      );
      setStatusMsg(
        `Consolidated ${res.consolidatedSemantic} semantic pattern(s), pruned ${res.prunedExpiredWorking} stale working item(s), flagged ${res.contradictionsDetected} contradiction(s).`
      );
      await onRefresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Memory consolidation failed');
    } finally {
      setBusy(false);
    }
  };

  const reindexEmbeddings = async () => {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await apiFetch<{ totalScanned: number; reindexed: number; targetModel: string; targetDim: number }>(
        '/api/v1/memory/reindex',
        { method: 'POST', body: JSON.stringify({ force: false }) }
      );
      setStatusMsg(
        `Scanned ${res.totalScanned} memories for ${res.targetModel} (${res.targetDim}d): re-indexed ${res.reindexed} record(s).`
      );
      await onRefresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Re-index failed');
    } finally {
      setBusy(false);
    }
  };

  const deleteMemoryItem = async (id: string) => {
    setBusy(true);
    setStatusMsg(null);
    try {
      await apiFetch(`/api/v1/memory/${id}`, { method: 'DELETE' });
      setSearchResults((prev) => (prev ? prev.filter((item) => item.id !== id) : null));
      await onRefresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const runResearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatusMsg(null);
    try {
      const urls = ingestUrl.trim() ? [ingestUrl.trim()] : undefined;
      const res = await apiFetch<{ report: { id: string; citations: unknown[]; confidence: number } }>('/api/v1/research', {
        method: 'POST',
        body: JSON.stringify({ query: researchQuery, urls }),
      });
      setStatusMsg(`Research report ${res.report.id.slice(0, 8)} completed (${res.report.citations.length} citations, confidence ${res.report.confidence}).`);
      await onRefresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Research failed');
    } finally {
      setBusy(false);
    }
  };

  const evaluateSkill = async (id: string) => {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await apiFetch<{ score: number; passed: boolean }>(`/api/v1/skills/${id}/evaluate`, {
        method: 'POST',
        body: '{}',
      });
      setStatusMsg(`Skill evaluated: score ${res.score}% (${res.passed ? 'passed' : 'needs review'})`);
      await onRefresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Skill evaluation failed');
    } finally {
      setBusy(false);
    }
  };

  const shownMemories = (searchResults ?? data.recentMemories).filter(
    (m) => selectedLayer === 'all' || m.memory_type === selectedLayer
  );

  return (
    <div className="space-y-6">
      {statusMsg && (
        <div className="p-3 rounded bg-blue-500/10 border border-blue-500/30 text-xs text-blue-200">{statusMsg}</div>
      )}

      {/* Search + Consolidate + Store */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-slate-100">7-Layer Hybrid RAG Search</h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void reindexEmbeddings()}
                disabled={busy}
                className="px-2.5 py-1 rounded border border-slate-700 bg-[#0B0F17] hover:bg-slate-800 text-[11px] text-slate-300 whitespace-nowrap shrink-0"
              >
                Re-index
              </button>
              <button
                type="button"
                onClick={() => void consolidate()}
                disabled={busy}
                className="px-3 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-200 whitespace-nowrap shrink-0"
              >
                Run Consolidation
              </button>
            </div>
          </div>
          <form onSubmit={runSearch} className="flex gap-2">
            <select
              value={selectedLayer}
              onChange={(e) => setSelectedLayer(e.target.value)}
              className="px-2.5 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-200"
            >
              <option value="all">All Layers</option>
              {LAYERS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Query vector + BM25 memory..."
              className="flex-1 px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs text-white whitespace-nowrap shrink-0"
            >
              Search
            </button>
          </form>

          <div className="divide-y divide-slate-800/80 max-h-72 overflow-y-auto">
            {shownMemories.slice(0, 15).map((m) => (
              <div key={m.id} className="py-2.5 text-xs space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-100 truncate">{m.title}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-[11px] text-slate-400">
                      {m.memory_type} · rel:{m.reliability_score}
                    </span>
                    <button
                      type="button"
                      onClick={() => void deleteMemoryItem(m.id)}
                      disabled={busy}
                      className="text-[11px] font-mono text-rose-400 hover:text-rose-300 whitespace-nowrap"
                    >
                      Del
                    </button>
                  </div>
                </div>
                <p className="text-slate-400 line-clamp-2">{m.content}</p>
              </div>
            ))}
          </div>
        </div>

        <form onSubmit={addMemory} className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
          <h2 className="font-display text-sm font-semibold text-slate-100">Store Structured Memory</h2>
          <div className="grid grid-cols-2 gap-3">
            <select
              value={memType}
              onChange={(e) => setMemType(e.target.value as MemoryLayerType)}
              className="px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-200"
            >
              {LAYERS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
            <input
              type="text"
              value={memTopic}
              onChange={(e) => setMemTopic(e.target.value)}
              placeholder="Topic"
              required
              className="px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100"
            />
          </div>
          <input
            type="text"
            value={memTitle}
            onChange={(e) => setMemTitle(e.target.value)}
            placeholder="Concise memory title"
            required
            className="w-full px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100"
          />
          <textarea
            value={memContent}
            onChange={(e) => setMemContent(e.target.value)}
            rows={4}
            placeholder="Verified knowledge, procedural invariant, or temporal fact..."
            required
            className="w-full p-3 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100"
          />
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap"
          >
            Commit to Memory
          </button>
        </form>
      </div>

      {/* Autonomous 16-stage Research & Knowledge Graph */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <h2 className="font-display text-sm font-semibold text-slate-100">16-Stage Autonomous Research Pipeline</h2>
          <form onSubmit={runResearch} className="space-y-3">
            <input
              type="text"
              value={researchQuery}
              onChange={(e) => setResearchQuery(e.target.value)}
              placeholder="Research question..."
              required
              className="w-full px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100"
            />
            <div className="flex gap-2">
              <input
                type="url"
                value={ingestUrl}
                onChange={(e) => setIngestUrl(e.target.value)}
                placeholder="Optional public HTTPS URL to verify..."
                className="flex-1 px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100"
              />
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap shrink-0"
              >
                Run Research
              </button>
            </div>
          </form>
          <div className="divide-y divide-slate-800/80 max-h-56 overflow-y-auto">
            {data.researchReports.map((r) => (
              <div key={r.id} className="py-2.5 text-xs space-y-1">
                <div className="flex justify-between gap-2">
                  <span className="text-slate-200 font-medium truncate">{r.query}</span>
                  <span className="font-mono text-[11px] text-slate-400 shrink-0">
                    conf:{r.confidence} · {r.citations.length} cit
                  </span>
                </div>
                <p className="text-slate-400 line-clamp-2">{r.summary}</p>
                {r.citations.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-0.5">
                    {r.citations.slice(0, 3).map((cit, idx) => {
                      const href = safeCitationUrl(cit.url);
                      return href ? (
                        <a
                          key={idx}
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] font-mono text-blue-400 hover:text-blue-300 truncate max-w-[200px]"
                        >
                          [{idx + 1}] {cit.title || href}
                        </a>
                      ) : null;
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Knowledge Graph ({data.graph.entities.length} Entities · {data.graph.relationships.length} Edges)
          </h2>
          <div className="grid grid-cols-2 gap-2 max-h-36 overflow-y-auto">
            {data.graph.entities.slice(0, 14).map((e) => (
              <div key={e.id} className="bg-[#0B0F17] border border-slate-800 rounded px-2.5 py-1.5 text-xs flex justify-between gap-2">
                <span className="text-slate-200 truncate">{e.name}</span>
                <span className="font-mono text-[10px] text-slate-400 shrink-0">{e.entity_type}</span>
              </div>
            ))}
          </div>

          {data.graph.relationships.length > 0 && (
            <div className="bg-[#0B0F17] border border-slate-800 rounded p-2.5 max-h-28 overflow-y-auto space-y-1 font-mono text-[11px]">
              {data.graph.relationships.slice(0, 8).map((rel) => {
                const src = data.graph.entities.find((e) => e.id === rel.source_entity_id)?.name || rel.source_entity_id.slice(0, 8);
                const tgt = data.graph.entities.find((e) => e.id === rel.target_entity_id)?.name || rel.target_entity_id.slice(0, 8);
                return (
                  <div key={rel.id} className="flex items-center justify-between gap-2 text-slate-300">
                    <span className="truncate">
                      {src} <span className="text-blue-400">[{rel.relation_type}]</span> {tgt}
                    </span>
                    {rel.contradicts_id && <span className="text-amber-400 shrink-0">conflict</span>}
                  </div>
                );
              })}
            </div>
          )}

          <h3 className="font-display text-xs font-semibold text-slate-300 pt-2 border-t border-slate-800">
            Procedural Skills Registry ({data.skills.length})
          </h3>
          <div className="divide-y divide-slate-800/80 max-h-40 overflow-y-auto">
            {data.skills.map((s) => (
              <div key={s.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <div className="text-slate-200 truncate">{s.title}</div>
                  <div className="font-mono text-[11px] text-slate-400">v{s.version} · {s.domain}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void evaluateSkill(s.id)}
                  className="px-2.5 py-1 rounded border border-slate-700 hover:bg-slate-800 text-[11px] text-slate-300 whitespace-nowrap shrink-0"
                >
                  Evaluate
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
