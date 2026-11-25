const CONSOLE_BASE = 'https://console.invalid';
const UNSAFE_CHARACTERS = /[\\\u0000-\u001f\u007f-\u009f\ufffd]/;

/** A bounded console path, never a URL supplied by the identity provider. */
export function validateReturnDestination(value: string | null | undefined): string | null {
  if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//'))
    return null;
  try {
    const decoded = decodeURIComponent(value);
    if (UNSAFE_CHARACTERS.test(value) || UNSAFE_CHARACTERS.test(decoded)) return null;
    const url = new URL(value, CONSOLE_BASE);
    // Check decoded path separators and normalized dot segments too. Nested path
    // encodings are unnecessary for console routes and make routing ambiguous.
    if (/%25/i.test(url.pathname)) return null;
    const decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath.startsWith('//')) return null;
    const path = new URL(decodedPath, CONSOLE_BASE);
    if (
      url.origin !== CONSOLE_BASE ||
      path.origin !== CONSOLE_BASE ||
      /^\/auth(?:\/|$)/i.test(path.pathname)
    )
      return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function signInHref(destination?: string | null): string {
  const returnTo = validateReturnDestination(destination);
  return returnTo ? `/auth/login?${new URLSearchParams({ returnTo })}` : '/auth/login';
}
