/**
 * THE PHONE EXECUTES THE EXPERIENCE.
 *
 * One engine per joined event. It owns every loop that runs on the device:
 *   • GPS → smoothing → tolerance → hysteresis (never leaves the phone)
 *   • participant state derivation → coalescing outbox → report_status (transitions only)
 *   • CDN manifest polling with jitter (state / start time / announcements)
 *   • clock sync (a handful of samples, never near T-0)
 * Everything is persisted so the experience survives offline periods, restarts and dead batteries.
 */
import {
  LocalFrame,
  PositionTracker,
  ServerClock,
  StatusOutbox,
  deriveParticipantState,
  geoJsonPolygonToLatLng,
  participantPhase,
  pointInPolygon,
  polygonToLocal,
  type AssignmentBundle,
  type ClockEstimate,
  type EventManifest,
  type GpsFix,
  type ParticipantPhase,
  type ParticipantState,
  type Polygon,
  type TrackerSnapshot,
} from '@human-pixel/core';
import { fetchManifest, getMyAssignment, measureClock, sendStatus, ApiError } from '../lib/api';
import { LocalOutboxStorage, readJson, writeJson } from '../lib/storage';
import { geolocationPermission, keepAwake, onAppResume, watchPosition, watchHeading, type GeoPermission, type GeoWatch } from '../lib/platform';

export interface EngineSnapshot {
  eventId: string;
  bundle: AssignmentBundle | null;
  manifest: EventManifest | null;
  clock: ClockEstimate | null;
  startsAt: number | null;
  phase: ParticipantPhase;
  participantState: ParticipantState;
  tracker: TrackerSnapshot | null;
  heading: number | null;
  insidePerimeter: boolean | null;
  gpsPermission: GeoPermission;
  gpsError: string | null;
  navigating: boolean;
  readyTapped: boolean;
  online: boolean;
  pendingReport: boolean;
  lastBundleAt: number | null;
  error: string | null;
}

const MIN = 60_000;
const jitter = (ms: number, spread = 0.3) => ms * (1 - spread + Math.random() * spread * 2);

export class ParticipantEngine {
  private listeners = new Set<() => void>();
  private snap: EngineSnapshot;
  private readonly clock: ServerClock;
  private readonly outbox: StatusOutbox;
  private tracker: PositionTracker | null = null;
  private targetKey = '';
  private perimeter: { frame: LocalFrame; poly: Polygon } | null = null;
  private geo: GeoWatch | null = null;
  private stopHeading: (() => void) | null = null;
  private timers: number[] = [];
  private nextManifestAt = 0;
  private nextBundleAt = 0;
  private flushing = false;
  private disposed = false;
  private stopResume: (() => void) | null = null;

  constructor(readonly eventId: string, initial?: AssignmentBundle) {
    const bundle = initial ?? readJson<AssignmentBundle>(`bundle:${eventId}`);
    const clockEst = readJson<ClockEstimate>('clock');
    this.clock = new ServerClock(clockEst);
    this.outbox = new StatusOutbox(new LocalOutboxStorage(eventId));
    const savedState = readJson<ParticipantState>(`pstate:${eventId}`) ?? (bundle?.member.state as ParticipantState | undefined) ?? 'JOINED';
    this.snap = {
      eventId,
      bundle: bundle ?? null,
      manifest: readJson<EventManifest>(`manifest:${eventId}`),
      clock: clockEst,
      startsAt: null,
      phase: 'upcoming',
      participantState: savedState,
      tracker: null,
      heading: null,
      insidePerimeter: null,
      gpsPermission: 'prompt',
      gpsError: null,
      navigating: readJson<boolean>(`nav:${eventId}`) ?? false,
      readyTapped: false,
      online: navigator.onLine,
      pendingReport: this.outbox.hasPending,
      lastBundleAt: readJson<number>(`bundleAt:${eventId}`),
      error: null,
    };
    if (initial) this.saveBundle(initial);
    this.applyBundle(this.snap.bundle);
    this.recompute();
  }

  // ---- lifecycle ---------------------------------------------------------------------------
  start(): void {
    this.timers.push(window.setInterval(() => void this.tick(), 1000));
    this.stopResume = onAppResume(() => {
      this.set({ online: navigator.onLine });
      this.nextManifestAt = 0;
      void this.tick();
    });
    void geolocationPermission().then((p) => {
      this.set({ gpsPermission: p });
      if (this.snap.navigating && p === 'granted') void this.startGps();
    });
    // First run: refresh the bundle if stale, sync the clock if we have none.
    const stale = !this.snap.lastBundleAt || Date.now() - this.snap.lastBundleAt > 10 * MIN;
    this.nextBundleAt = stale ? Date.now() : Date.now() + jitter(10 * MIN);
    void this.tick();
  }

