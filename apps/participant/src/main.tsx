import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import './index.css';
import { installFlagFont } from './lib/flags';
import { Home } from './screens/Home';
import { Join } from './screens/Join';
import { EventScreen } from './screens/EventScreen';
import { config } from './lib/config';
import { readJson } from './lib/storage';

const PhotoScreen = lazy(() => import('./screens/PhotoScreen').then((m) => ({ default: m.PhotoScreen })));
const Account = lazy(() => import('./screens/Account').then((m) => ({ default: m.Account })));
const HallOfFame = lazy(() => import('./screens/HallOfFame').then((m) => ({ default: m.HallOfFame })));
const Privacy = lazy(() => import('./screens/Privacy').then((m) => ({ default: m.Privacy })));

document.documentElement.dataset.sun = readJson<boolean>('sun') ? 'on' : 'off';

// Offline-first: the app shell is precached; updates apply on the next launch, never mid-event.
registerSW({ immediate: true });

if (config.sentryDsn) {
  void import('@sentry/react')
    .then((Sentry) =>
      Sentry.init({
        dsn: config.sentryDsn!,
        release: `participant@${config.appVersion}`,
        tracesSampleRate: 0.02,
        // Never ship location data to error tracking.
        beforeSend(event) {
          const s = JSON.stringify(event);
          return /"(lat|lng|latitude|longitude)"/.test(s) ? null : event;
        },
      }),
    )
    .catch(() => {});
}

installFlagFont();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/j/:code" element={<Join />} />
          <Route path="/e/:eventId" element={<EventScreen />} />
          <Route path="/e/:eventId/photo" element={<PhotoScreen />} />
          <Route path="/account" element={<Account />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/hall/:eventId" element={<HallOfFame />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>,
);
