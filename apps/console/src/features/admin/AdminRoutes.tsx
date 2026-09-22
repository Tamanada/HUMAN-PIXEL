import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Activity, Building2, CalendarRange, Flag, ScrollText, Settings2, ShieldCheck, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '../../lib/auth';
import { Alert, Spinner } from '../../components/ui';
import { HealthPage } from './HealthPage';
import { UsersPage } from './UsersPage';
import { OrganizationsPage } from './OrganizationsPage';
import { EventsPage } from './EventsPage';
import { AuditLogPage } from './AuditLogPage';
import { AbuseReportsPage } from './AbuseReportsPage';
import { SettingsPage } from './SettingsPage';

const TABS: { to: string; label: string; icon: ReactNode; end?: boolean }[] = [
  { to: '.', label: 'Health', icon: <Activity size={14} />, end: true },
  { to: 'users', label: 'Users', icon: <Users size={14} /> },
  { to: 'organizations', label: 'Organizations', icon: <Building2 size={14} /> },
  { to: 'events', label: 'Events', icon: <CalendarRange size={14} /> },
  { to: 'audit', label: 'Audit log', icon: <ScrollText size={14} /> },
  { to: 'reports', label: 'Abuse reports', icon: <Flag size={14} /> },
  { to: 'settings', label: 'Settings', icon: <Settings2 size={14} /> },
];

/** Platform administration, mounted at `/admin/*`. Every write is re-authorized server-side. */
export function AdminRoutes() {
  const { isAdmin, loading } = useAuth();

  if (loading) return <Spinner label="Checking access" />;
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <Alert tone="bad">Administrator access required.</Alert>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-6">
      <header className="flex items-center gap-3">
        <ShieldCheck size={20} className="text-pixel" aria-hidden="true" />
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Mission control</p>
          <h1 className="hp-display text-2xl">Platform administration</h1>
        </div>
      </header>

      <nav aria-label="Administration sections" className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-xs font-semibold uppercase tracking-wider transition ${
                isActive ? 'border-pixel text-text' : 'border-transparent text-muted hover:text-text'
              }`
            }
          >
            {t.icon}
            {t.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route index element={<HealthPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="organizations" element={<OrganizationsPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="audit" element={<AuditLogPage />} />
        <Route path="reports" element={<AbuseReportsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </div>
  );
}
