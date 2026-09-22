import { Link } from 'react-router-dom';
import { Eyebrow, PixelMark, Screen } from '../components/ui';

/** Plain-language privacy policy (version 2026-09-v1). Legal review required before launch. */
export function Privacy() {
  return (
    <Screen className="gap-6">
      <header className="flex items-center gap-3">
        <Link to="/"><PixelMark size={24} /></Link>
        <span className="text-sm font-bold tracking-[0.3em]">PRIVACY</span>
      </header>
      <article className="space-y-6 text-[15px] leading-relaxed">
        <Eyebrow>Version 2026-09-v1</Eyebrow>
        <Section title="Your location stays on your phone">
          HUMAN PIXEL calculates your distance and direction to your pixel on your device. We never receive or store your GPS
          coordinates or a history of your movements. The only location-related things your phone sends are your status (for
          example "arrived", "in position", "ready") and how accurate your GPS was at that moment, so the organizer can see how
          many people are in position.
        </Section>
        <Section title="What we store">
          Your email address (or nothing, if you joined as a guest), your participation in events, your participant number,
          the pixel assigned to you, your latest status and a random installation identifier. We do not collect your name,
          phone contacts, photos or advertising identifiers.
        </Section>
        <Section title="Who can see it">
          The event organizer sees counts and statuses for their own event. Other participants never see anything about you,
          including where you stand. Platform administrators can access data only to operate and secure the service.
        </Section>
        <Section title="How long we keep it">
          After an event ends, your link to the event is removed after the organizer's retention period (90 days by default).
          Anonymous statistics (for example how many people took part) are kept, because they document the event.
        </Section>
        <Section title="Your rights">
          You can cancel your participation or delete your account at any time in the app (Account → Delete my account).
          Deletion is immediate and releases any upcoming pixel. For any other request, contact the organizer of your event
          or privacy@humanpixel.app.
        </Section>
        <Section title="Photographs">
          Events are photographed from above. At that distance individual people are generally not recognisable, but the
          organizer is responsible for informing you about photography at their event.
        </Section>
      </article>
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      <p className="text-muted">{children}</p>
    </section>
  );
}
