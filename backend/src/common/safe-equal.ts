import { timingSafeEqual } from 'crypto';

// Constant-time string comparison so a wrong key can't be guessed byte-by-byte from response timing.
// Length is compared first via the buffer sizes; timingSafeEqual requires equal-length inputs.
// Non-ASCII inputs are compared by their UTF-8 byte length.
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
