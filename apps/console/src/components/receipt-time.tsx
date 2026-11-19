const receiptTime = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

export function ReceiptTime({ value }: { value: string }) {
  const timestamp = Date.parse(value);
  const valid = Number.isFinite(timestamp);
  const fractionalSeconds = value.match(/:\d{2}(\.\d+)/)?.[1];
  const utc = valid && !value.endsWith('Z')
    ? new Date(timestamp).toISOString().replace(/\.\d+Z$/, (fractionalSeconds ?? '.000') + 'Z')
    : value;
  return (
    <time dateTime={utc} title={utc}>
      {valid ? receiptTime.format(timestamp) + ' UTC' : value}
    </time>
  );
}
