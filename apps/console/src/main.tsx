import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import { config } from './lib/supabase';
import { Shell } from './components/Shell';
import { Spinner } from './components/ui';
import { SignIn } from './features/auth/SignIn';
import { Onboarding } from './features/orgs/Onboarding';
import { EventList } from './features/events/EventList';

const EventLayout = lazy(() => import('./features/events/EventLayout').then((m) => ({ default: m.EventLayout })));
const OrgSettings = lazy(() => import('./features/orgs/OrgSettings').then((m) => ({ default: m.OrgSettings })));
const AdminRoutes = lazy(() => import('./features/admin/AdminRoutes').then((m) => ({ default: m.AdminRoutes })));

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 2, refetchOnWindowFocus: false } },
});

if (config.sentryDsn) {
  void import('@sentry/react').then((Sentry) =>
    Sentry.init({ dsn: config.sentryDsn!, release: `console@${config.appVersion}`, tracesSampleRate: 0.1 }),
  );
}

function Gate() {
  const { session, loading, memberships, isAdmin } = useAuth();
  if (loading) return <Spinner label="Starting" />;
  if (!session) return <SignIn />;
  if (memberships.length === 0 && !isAdmin) return <Onboarding />;
  return (
    <Shell>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/" element={<EventList />} />
          <Route path="/events/:eventId/*" element={<EventLayout />} />
          <Route path="/org/:orgId" element={<OrgSettings />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/admin/*" element={<AdminRoutes />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
