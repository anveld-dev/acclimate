const receiptTime = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hourCycle: 'h23',
  timeZone: 'UTC',
});

export function ReceiptTime({ value }: { value: string }) {
  const timestamp = Date.parse(value);
  return (
    <time dateTime={value} title={value}>
      {Number.isFinite(timestamp) ? receiptTime.format(timestamp) + ' UTC' : value}
    </time>
  );
}
