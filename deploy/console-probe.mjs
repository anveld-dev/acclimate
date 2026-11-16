// Probe the private hop with the same canonical Host the trusted proxy supplies.
try {
  const origin = new URL(process.env.CONSOLE_ORIGIN);
  const response = await fetch('http://127.0.0.1:3100/ready', {
    headers: { Host: origin.host }, signal: AbortSignal.timeout(2500), redirect: 'error',
  });
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
