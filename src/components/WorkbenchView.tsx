import { useState } from 'react';
import { apiFetch, streamChat } from '../lib/api';

type WorkbenchTab = 'chat' | 'business' | 'engineer';

const SAMPLE_BUSINESS_PAYLOAD = {
  workspaceName: 'Neos Retail & SaaS Holdings',
  language: 'en',
  question: 'Identify root causes connecting our Q4 POS drop, inventory stockouts, and cash runway.',
  accounting: {
    cashBalance: 145000,
    currentAssets: 220000,
    currentLiabilities: 110000,
    monthlyRevenue: 58000,
    monthlyExpenses: 79000,
    ledgerEntries: [
      { id: 'JE-101', account: 'Cash', debit: 18500, credit: 0 },
      { id: 'JE-102', account: 'Deferred Revenue', debit: 0, credit: 18500 },
      { id: 'JE-103', account: 'Cloud Infrastructure', debit: 14200, credit: 0 },
      { id: 'JE-104', account: 'Accounts Payable', debit: 0, credit: 14200 },
    ],
  },
  crm: {
    newCustomers: 28,
    churnedCustomers: 9,
    totalActiveCustomers: 210,
    marketingSpend: 8400,
    salesSpend: 4200,
    avgOrderValue: 410,
    grossMarginPct: 74,
    pipelineValue: 190000,
    wonDealsValue: 54000,
  },
  inventory: [
    { sku: 'POS-TERM-X2', name: 'Smart POS Terminal', onHand: 8, avgDailySales: 3.5, leadTimeDays: 10, unitCost: 140, unitPrice: 320, daysSinceLastSale: 1 },
    { sku: 'DOCK-LEGACY-V1', name: 'Legacy Dock v1', onHand: 120, avgDailySales: 0, leadTimeDays: 14, unitCost: 35, unitPrice: 75, daysSinceLastSale: 112 },
  ],
};

