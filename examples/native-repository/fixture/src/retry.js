export function retryKey(requestId, attempt) {
  return `${requestId}:${attempt}`;
}
