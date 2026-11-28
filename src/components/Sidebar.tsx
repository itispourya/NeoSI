import {
  Activity,
  Brain,
  Cpu,
  GitBranch,
  KeyRound,
  ListChecks,
  MessageSquare,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import type { NavSection } from '../types/neo';

interface SidebarProps {
  activeSection: NavSection;
  onSelect: (section: NavSection) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: Array<{ id: NavSection; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'chat', label: 'Chatbot', icon: MessageSquare },
  { id: 'tasks', label: 'Agent Tasks', icon: ListChecks },
  { id: 'workbench', label: 'Cognitive Lab', icon: Terminal },
  { id: 'memory', label: 'Memory & Graph', icon: Brain },
  { id: 'models', label: 'Models & Bench', icon: Cpu },
  { id: 'tools', label: 'Tools & Forge', icon: Wrench },
  { id: 'evolution', label: 'Self-Evolution', icon: GitBranch },
  { id: 'security', label: 'Security & Keys', icon: KeyRound },
];

export function Sidebar({ activeSection, onSelect, mobileOpen, onCloseMobile }: SidebarProps) {
  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 lg:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-[#0D131F] border-r border-slate-800 flex flex-col transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-16 px-5 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-blue-600/15 border border-blue-500/40 flex items-center justify-center text-blue-400 font-display font-bold text-sm">
              N
            </div>
            <div>
              <div className="font-display text-sm font-semibold text-slate-100 tracking-tight">NEO CORE</div>
              <div className="text-[11px] font-mono text-slate-400">Sovereign OS v2</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onCloseMobile}
            className="lg:hidden p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto" aria-label="Neo control plane sections">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelect(item.id);
                  onCloseMobile();
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded text-left text-xs font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-blue-600/15 text-blue-300 border border-blue-500/30'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 text-[11px] font-mono text-slate-400 space-y-1">
          <div className="text-slate-300">Runtime Isolation</div>
          <div>0 External Cloud AI Keys</div>
          <div>Subprocess / Docker Sandbox</div>
        </div>
      </aside>
    </>
  );
}
