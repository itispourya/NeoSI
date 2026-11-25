import { useState } from 'react';
import { apiFetch, streamChat } from '../lib/api';

type WorkbenchTab = 'chat' | 'reason' | 'business' | 'engineer';

export function WorkbenchView() {
  const [tab, setTab] = useState<WorkbenchTab>('chat');
  const [message, setMessage] = useState('Analyze double-entry ledger balance and explain how Neo prevents prompt injection.');
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [language, setLanguage] = useState<'en' | 'fa' | 'ar' | 'nl'>('en');
  const [streamOut, setStreamOut] = useState('');
  const [streamMeta, setStreamMeta] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [reasonOut, setReasonOut] = useState<Record<string, unknown> | null>(null);
  const [bizOut, setBizOut] = useState<Record<string, unknown> | null>(null);
  const [engOut, setEngOut] = useState<Record<string, unknown> | null>(null);
  const [engTask, setEngTask] = useState('Deduplicate an array of numbers preserving order');
  const [error, setError] = useState<string | null>(null);

  const runChat = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setStreamOut('');
    try {
      await streamChat(
        { message, conversationId, language },
        {
          onMeta: (m) => {
            if (m.conversationId) setConversationId(m.conversationId);
            setStreamMeta(`lang=${m.language} · rag=${m.ragMatches} · engine=${m.engine || 'neo'}`);
          },
          onDelta: (chunk) => setStreamOut((prev) => prev + chunk),
          onDone: (d) => {
            setStreamMeta((prev) => `${prev || ''} · model=${String(d.model || 'neo')} · ${String(d.latencyMs || 0)}ms`);
          },
          onError: (msg) => setError(msg),
        }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chat stream failed');
    } finally {
      setLoading(false);
    }
  };

  const runReason = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<Record<string, unknown>>('/api/v1/reason', {
        method: 'POST',
        body: JSON.stringify({ query: message, language, autonomy: 'balanced' }),
      });
      setReasonOut(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reasoning failed');
    } finally {
      setLoading(false);
    }
  };

  const runBusinessAudit = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<Record<string, unknown>>('/api/v1/business/analyze', {
        method: 'POST',
        body: JSON.stringify({
          workspaceName: 'Neos Operations',
          language,
          question: 'Audit ledger balance, cash runway, LTV:CAC, and inventory stockout risk.',
          accounting: {
            cashBalance: 96000,
            currentAssets: 145000,
            currentLiabilities: 90000,
            monthlyRevenue: 54000,
            monthlyExpenses: 66000,
            ledgerEntries: [
              { id: 'J-1', account: 'Cash', debit: 12000, credit: 0 },
              { id: 'J-2', account: 'Revenue', debit: 0, credit: 11750 },
            ],
          },
          crm: { newCustomers: 20, churnedCustomers: 3, totalActiveCustomers: 120, marketingSpend: 8000, salesSpend: 4000, avgOrderValue: 450, grossMarginPct: 72 },
          inventory: [{ sku: 'NEOS-101', onHand: 4, avgDailySales: 3, leadTimeDays: 6, unitCost: 22, unitPrice: 58 }],
        }),
      });
      setBizOut(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Business audit failed');
    } finally {
      setLoading(false);
    }
  };

  const runEngineer = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<Record<string, unknown>>('/api/v1/engineer/task', {
        method: 'POST',
        body: JSON.stringify({ task: engTask, stack: 'TypeScript / Node.js' }),
      });
      setEngOut(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Engineer task failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-3">
        {(
          [
            ['chat', 'Streaming Chat'],
            ['reason', '13-Stage Reasoning'],
            ['business', 'Neos Business Audit'],
            ['engineer', 'Autonomous Engineer'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap ${
              tab === id ? 'bg-blue-600 text-white' : 'bg-[#111827] border border-slate-800 text-slate-300 hover:bg-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="p-3 rounded bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">{error}</div>}

      {tab === 'chat' && (
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <form onSubmit={runChat} className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-slate-300 font-medium">Persistent SSE Conversation {conversationId ? `(${conversationId.slice(0, 8)})` : ''}</div>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as 'en' | 'fa' | 'ar' | 'nl')}
                className="px-2.5 py-1 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-200"
              >
                <option value="en">English (en)</option>
                <option value="fa">Persian (fa)</option>
                <option value="ar">Arabic (ar)</option>
                <option value="nl">Dutch (nl)</option>
              </select>
            </div>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className="w-full p-3 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100 focus:outline-none focus:border-blue-500"
            />
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap"
            >
              {loading ? 'Streaming...' : 'Send to Neo'}
            </button>
          </form>
          {streamMeta && <div className="font-mono text-[11px] text-slate-400">{streamMeta}</div>}
          {streamOut && (
            <pre className="p-4 bg-[#0B0F17] border border-slate-800 rounded text-xs font-mono text-slate-200 whitespace-pre-wrap">
              {streamOut}
            </pre>
          )}
        </div>
      )}

      {tab === 'reason' && (
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <div className="flex gap-3">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="flex-1 px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100"
            />
            <button
              type="button"
              onClick={() => void runReason()}
              disabled={loading}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap shrink-0"
            >
              {loading ? 'Reasoning...' : 'Run 13-Stage Reasoning'}
            </button>
          </div>
          {reasonOut && (
            <pre className="p-4 bg-[#0B0F17] border border-slate-800 rounded text-[11px] font-mono text-slate-200 whitespace-pre-wrap max-h-96 overflow-y-auto">
              {JSON.stringify(reasonOut, null, 2)}
            </pre>
          )}
        </div>
      )}

      {tab === 'business' && (
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="text-xs text-slate-300">Runs deterministic double-entry, Z-score anomaly, LTV:CAC, and inventory reorder audit + sovereign synthesis.</div>
            <button
              type="button"
              onClick={() => void runBusinessAudit()}
              disabled={loading}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap shrink-0"
            >
              {loading ? 'Auditing...' : 'Run Sample Business Audit'}
            </button>
          </div>
          {bizOut && (
            <pre className="p-4 bg-[#0B0F17] border border-slate-800 rounded text-[11px] font-mono text-slate-200 whitespace-pre-wrap max-h-96 overflow-y-auto">
              {JSON.stringify(bizOut, null, 2)}
            </pre>
          )}
        </div>
      )}

      {tab === 'engineer' && (
        <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-4">
          <div className="flex gap-3">
            <input
              type="text"
              value={engTask}
              onChange={(e) => setEngTask(e.target.value)}
              className="flex-1 px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100"
            />
            <button
              type="button"
              onClick={() => void runEngineer()}
              disabled={loading}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap shrink-0"
            >
              {loading ? 'Coding & Testing...' : 'Run Engineer Loop'}
            </button>
          </div>
          {engOut && (
            <pre className="p-4 bg-[#0B0F17] border border-slate-800 rounded text-[11px] font-mono text-slate-200 whitespace-pre-wrap max-h-96 overflow-y-auto">
              {JSON.stringify(engOut, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
