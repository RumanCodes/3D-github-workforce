import { createHmac, timingSafeEqual } from 'node:crypto';

/** Verifies GitHub's X-Hub-Signature-256 header over the exact raw request bytes. */
export function verifyGithubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signGithubPayload(rawBody: Buffer | string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}