export function WorkbenchView() {
  const [tab, setTab] = useState<WorkbenchTab>('chat');

  // Chat state
  const [chatLang, setChatLang] = useState<'en' | 'fa' | 'ar' | 'nl'>('en');
  const [chatMode, setChatMode] = useState<'sovereign-local' | 'neural'>('sovereign-local');
  const [chatInput, setChatInput] = useState('');
  const [chatOutput, setChatOutput] = useState('');
  const [chatMeta, setChatMeta] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);

  // Business state
  const [bizPayload, setBizPayload] = useState(JSON.stringify(SAMPLE_BUSINESS_PAYLOAD, null, 2));
  const [bizResult, setBizResult] = useState<Record<string, unknown> | null>(null);
  const [bizLoading, setBizLoading] = useState(false);
  const [bizError, setBizError] = useState<string | null>(null);

  // Engineer state
  const [engTask, setEngTask] = useState(
    'Write a double-entry journal validator that accepts an array of { debit, credit } entries, detects imbalance beyond 0.01, and returns totalDebits, totalCredits, and balanced boolean.'
  );
  const [engResult, setEngResult] = useState<{
    plan: string[];
    architectureNotes: string;
    code: string;
    tests: string;
    iterations: number;
    verified: boolean;
    testReport: { passed: number; failed: number; total: number; durationMs: number; details: string[] };
  } | null>(null);
  const [engLoading, setEngLoading] = useState(false);
  const [engError, setEngError] = useState<string | null>(null);

  const handleChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    setStreaming(true);
    setChatOutput('');
    setChatMeta(null);
    try {
      await streamChat(
        { message: chatInput.trim(), language: chatLang, mode: chatMode },
        {
          onMeta: (m) => setChatMeta(`engine=${m.engine || chatMode} · lang=${m.language} · ragMatches=${m.ragMatches}`),
          onDelta: (chunk) => setChatOutput((prev) => prev + chunk),
          onDone: (d) =>
            setChatMeta((prev) => `${prev || ''} · ${d.model || 'neo-core'} (${d.latencyMs || 0}ms)`),
          onError: (err) => setChatOutput(`Error: ${err}`),
        }
      );
    } catch (err) {
      setChatOutput(`Error: ${err instanceof Error ? err.message : 'Stream failed'}`);
    } finally {
      setStreaming(false);
    }
  };

  const handleAnalyzeBusiness = async () => {
    setBizLoading(true);
    setBizError(null);
    try {
      const parsed = JSON.parse(bizPayload);
      const res = await apiFetch<Record<string, unknown>>('/api/v1/business/analyze', {
        method: 'POST',
        body: JSON.stringify(parsed),
      });
      setBizResult(res);
    } catch (err) {
      setBizError(err instanceof Error ? err.message : 'Business audit failed');
    } finally {
      setBizLoading(false);
    }
  };

  const handleRunEngineer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!engTask.trim()) return;
    setEngLoading(true);
    setEngError(null);
    try {
      const res = await apiFetch<typeof engResult>('/api/v1/engineer/task', {
        method: 'POST',
        body: JSON.stringify({ task: engTask.trim(), stack: 'TypeScript / Node.js' }),
      });
      setEngResult(res);
    } catch (err) {
      setEngError(err instanceof Error ? err.message : 'Engineering task failed');
    } finally {
      setEngLoading(false);
    }
  };

  const isRtl = chatLang === 'fa' || chatLang === 'ar';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-[#111827] border border-slate-800 rounded-lg">
          {(
            [
              { id: 'chat', label: 'Multilingual Stream' },
              { id: 'business', label: 'Business Intelligence' },
              { id: 'engineer', label: 'Autonomous Engineer' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                tab === item.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'chat' && (
        <section className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-100">
                Context-Aware Streaming Assistant (SSE)
              </h2>
              <p className="text-xs text-slate-400">
                Retrieves Episodic/Semantic/Procedural RAG memory and responds natively in English, Persian, Arabic, or Dutch.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <label htmlFor="chat-mode-select" className="text-xs text-slate-400">Engine</label>
                <select
                  id="chat-mode-select"
                  value={chatMode}
                  onChange={(e) => setChatMode(e.target.value as 'sovereign-local' | 'neural')}
                  className="px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-slate-700 rounded-md text-slate-100"
                >
                  <option value="sovereign-local">Neo Autonomous (Local)</option>
                  <option value="neural">Neo Neural (Accelerated)</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="chat-lang-select" className="text-xs text-slate-400">Language</label>
                <select
                  id="chat-lang-select"
                  value={chatLang}
                  onChange={(e) => setChatLang(e.target.value as 'en' | 'fa' | 'ar' | 'nl')}
                  className="px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-slate-700 rounded-md text-slate-100"
                >
                  <option value="en">English (en)</option>
                  <option value="fa">Persian (fa)</option>
                  <option value="ar">Arabic (ar)</option>
                  <option value="nl">Dutch (nl)</option>
                </select>
              </div>
            </div>
          </div>

          <form onSubmit={handleChatSubmit} className="space-y-3">
            <textarea
              rows={3}
              dir={isRtl ? 'rtl' : 'ltr'}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={
                chatLang === 'fa'
                  ? 'سوال فنی یا مالی خود را برای Neos از Neo بپرسید...'
                  : chatLang === 'ar'
                  ? 'اطرح سؤالك التقني أو المالي لنظام Neos على Neo...'
                  : chatLang === 'nl'
                  ? 'Stel uw technische of financiele vraag voor Neos aan Neo...'
                  : 'Ask Neo about architecture, accounting anomalies, or Neos operations...'
              }
              className="w-full p-3 rounded-lg bg-[#0B0F17] border border-slate-700 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-slate-400">{chatMeta || 'Ready'}</span>
              <button
                type="submit"
                disabled={streaming || !chatInput.trim()}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {streaming ? 'Streaming...' : 'Send Stream'}
              </button>
            </div>
          </form>

          {chatOutput && (
            <div
              dir={isRtl ? 'rtl' : 'ltr'}
              className="p-4 rounded-lg bg-[#0B0F17] border border-slate-800 text-sm text-slate-200 whitespace-pre-wrap leading-relaxed"
            >
              {chatOutput}
            </div>
          )}
        </section>
      )}

      {tab === 'business' && (
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-100">Neos Multi-Module Payload</h2>
              <button
                type="button"
                onClick={handleAnalyzeBusiness}
                disabled={bizLoading}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {bizLoading ? 'Auditing...' : 'Run Business Audit'}
              </button>
            </div>
            <textarea
              rows={18}
              value={bizPayload}
              onChange={(e) => setBizPayload(e.target.value)}
              aria-label="Business JSON payload"
              className="w-full p-3 rounded-lg bg-[#0B0F17] border border-slate-700 text-xs font-mono text-slate-200 focus:outline-none focus:border-blue-500"
            />
            {bizError && <p className="text-xs text-rose-400">{bizError}</p>}
          </div>

          <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
            <h2 className="font-display text-sm font-semibold text-slate-100">Executive Audit Output</h2>
            <pre className="p-3 rounded-lg bg-[#0B0F17] border border-slate-800 text-xs font-mono text-slate-200 overflow-auto max-h-[430px] whitespace-pre-wrap">
              {bizResult
                ? JSON.stringify(bizResult, null, 2)
                : '// Submit a Neos accounting, CRM, and inventory payload to compute deterministic ratios, stockout risks, and executive root-cause briefings.'}
            </pre>
          </div>
        </section>
      )}

      {tab === 'engineer' && (
        <section className="space-y-6">
          <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Autonomous Software Engineer (Plan → Code → Test → Fix)
            </h2>
            <form onSubmit={handleRunEngineer} className="space-y-3">
              <textarea
                rows={3}
                value={engTask}
                onChange={(e) => setEngTask(e.target.value)}
                aria-label="Engineering task prompt"
                className="w-full p-3 rounded-lg bg-[#0B0F17] border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                disabled={engLoading}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {engLoading ? 'Iterating in Sandbox...' : 'Execute Engineering Loop'}
              </button>
            </form>
            {engError && <p className="text-xs text-rose-400">{engError}</p>}
          </div>

          {engResult && (
            <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                <span className={`text-xs font-medium ${engResult.verified ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {engResult.verified ? 'Verified 100% Pass' : 'Partial Pass'} · {engResult.iterations} iteration(s)
                </span>
                <span className="text-xs font-mono text-slate-400 tabular-nums">
                  {engResult.testReport.passed}/{engResult.testReport.total} tests · {engResult.testReport.durationMs}ms
                </span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <p className="text-xs font-medium text-slate-400">Generated Implementation</p>
                  <pre className="p-3 rounded-md bg-[#0B0F17] border border-slate-800 text-xs font-mono text-slate-200 overflow-auto max-h-64">
                    {engResult.code}
                  </pre>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium text-slate-400">Automated Sandbox Tests & Output</p>
                  <pre className="p-3 rounded-md bg-[#0B0F17] border border-slate-800 text-xs font-mono text-emerald-300 overflow-auto max-h-64">
                    {`${engResult.testReport.details.join('\n')}\n\n${engResult.tests}`}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
