import {
  Activity,
  BookOpen,
  Cpu,
  GitBranch,
  ShieldCheck,
  TerminalSquare,
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
  { id: 'knowledge', label: 'Knowledge Daemon', icon: BookOpen },
  { id: 'upgrades', label: 'Self-Upgrades', icon: GitBranch },
  { id: 'forge', label: 'API Forge', icon: Cpu },
  { id: 'workbench', label: 'Neos Brain', icon: TerminalSquare },
  { id: 'security', label: 'Security & Keys', icon: ShieldCheck },
];

export function Sidebar({ activeSection, onSelect, mobileOpen, onCloseMobile }: SidebarProps) {
  const navContent = (
    <div className="flex h-full flex-col justify-between bg-[#0E131D] border-r border-slate-800/80 w-60 px-3 py-5">
      <div>
        <div className="flex items-center justify-between px-3 pb-6">
          <span className="font-display text-lg font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
            Neo
          </span>
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close navigation menu"
            className="lg:hidden p-1.5 text-slate-400 hover:text-slate-100 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav aria-label="Primary navigation" className="space-y-1">
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
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-blue-600/15 text-blue-400'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="px-3 pt-4 border-t border-slate-800/80 text-xs text-slate-500 space-y-1">
        <p className="text-slate-400 font-medium">Neo Sovereign Core</p>
        <p>Gateway /api/v1</p>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block shrink-0">{navContent}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-black/60" onClick={onCloseMobile} />
          <div className="relative z-10 h-full">{navContent}</div>
        </div>
      )}
    </>
  );
}