  dispose(): void {
    this.disposed = true;
    this.timers.forEach((t) => clearInterval(t));
    this.geo?.stop();
    this.stopHeading?.();
    this.stopResume?.();
    void keepAwake(false);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): EngineSnapshot => this.snap;

  /** Authoritative time for rendering (countdown). */
  now(): number {
    return this.clock.now();
  }

  // ---- user actions ------------------------------------------------------------------------
  async startNavigation(): Promise<void> {
    writeJson(`nav:${this.eventId}`, true);
    this.set({ navigating: true });
    await keepAwake(true);
    await this.startGps();
  }

  async stopNavigation(): Promise<void> {
    writeJson(`nav:${this.eventId}`, false);
    this.geo?.stop();
    this.geo = null;
    this.stopHeading?.();
    this.stopHeading = null;
    this.set({ navigating: false });
    await keepAwake(false);
  }

  enableCompass(): void {
    this.stopHeading?.();
    this.stopHeading = watchHeading((h) => this.set({ heading: h }));
  }

  tapReady(): void {
    this.set({ readyTapped: true });
    this.evaluate();
  }

  async refresh(): Promise<void> {
    this.nextBundleAt = 0;
    this.nextManifestAt = 0;
    await this.tick();
  }

  // ---- internals ---------------------------------------------------------------------------
  private set(patch: Partial<EngineSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  private saveBundle(b: AssignmentBundle): void {
    writeJson(`bundle:${this.eventId}`, b);
    writeJson(`bundleAt:${this.eventId}`, Date.now());
  }

  private applyBundle(b: AssignmentBundle | null): void {
    if (!b) return;
    const target = b.pixel?.target;
    if (target) {
      const t = { ...target, radius: b.event.tolerance_radius_m, requiredAccuracy: b.event.required_accuracy_m };
      const key = `${t.lat},${t.lng},${t.radius},${t.requiredAccuracy}`;
      // Only a genuinely new target resets the hysteresis (a routine refresh must not eject anyone).
      if (!this.tracker) this.tracker = new PositionTracker(t);
      else if (key !== this.targetKey) this.tracker.setTarget(t);
      this.targetKey = key;
    } else {
      this.tracker = null;
    }
    const per = b.areas.find((a) => a.kind === 'perimeter' && a.geometry.type === 'Polygon');
    if (per && per.geometry.type === 'Polygon') {
      const poly = geoJsonPolygonToLatLng(per.geometry);
      const frame = new LocalFrame(poly.outer[0]!);
      this.perimeter = { frame, poly: polygonToLocal(frame, poly) };
    }
  }

  private recompute(): void {
    const m = this.snap.manifest;
    const b = this.snap.bundle;
    const startsIso = m?.startsAt ?? b?.event.starts_at ?? null;
    const startsAt = startsIso ? Date.parse(startsIso) : null;
    const state = m?.state ?? b?.event.state ?? 'REGISTRATION_OPEN';
    const phase = participantPhase(state, this.clock.now(), startsAt);
    if (phase !== this.snap.phase || startsAt !== this.snap.startsAt) this.set({ phase, startsAt });
  }

  private async startGps(): Promise<void> {
    if (this.geo) return;
    try {
      this.geo = await watchPosition(
        (fix) => this.onFix(fix),
        (msg) => this.set({ gpsError: msg }),
      );
      this.set({ gpsPermission: 'granted', gpsError: null });
    } catch (e) {
      this.set({ gpsError: (e as Error).message });
    }
  }

  private onFix(fix: GpsFix): void {
    let inside: boolean | null = this.snap.insidePerimeter;
    if (this.perimeter) {
      inside = pointInPolygon(this.perimeter.frame.toLocal(fix), this.perimeter.poly);
    }
    const tracker = this.tracker ? this.tracker.update(fix) : null;
    this.set({ tracker, insidePerimeter: inside, gpsError: null });
    this.evaluate();
  }

  /** Derives the participant state and enqueues a report when it changes. */
  private evaluate(): void {
    const now = this.clock.now();
    const tracker = this.tracker ? this.tracker.snapshot(Date.now()) : null;
    const next = deriveParticipantState(this.snap.participantState, {
      insidePerimeter: this.snap.insidePerimeter,
      tracker,
      now,
      startsAt: this.snap.startsAt,
      readyTapped: this.snap.readyTapped,
    });
    if (next !== this.snap.participantState) {
      writeJson(`pstate:${this.eventId}`, next);
      this.outbox.enqueue({
        eventId: this.eventId,
        state: next,
        at: now,
        accuracyM: tracker?.evaluation.accuracy ?? null,
        clockUncertaintyMs: this.clock.current?.uncertaintyMs ?? null,
      });
      this.set({ participantState: next, pendingReport: true });
    }
    if (tracker && tracker.gpsLost !== this.snap.tracker?.gpsLost) this.set({ tracker });
  }

  private inCriticalWindow(): boolean {
    const s = this.snap.startsAt;
    if (s == null) return false;
    const now = this.clock.now();
    return now > s - 5 * MIN && now < s + 3 * MIN;
  }

  private manifestInterval(): number {
    const s = this.snap.startsAt;
    const now = this.clock.now();
    if (this.snap.phase === 'photo' || this.snap.phase === 'ended' || this.snap.phase === 'cancelled') return 30 * MIN;
    if (s == null) return 15 * MIN;
    const dt = s - now;
    if (dt > 24 * 60 * MIN) return 60 * MIN;
    if (dt > 2 * 60 * MIN) return 10 * MIN;
    if (dt > 10 * MIN) return 2 * MIN;
    if (dt > 60_000) return 30_000;
    if (dt > -150_000) return 0; // quiet: T-60 s … T+150 s, no network needed
    return 60_000; // waiting for the photo
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    this.recompute();
    this.evaluate();
    const now = Date.now();
    const online = navigator.onLine;
    if (online !== this.snap.online) this.set({ online });
    if (!online) return;

    // 1. Outbox (transitions only).
    if (this.outbox.hasPending && !this.flushing) {
      this.flushing = true;
      try {
        await this.outbox.flush(this.clock.now(), this.snap.startsAt, (r) => sendStatus(r, this.clock.current?.uncertaintyMs ?? null));
      } finally {
        this.flushing = false;
        this.set({ pendingReport: this.outbox.hasPending });
      }
    }

    // 2. Clock: once, then refresh when old; never near T-0.
    const c = this.clock.current;
    if ((!c || c.source !== 'ntp' || now - c.measuredAt > 6 * 60 * MIN) && !this.inCriticalWindow() && !this.clockSyncing) {
      this.clockSyncing = true;
      measureClock()
        .then((est) => {
          this.clock.update(est);
          writeJson('clock', this.clock.current);
          this.set({ clock: this.clock.current });
        })
        .catch(() => {})
        .finally(() => {
          // Retry later with jitter if it failed.
          window.setTimeout(() => (this.clockSyncing = false), jitter(5 * MIN));
        });
    }

    // 3. Manifest.
    if (now >= this.nextManifestAt) {
      const interval = this.manifestInterval();
      if (interval === 0) {
        this.nextManifestAt = now + 30_000;
      } else {
        this.nextManifestAt = now + jitter(interval);
        void this.pollManifest();
      }
    }

    // 4. Bundle refresh (assignment): rare, and spread out.
    if (now >= this.nextBundleAt && !this.inCriticalWindow()) {
      const waitlisted = this.snap.bundle?.member.status === 'waitlisted';
      this.nextBundleAt = now + jitter(waitlisted ? 60_000 : 15 * MIN);
      void this.refreshBundle();
    }
  }

  private clockSyncing = false;

  private async pollManifest(): Promise<void> {
    try {
      const res = await fetchManifest(this.eventId);
      if (!res) return;
      if (res.clock && !this.clock.current) {
        this.clock.update(res.clock);
        this.set({ clock: this.clock.current });
      }
      const prev = this.snap.manifest;
      writeJson(`manifest:${this.eventId}`, res.manifest);
      this.set({ manifest: res.manifest, error: null });
      this.recompute();
      const b = this.snap.bundle;
      const epochChanged = b && res.manifest.assignmentEpoch !== b.event.assignment_epoch;
      const releasedNow =
        b?.pixel && !b.pixel.released && res.manifest.positionsReleaseAt && Date.parse(res.manifest.positionsReleaseAt) <= this.clock.now();
      const stateChanged = prev && prev.state !== res.manifest.state;
      if (epochChanged || releasedNow || (stateChanged && res.manifest.state === 'PARTICIPANT_NAVIGATION')) {
        // Everyone learns this at roughly the same time: spread the refetch over 2 minutes.
        this.nextBundleAt = Date.now() + Math.random() * 120_000;
      }
    } catch {
      /* offline or CDN issue: keep the cached manifest */
    }
  }

  private async refreshBundle(): Promise<void> {
    try {
      const b = await getMyAssignment(this.eventId);
      this.saveBundle(b);
      this.applyBundle(b);
      this.set({ bundle: b, lastBundleAt: Date.now(), error: null });
      this.recompute();
    } catch (e) {
      if (e instanceof ApiError && !e.retryable) this.set({ error: e.message });
    }
  }
}
