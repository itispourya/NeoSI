import { Menu, RefreshCw } from 'lucide-react';
import type { NavSection } from '../types/neo';

interface TopBarProps {
  section: NavSection;
  storageMode?: string;
  lockStatus?: string;
  localOnlyMode?: boolean;
  loading: boolean;
  onRefresh: () => void;
  onOpenMobileNav: () => void;
}

const SECTION_TITLES: Record<NavSection, string> = {
  overview: 'Overview & Telemetry',
  knowledge: 'Knowledge Daemon & Memory',
  upgrades: 'Safe Self-Upgrade Pipeline',
  forge: 'Autonomous API Forge',
  workbench: 'Neos Brain & Engineer',
  security: 'Tenants, Keys & Security',
};

export function TopBar({
  section,
  storageMode,
  lockStatus,
  localOnlyMode,
  loading,
  onRefresh,
  onOpenMobileNav,
}: TopBarProps) {
  return (
    <header className="h-14 border-b border-slate-800/80 bg-[#0B0F17] px-4 lg:px-8 flex items-center justify-between gap-8 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation menu"
          className="lg:hidden p-2 -ml-2 text-slate-400 hover:text-slate-100 rounded-md"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-slate-500 whitespace-nowrap shrink-0">Neo</span>
          <span className="text-slate-600" aria-hidden="true">/</span>
          <h1 className="font-display font-semibold text-slate-100 truncate">
            {SECTION_TITLES[section]}
          </h1>
        </div>
      </div>

      <div className="hidden md:flex items-center gap-3 text-xs text-slate-400 whitespace-nowrap shrink-0">
        <span>Mode: {localOnlyMode ? 'Sovereign Local' : 'Autonomous Hybrid'}</span>
        {storageMode && <span aria-hidden="true">·</span>}
        {storageMode && <span>Storage: {storageMode}</span>}
        {storageMode && lockStatus && <span aria-hidden="true">·</span>}
        {lockStatus && <span>Access: {lockStatus}</span>}
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{loading ? 'Syncing' : 'Refresh Data'}</span>
        </button>
      </div>
    </header>
  );
}
