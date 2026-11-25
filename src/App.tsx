import { useCallback, useEffect, useState } from 'react';
import { ForgeView } from './components/ForgeView';
import { KnowledgeView } from './components/KnowledgeView';
import { OverviewView } from './components/OverviewView';
import { SecurityView } from './components/SecurityView';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { UpgradesView } from './components/UpgradesView';
import { WorkbenchView } from './components/WorkbenchView';
import { apiFetch, setAdminToken } from './lib/api';
import type { AdminOverviewPayload, NavSection } from './types/neo';

export default function App() {
  const [section, setSection] = useState<NavSection>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [data, setData] = useState<AdminOverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [loginPasscode, setLoginPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await apiFetch<AdminOverviewPayload>('/api/admin/overview');
      setData(payload);
      setAuthRequired(false);
    } catch (err) {
      const e = err as Error & { authRequired?: boolean };
      if (e.authRequired) {
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

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<{ token: string }>('/api/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ passcode: loginPasscode }),
      });
      setAdminToken(res.token);
      setLoginPasscode('');
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    }
  };

  if (authRequired) {
    return (
      <div className="min-h-screen bg-[#0B0F17] flex items-center justify-center p-6">
        <form
          onSubmit={handleUnlock}
          className="w-full max-w-sm bg-[#111827] border border-slate-800 rounded-lg p-6 space-y-4"
        >
          <h1 className="font-display text-lg font-semibold text-slate-100">Neo Admin Console</h1>
          <p className="text-xs text-slate-400">Enter your admin passcode to unlock telemetry and controls.</p>
          <input
            type="password"
            value={loginPasscode}
            onChange={(e) => setLoginPasscode(e.target.value)}
            placeholder="Admin passcode"
            aria-label="Admin passcode"
            className="w-full px-3 py-2 text-sm bg-[#0B0F17] border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-blue-500"
          />
          {error && <p className="text-xs text-rose-400">{error}</p>}
          <button
            type="submit"
            className="w-full px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500"
          >
            Unlock Console
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
          storageMode={data?.providers.storage}
          lockStatus={data?.lockState.source}
          localOnlyMode={data?.providers.localOnlyMode}
          loading={loading}
          onRefresh={loadOverview}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />

        <main className="flex-1 p-4 lg:p-8 max-w-7xl w-full mx-auto">
          {error && (
            <div className="mb-6 p-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {error}
            </div>
          )}

          {!data && loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-28 rounded-lg bg-[#111827] border border-slate-800/80 animate-pulse" />
              ))}
            </div>
          ) : data ? (
            <>
              {section === 'overview' && <OverviewView data={data} onNavigate={setSection} />}
              {section === 'knowledge' && <KnowledgeView data={data} onRefresh={loadOverview} />}
              {section === 'upgrades' && <UpgradesView data={data} onRefresh={loadOverview} />}
              {section === 'forge' && <ForgeView data={data} onRefresh={loadOverview} />}
              {section === 'workbench' && <WorkbenchView />}
              {section === 'security' && <SecurityView data={data} onRefresh={loadOverview} />}
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
