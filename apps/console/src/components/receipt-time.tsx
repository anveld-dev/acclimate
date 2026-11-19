import { useEffect, useState } from 'react';

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function RelativeReceiptTime({ timestamp }: { timestamp: number }) {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 60000);
    return () => clearInterval(timer);
  }, []);
  if (now === undefined) return receiptTime.format(timestamp) + ' UTC';
  const minutes = Math.round((timestamp - now) / 60000);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, 'minute');
  if (Math.abs(minutes) < 1440) return relativeTime.format(Math.round(minutes / 60), 'hour');
  return relativeTime.format(Math.round(minutes / 1440), 'day');
}

const receiptTime = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

export function ReceiptTime({ value, relative = false }: { value: string; relative?: boolean }) {
  const timestamp = Date.parse(value);
  const valid = Number.isFinite(timestamp);
  const fractionalSeconds = value.match(/:\d{2}(\.\d+)/)?.[1];
  const utc =
    valid && !value.endsWith('Z')
      ? new Date(timestamp).toISOString().replace(/\.\d+Z$/, (fractionalSeconds ?? '.000') + 'Z')
      : value;
  return (
    <time dateTime={utc} title={utc}>
      {valid ? (
        relative ? (
          <RelativeReceiptTime timestamp={timestamp} />
        ) : (
          receiptTime.format(timestamp) + ' UTC'
        )
      ) : (
        value
      )}
    </time>
  );
}
