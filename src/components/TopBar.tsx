import { Menu, RefreshCw } from 'lucide-react';
import type { NavSection } from '../types/neo';

interface TopBarProps {
  section: NavSection;
  storageMode?: string;
  runtimeDefault?: string;
  lockStatus?: string;
  loading: boolean;
  onRefresh: () => void;
  onOpenMobileNav: () => void;
}

const SECTION_TITLES: Record<NavSection, string> = {
  overview: 'System Overview & Hardware Telemetry',
  chat: 'Neo Conversational Assistant',
  tasks: 'Durable Autonomous Agent Runtime',
  workbench: 'Cognitive Reasoning & Business Audit Lab',
  memory: '7-Layer Memory, Knowledge Graph & Research',
  models: 'Open-Weight Model Registry & Benchmarks',
  tools: 'Standardized Tool Registry, MCP & API Forge',
  evolution: '4-Layer Self-Evolution & Autonomous Scheduler',
  security: 'Tenant Isolation, API Keys & Audit Trail',
};

export function TopBar({
  section,
  storageMode,
  runtimeDefault,
  lockStatus,
  loading,
  onRefresh,
  onOpenMobileNav,
}: TopBarProps) {
  return (
    <header className="h-16 bg-[#0D131F] border-b border-slate-800 px-4 lg:px-8 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileNav}
          className="lg:hidden p-2 rounded border border-slate-800 text-slate-300 hover:bg-slate-800 shrink-0"
          aria-label="Open menu"
        >
          <Menu className="w-4 h-4" />
        </button>
        <div className="min-w-0">
          <h1 className="font-display text-sm lg:text-base font-semibold text-slate-100 truncate">
            {SECTION_TITLES[section]}
          </h1>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <div className="hidden md:flex items-center gap-3 text-[11px] font-mono text-slate-400">
          <span>DB: {storageMode || '...'}</span>
          <span>Runtime: {runtimeDefault || 'auto'}</span>
          <span>Auth: {lockStatus || 'locked'}</span>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded border border-slate-700 bg-slate-800/70 hover:bg-slate-800 text-xs font-medium text-slate-200 whitespace-nowrap shrink-0 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>
    </header>
  );
}
