const limit = 16 * 1024;

export class TranscriptError extends Error {
  constructor(message: string, readonly trace: string) {
    super(message);
  }
}

/** Keep the latest UTF-8 bytes, without retaining an unbounded event history. */
export function transcriptTail() {
  let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const transcript = {
    add(event: unknown) {
      const bytes = Buffer.from(JSON.stringify(event) + '\n');
      if (bytes.length >= limit) tail = Buffer.from(bytes.subarray(-limit));
      else tail = Buffer.concat([tail.subarray(Math.max(0, tail.length + bytes.length - limit)), bytes]);
    },
    text() {
      let start = 0;
      while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
      return tail.subarray(start).toString();
    },
    failure(message: string) {
      return new TranscriptError(message, transcript.text());
    },
  };
  return transcript;
}
