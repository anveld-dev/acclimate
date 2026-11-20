export function setupRequest(input: {
  name: string;
  channel: string;
  origin: 'created' | 'imported';
  payload?: unknown;
  compatibilityTarget?: string;
}) {
  return {
    name: input.name,
    channel: input.channel,
    origin: input.origin,
    payload: input.payload,
    compatibilityTarget: input.compatibilityTarget || 'generic',
    reason: 'Initial content setup; no model evaluation was run.',
  };
}
