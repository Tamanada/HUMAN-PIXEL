import { useState, type ReactNode } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { CalendarRange, Building2, ShieldCheck, LogOut, Plus, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { PixelMark } from './ui';

const COLLAPSED_KEY = 'hp.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function Shell({ children }: { children: ReactNode }) {
  const { session, memberships, isAdmin } = useAuth();
  // Collapsed = icon rail only, remembered per browser: the map needs the width.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1');
      } catch {
        /* not remembered */
      }
      return !c;
    });
  const item = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 rounded-lg py-2 text-sm transition ${collapsed ? 'justify-center px-0' : 'px-3'} ${isActive ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface-2 hover:text-text'}`;
  const label = (text: string) => (collapsed ? null : <span className="truncate">{text}</span>);
  return (
    <div className="flex min-h-full">
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-surface py-4 transition-[width] duration-200 md:flex ${collapsed ? 'w-16 px-2' : 'w-60 px-3'}`}
      >
        <div className={`mb-6 flex items-center ${collapsed ? 'flex-col gap-3' : 'justify-between px-2'}`}>
          <Link to="/" className="flex items-center gap-2.5" title="HUMAN PIXEL">
            <PixelMark size={26} />
            {!collapsed && <span className="text-[13px] font-bold tracking-[0.28em]">HUMAN PIXEL</span>}
          </Link>
          <button
            onClick={toggle}
            className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"
            aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
        <nav className="space-y-1">
          <NavLink to="/" end className={item} title="Events"><CalendarRange size={16} /> {label('Events')}</NavLink>
          {memberships.map((m) => (
            <NavLink key={m.org_id} to={`/org/${m.org_id}`} className={item} title={m.organizations.name}>
              <Building2 size={16} /> {label(m.organizations.name)}
            </NavLink>
          ))}
          <NavLink to="/onboarding" className={item} title="New organization"><Plus size={16} /> {label('New organization')}</NavLink>
          {isAdmin && <NavLink to="/admin" className={item} title="Platform admin"><ShieldCheck size={16} /> {label('Platform admin')}</NavLink>}
        </nav>
        <div className={`mt-auto space-y-2 border-t border-line pt-4 ${collapsed ? 'flex justify-center' : 'px-2'}`}>
          {!collapsed && <p className="truncate text-xs text-muted">{session?.user.email}</p>}
          <button onClick={() => void supabase.auth.signOut()} className="flex items-center gap-2 text-xs text-muted hover:text-text" title="Sign out">
            <LogOut size={14} /> {!collapsed && 'Sign out'}
          </button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between border-b border-line px-4 py-3 md:hidden">
          <Link to="/" className="flex items-center gap-2"><PixelMark size={22} /><span className="text-xs font-bold tracking-[0.25em]">HUMAN PIXEL</span></Link>
          {isAdmin && <Link to="/admin" className="text-xs text-muted">Admin</Link>}
        </header>
        <main className={`mx-auto w-full px-4 py-6 md:px-8 ${collapsed ? 'max-w-[1800px]' : 'max-w-7xl'}`}>{children}</main>
      </div>
    </div>
  );
}
