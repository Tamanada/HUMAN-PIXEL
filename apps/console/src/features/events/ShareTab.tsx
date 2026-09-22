import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Copy, Download, RefreshCw } from 'lucide-react';
import { Alert, Button, Card, Modal } from '../../components/ui';
import { config, rpc } from '../../lib/supabase';
import { fmtDateTime } from '../../lib/time';
import type { TabProps } from './EventLayout';

export function ShareTab({ event, canEdit }: TabProps) {
  const link = `${config.participantUrl.replace(/\/$/, '')}/j/${event.join_code}`;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    if (canvas.current) void QRCode.toCanvas(canvas.current, link, { width: 360, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#07070b', light: '#ffffff' } });
  }, [link]);

  const regen = useMutation({
    mutationFn: () => rpc<string>('regenerate_join_code', { p_event_id: event.id }),
    onSuccess: () => (setConfirm(false), void qc.invalidateQueries({ queryKey: ['event', event.id] })),
  });

  const downloadPoster = async () => {
    // Print-ready A4 portrait poster at 150 dpi.
    const W = 1240;
    const H = 1754;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#050508';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#8c7cff';
    ctx.fillRect(W / 2 - 18, 150, 36, 36);
    ctx.fillStyle = '#f5f3ee';
    ctx.textAlign = 'center';
    ctx.font = '700 120px "Space Grotesk Variable"';
    ctx.fillText('YOU ARE', W / 2, 340);
    ctx.fillText('ONE PIXEL.', W / 2, 470);
    ctx.font = '500 40px "Inter Variable"';
    ctx.fillStyle = '#8f8fa0';
    ctx.fillText(event.name, W / 2, 560);
    ctx.fillText(fmtDateTime(event.starts_at, event.timezone), W / 2, 615);
    const qr = document.createElement('canvas');
    await QRCode.toCanvas(qr, link, { width: 620, margin: 2, color: { dark: '#07070b', light: '#ffffff' } });
    ctx.drawImage(qr, (W - 620) / 2, 700);
    ctx.fillStyle = '#f5f3ee';
    ctx.font = '700 64px "JetBrains Mono"';
    ctx.fillText(event.join_code, W / 2, 1440);
    ctx.font = '400 34px "Inter Variable"';
    ctx.fillStyle = '#8f8fa0';
    ctx.fillText('Scan, join, and receive your secret position.', W / 2, 1520);
    ctx.fillText('Together we become the message.', W / 2, 1570);
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `human-pixel-${event.join_code}-poster.png`;
    a.click();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Invite participants">
        <div className="space-y-5">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted">Event code</p>
            <p className="hp-digits text-5xl font-bold tracking-[0.2em] text-pixel">{event.join_code}</p>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2">
            <code className="flex-1 truncate text-sm">{link}</code>
            <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</Button>
          </div>
          {event.state === 'DRAFT' && <Alert tone="warn">The event is a draft: the link works only once you open registration (Overview).</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<Download size={14} />} onClick={() => void downloadPoster()}>Download poster (A4)</Button>
            {canEdit && <Button variant="danger" icon={<RefreshCw size={14} />} onClick={() => setConfirm(true)}>New code</Button>}
          </div>
          <p className="text-xs text-muted">Group invites: add <code>?g=GROUPCODE</code> to the link. Participants never need to install anything: the link opens the web app, which also installs as an app.</p>
        </div>
      </Card>
      <Card title="QR code">
        <div className="flex justify-center rounded-xl bg-white p-4"><canvas ref={canvas} aria-label="Join QR code" /></div>
      </Card>
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Generate a new code?" footer={<Button variant="danger" busy={regen.isPending} onClick={() => regen.mutate()}>Replace code</Button>}>
        <p className="text-sm">The current code and printed QR codes stop working immediately. Already-registered participants are not affected.</p>
        {regen.error && <div className="mt-3"><Alert tone="bad">{(regen.error as Error).message}</Alert></div>}
      </Modal>
    </div>
  );
}
