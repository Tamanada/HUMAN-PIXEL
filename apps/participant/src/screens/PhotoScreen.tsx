import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Banner, Button, Eyebrow, PixelMark, Screen } from '../components/ui';
import { getMyPhoto, signedPhotoUrl, type PhotoCard } from '../lib/api';
import { formatEventDate } from '../lib/hooks';
import { shareImage } from '../lib/platform';
import { readJson, writeJson } from '../lib/storage';

export function PhotoScreen() {
  const { eventId = '' } = useParams();
  const [card, setCard] = useState<PhotoCard | null>(() => readJson<PhotoCard>(`photo:${eventId}`));
  const [url, setUrl] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    let alive = true;
    getMyPhoto(eventId)
      .then(async (c) => {
        if (!alive) return;
        setCard(c);
        writeJson(`photo:${eventId}`, c);
        if (c.photo) setUrl(await signedPhotoUrl(c.photo.display_path));
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [eventId]);

  const total = card?.participants ?? 0;
  const tags = (card?.hashtags ?? []).map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
  const shareText =
    (card?.share_message?.trim() || `I was one of ${total.toLocaleString()} people who became ONE HUMAN PIXEL.`) + (tags ? `\n${tags}` : '\n#HumanPixel');

  const share = async () => {
    if (!card?.photo) return;
    setSharing(true);
    try {
      const shareUrl = await signedPhotoUrl(card.photo.share_path, 600);
      const blob = await (await fetch(shareUrl)).blob();
      await shareImage({ title: card.event_name ?? 'HUMAN PIXEL', text: shareText, blob, fileName: `human-pixel-${card.pixel_label ?? 'photo'}.jpg` });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSharing(false);
    }
  };

  if (card && !card.released) {
    return (
      <Screen className="justify-center gap-6 text-center">
        <PixelMark size={64} />
        <p className="text-lg">The photo has not been released yet. It will appear here automatically.</p>
        <Link to={`/e/${eventId}`} className="text-pixel underline">Back</Link>
      </Screen>
    );
  }
  if (card && card.eligible === false) {
    return (
      <Screen className="justify-center gap-6 text-center">
        <Banner>For this event, the photo is shared with participants who checked in on site.</Banner>
        <Link to={`/e/${eventId}`} className="text-pixel underline">Back</Link>
      </Screen>
    );
  }

  return (
    <Screen className="gap-6">
      <header className="flex items-center justify-between">
        <Link to={`/e/${eventId}`} className="text-sm text-muted">← Back</Link>
        <PixelMark size={24} />
      </header>
      {!revealed ? (
        <section className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
          <h1 className="hp-display hp-rise text-5xl">Now you can<br />see what you<br /><span className="text-pixel">created.</span></h1>
          <Button onClick={() => setRevealed(true)} disabled={!url}>{url ? 'Reveal' : 'Developing…'}</Button>
          {error && <Banner tone="bad">{error}</Banner>}
        </section>
      ) : (
        <section className="space-y-6">
          {url && (
            <img
              src={url}
              alt={`Aerial photograph of ${card?.event_name ?? 'the formation'}`}
              className="hp-rise w-full rounded-3xl border border-line object-cover"
              style={{ animationDuration: '1.6s' }}
            />
          )}
          <div className="rounded-3xl border border-line bg-surface p-5 text-center">
            <Eyebrow>You were one of</Eyebrow>
            <p className="hp-digits mt-1 text-5xl font-bold">{total.toLocaleString()}</p>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted">pixels</p>
            <div className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
              <div>
                <p className="text-muted">Event</p>
                <p className="font-semibold">{card?.event_name}</p>
              </div>
              <div>
                <p className="text-muted">Date</p>
                <p className="font-semibold">{formatEventDate(card?.event_date ?? null, card?.timezone ?? 'UTC')}</p>
              </div>
              <div className="col-span-2">
                <p className="text-muted">Your pixel</p>
                <p className="hp-digits text-3xl font-bold text-pixel">#{card?.pixel_label ?? '—'}</p>
              </div>
            </div>
          </div>
          <Button onClick={share} busy={sharing}>Share</Button>
          <Link to={`/hall/${eventId}`} className="block text-center text-sm text-pixel underline-offset-4 hover:underline">See the Hall of Fame →</Link>
          <p className="whitespace-pre-line text-center text-sm text-muted">{shareText}</p>
          {error && <Banner tone="bad">{error}</Banner>}
        </section>
      )}
    </Screen>
  );
}
