import type { ReactNode } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { CalendarRange, Building2, ShieldCheck, LogOut, Plus } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { PixelMark } from './ui';

export function Shell({ children }: { children: ReactNode }) {
  const { session, memberships, isAdmin } = useAuth();
  const item = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${isActive ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface-2 hover:text-text'}`;
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface px-3 py-4 md:flex">
        <Link to="/" className="mb-6 flex items-center gap-2.5 px-2">
          <PixelMark size={26} />
          <span className="text-[13px] font-bold tracking-[0.28em]">HUMAN PIXEL</span>
        </Link>
        <nav className="space-y-1">
          <NavLink to="/" end className={item}><CalendarRange size={16} /> Events</NavLink>
          {memberships.map((m) => (
            <NavLink key={m.org_id} to={`/org/${m.org_id}`} className={item}>
              <Building2 size={16} /> <span className="truncate">{m.organizations.name}</span>
            </NavLink>
          ))}
          <NavLink to="/onboarding" className={item}><Plus size={16} /> New organization</NavLink>
          {isAdmin && <NavLink to="/admin" className={item}><ShieldCheck size={16} /> Platform admin</NavLink>}
        </nav>
        <div className="mt-auto space-y-2 border-t border-line px-2 pt-4">
          <p className="truncate text-xs text-muted">{session?.user.email}</p>
          <button onClick={() => void supabase.auth.signOut()} className="flex items-center gap-2 text-xs text-muted hover:text-text">
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between border-b border-line px-4 py-3 md:hidden">
          <Link to="/" className="flex items-center gap-2"><PixelMark size={22} /><span className="text-xs font-bold tracking-[0.25em]">HUMAN PIXEL</span></Link>
          {isAdmin && <Link to="/admin" className="text-xs text-muted">Admin</Link>}
        </header>
        <main className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
