import { useCallback, useEffect, useState } from 'react';
import { EvolutionView } from './components/EvolutionView';
import { MemoryGraphView } from './components/MemoryGraphView';
import { ModelsView } from './components/ModelsView';
import { OverviewView } from './components/OverviewView';
import { SecurityView } from './components/SecurityView';
import { Sidebar } from './components/Sidebar';
import { TasksView } from './components/TasksView';
import { ToolsForgeView } from './components/ToolsForgeView';
import { TopBar } from './components/TopBar';
import { WorkbenchView } from './components/WorkbenchView';
import { apiFetch, getAdminToken, setAdminToken } from './lib/api';
import type { AdminOverviewPayload, NavSection } from './types/neo';

export default function App() {
  const [section, setSection] = useState<NavSection>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [data, setData] = useState<AdminOverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [lockSource, setLockSource] = useState<'env' | 'claimed' | 'unclaimed' | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await apiFetch<{ locked: boolean; source: 'env' | 'claimed' | 'unclaimed' }>('/api/admin/auth/status');
      setLockSource(status.source);

      if (!getAdminToken()) {
        setAuthRequired(true);
        setLoading(false);
        return;
      }

      const payload = await apiFetch<AdminOverviewPayload>('/api/admin/overview');
      setData(payload);
      setAuthRequired(false);
    } catch (err) {
      const e = err as Error & { authRequired?: boolean };
      if (e.authRequired) {
        setAdminToken(null);
        setAuthRequired(true);
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const endpoint = lockSource === 'unclaimed' ? '/api/admin/auth/claim' : '/api/admin/auth/login';
      const res = await apiFetch<{ token: string }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ passcode }),
      });
      setAdminToken(res.token);
      setPasscode('');
      setAuthRequired(false);
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    }
  };

  if (authRequired) {
    const isClaim = lockSource === 'unclaimed';
    return (
      <div className="min-h-screen bg-[#0B0F17] flex items-center justify-center p-6">
        <form
          onSubmit={handleAuthSubmit}
          className="w-full max-w-sm bg-[#111827] border border-slate-800 rounded-lg p-6 space-y-4"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-blue-600/15 border border-blue-500/40 flex items-center justify-center text-blue-400 font-display font-bold text-sm">
              N
            </div>
            <div>
              <h1 className="font-display text-base font-semibold text-slate-100">
                {isClaim ? 'Initialize Neo Admin Passcode' : 'Neo Control Plane'}
              </h1>
              <p className="text-[11px] font-mono text-slate-400">
                {isClaim ? 'First-time console setup (min 8 chars)' : 'Enter admin passcode to authenticate'}
              </p>
            </div>
          </div>

          <input
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder={isClaim ? 'Choose admin passcode (min 8 chars)' : 'Admin passcode'}
            aria-label="Admin passcode"
            required
            minLength={isClaim ? 8 : 1}
            className="w-full px-3 py-2 text-sm bg-[#0B0F17] border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-blue-500"
          />
          {error && <p className="text-xs text-rose-400">{error}</p>}
          <button
            type="submit"
            className="w-full px-4 py-2 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-500 whitespace-nowrap"
          >
            {isClaim ? 'Claim Passcode & Unlock' : 'Unlock Console'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex">
      <Sidebar
        activeSection={section}
        onSelect={setSection}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          section={section}
          storageMode={data?.subsystems.storage}
          runtimeDefault={data?.subsystems.runtimeDefault}
          lockStatus={data?.lockState.source}
          loading={loading}
          onRefresh={loadOverview}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />

        <main className="flex-1 p-4 lg:p-8 max-w-7xl w-full mx-auto">
          {error && (
            <div className="mb-6 p-4 rounded bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {error}
            </div>
          )}

          {!data && loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-28 rounded bg-[#111827] border border-slate-800/80 animate-pulse" />
              ))}
            </div>
          ) : data ? (
            <>
              {section === 'overview' && <OverviewView data={data} onNavigate={setSection} />}
              {section === 'tasks' && <TasksView data={data} onRefresh={loadOverview} />}
              {section === 'workbench' && <WorkbenchView />}
              {section === 'memory' && <MemoryGraphView data={data} onRefresh={loadOverview} />}
              {section === 'models' && <ModelsView data={data} onRefresh={loadOverview} />}
              {section === 'tools' && <ToolsForgeView data={data} onRefresh={loadOverview} />}
              {section === 'evolution' && <EvolutionView data={data} onRefresh={loadOverview} />}
              {section === 'security' && <SecurityView data={data} onRefresh={loadOverview} />}
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
