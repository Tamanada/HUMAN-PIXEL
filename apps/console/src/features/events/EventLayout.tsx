import { lazy, Suspense } from 'react';
import { NavLink, Route, Routes, useParams, Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { EVENT_STATE_LABELS } from '@human-pixel/core';
import { Alert, Badge, Spinner } from '../../components/ui';
import { canManage, useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/time';
import type { EventRow } from '../../lib/types';
import { stateTone } from './EventList';
import { useEvent } from './hooks';
import { Overview } from './Overview';

const LocationTab = lazy(() => import('./LocationTab').then((m) => ({ default: m.LocationTab })));
const FormationTab = lazy(() => import('./FormationTab').then((m) => ({ default: m.FormationTab })));
const ParticipantsTab = lazy(() => import('./ParticipantsTab').then((m) => ({ default: m.ParticipantsTab })));
const LiveTab = lazy(() => import('./LiveTab').then((m) => ({ default: m.LiveTab })));
const PhotosTab = lazy(() => import('./PhotosTab').then((m) => ({ default: m.PhotosTab })));
const ShareTab = lazy(() => import('./ShareTab').then((m) => ({ default: m.ShareTab })));
const SettingsTab = lazy(() => import('./SettingsTab').then((m) => ({ default: m.SettingsTab })));
const EvidenceTab = lazy(() => import('./EvidenceTab').then((m) => ({ default: m.EvidenceTab })));

export interface TabProps {
  event: EventRow;
  canEdit: boolean;
}

const TABS = [
  ['', 'Overview'],
  ['location', 'Location & safety'],
  ['formation', 'Formation'],
  ['participants', 'Participants'],
  ['live', 'Live'],
  ['photos', 'Photos'],
  ['share', 'Invite'],
  ['settings', 'Settings'],
  ['evidence', 'Evidence'],
] as const;

export function EventLayout() {
  const { eventId = '' } = useParams();
  const { memberships, isAdmin } = useAuth();
  const event = useEvent(eventId);
  if (event.isLoading) return <Spinner />;
  if (event.error || !event.data) return <Alert tone="bad">{(event.error as Error)?.message ?? 'Event not found'}</Alert>;
  const e = event.data;
  const canEdit = canManage(memberships.find((m) => m.org_id === e.org_id), isAdmin);
  const props: TabProps = { event: e, canEdit };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-text"><ChevronLeft size={14} /> Events</Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="hp-display text-3xl">{e.name}</h1>
          <Badge tone={stateTone(e.state)}>{EVENT_STATE_LABELS[e.state]}</Badge>
          {!canEdit && <Badge>Read only</Badge>}
        </div>
        <p className="mt-1 text-sm text-muted">
          {e.venue_name ?? 'No venue yet'} · {fmtDateTime(e.starts_at, e.timezone)} ({e.timezone}) · code <span className="hp-digits text-text">{e.join_code}</span>
        </p>
      </div>
      <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(([path, label]) => (
          <NavLink
            key={path}
            to={path ? `/events/${e.id}/${path}` : `/events/${e.id}`}
            end
            className={({ isActive }) => `whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition ${isActive ? 'border-pixel text-text' : 'border-transparent text-muted hover:text-text'}`}
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route index element={<Overview {...props} />} />
          <Route path="location" element={<LocationTab {...props} />} />
          <Route path="formation" element={<FormationTab {...props} />} />
          <Route path="participants" element={<ParticipantsTab {...props} />} />
          <Route path="live" element={<LiveTab {...props} />} />
          <Route path="photos" element={<PhotosTab {...props} />} />
          <Route path="share" element={<ShareTab {...props} />} />
          <Route path="settings" element={<SettingsTab {...props} />} />
          <Route path="evidence" element={<EvidenceTab {...props} />} />
        </Routes>
      </Suspense>
    </div>
  );
}
