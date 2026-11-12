import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function readKey(kid: string, keys: Record<string, Buffer>): Buffer {
  if (typeof kid !== 'string' || kid.length < 1 || kid.length > 16
    || /[^A-Za-z0-9_-]/.test(kid) || !Object.hasOwn(keys, kid)) {
    throw new Error();
  }
  const key = keys[kid];
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error();
  return key;
}

function aadBytes(aad: string): Buffer {
  if (typeof aad !== 'string' || aad.length === 0) throw new Error();
  return Buffer.from(aad, 'utf8');
}

function decodePart(text: string): Buffer {
  if (text.length === 0 || /[^A-Za-z0-9_-]/.test(text)) throw new Error();
  const decoded = Buffer.from(text, 'base64url');
  if (decoded.toString('base64url') !== text) throw new Error();
  return decoded;
}

export function seal(value: unknown, kid: string, keys: Record<string, Buffer>, aad: string): string {
  try {
    const key = readKey(kid, keys);
    const additionalData = aadBytes(aad);
    const json = JSON.stringify(value);
    if (typeof json !== 'string') throw new Error();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(additionalData);
    const data = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    return [kid, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
      data.toString('base64url')].join('.');
  } catch {
    throw new Error('crypto_config');
  }
}

export function open(cipher: string, keys: Record<string, Buffer>, aad: string): unknown {
  try {
    if (typeof cipher !== 'string') throw new Error();
    const parts = cipher.split('.');
    if (parts.length !== 4) throw new Error();
    const [kid, ivText, tagText, dataText] = parts as [string, string, string, string];
    const key = readKey(kid, keys);
    const additionalData = aadBytes(aad);
    const iv = decodePart(ivText);
    const tag = decodePart(tagText);
    const data = decodePart(dataText);
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(additionalData);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Error('crypto_envelope');
  }
}
