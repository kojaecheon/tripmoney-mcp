import type { IncomingMessage } from 'node:http';
import { IdentityError } from '../../core/contracts.js';

const invalid = () => new IdentityError('validation', '입력 형식을 확인해 주세요.');

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  await new Promise<void>((resolve, reject) => {
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > 8192) { rejected = true; chunks.length = 0; reject(invalid()); return; }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', () => reject(invalid()));
    req.on('aborted', () => reject(invalid()));
  });
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  return value as Record<string, unknown>;
}
