import fs from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { parseEnv } from 'node:util';
import { readSecretEnvFile } from '../server/config/secret-env.js';
import { readDbTestConfig } from '../server/db/config.js';

type Passwords = { admin: string; app: string; auth: string };
type Input = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };
type Output = Writable & { isTTY?: boolean };
const allowed = ['CUSTOMER_DB_TEST_APPROVED', 'CUSTOMER_DB_TEST_ID', 'CUSTOMER_DB_TEST_ADMIN_URL',
  'CUSTOMER_DB_TEST_URL', 'CUSTOMER_DB_AUTH_URL'];
const invalid = () => new Error('customer_db_setup_configuration');
const cancelled = () => new Error('customer_db_setup_cancelled');

function validatePassword(value: string): void {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 1024
    || /[\u0000-\u001f\u007f]/u.test(value)
    || ['[YOUR-PASSWORD]', 'REPLACE_WITH_URL_ENCODED_PASSWORD'].includes(value)) throw invalid();
  try { encodeURIComponent(value); } catch { throw invalid(); }
}

export function buildDbSetupEnv(passwords: Passwords): string {
  for (const role of ['admin', 'app', 'auth'] as const) validatePassword(passwords[role]);
  if (new Set(Object.values(passwords)).size !== 3) throw invalid();
  const endpoint = 'aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres';
  const url = (user: string, password: string) => {
    const escaped = encodeURIComponent(password).replace(/[!'()*]/g,
      (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    return `postgresql://${user}.agddopryfqsyfshoowgk:${escaped}@${endpoint}`;
  };
  const env = {
    CUSTOMER_DB_TEST_APPROVED: 'true', CUSTOMER_DB_TEST_ID: endpoint,
    CUSTOMER_DB_TEST_ADMIN_URL: url('postgres', passwords.admin),
    CUSTOMER_DB_TEST_URL: url('customer_app_login', passwords.app),
    CUSTOMER_DB_AUTH_URL: url('customer_auth_login', passwords.auth),
  };
  try { readDbTestConfig(env); } catch { throw invalid(); }
  return Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join('');
}

function snapshot(path: string): string {
  const stat = fs.lstatSync(path);
  const parent = fs.lstatSync(dirname(path));
  const uid = process.getuid?.();
  if (uid === undefined || !stat.isFile() || stat.uid !== uid || stat.nlink !== 1
    || (stat.mode & 0o7777) !== 0o600 || !parent.isDirectory() || parent.uid !== uid
    || (parent.mode & 0o022) !== 0) throw invalid();
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, parent.dev, parent.ino].join(':');
}

export function checkedSnapshot(path: string): string {
  const before = snapshot(path);
  readSecretEnvFile(path, allowed);
  if (snapshot(path) !== before) throw invalid();
  return before;
}

export function saveDbSetupEnv(path: string, passwords: Passwords, expected?: string): void {
  let temporary: string | undefined;
  let fd: number | undefined;
  try {
    const before = checkedSnapshot(path);
    if (expected !== undefined && expected !== before) throw invalid();
    const content = buildDbSetupEnv(passwords);
    readDbTestConfig(parseEnv(content));
    const candidate = `${path}.setup-${randomUUID()}`;
    fd = fs.openSync(candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_NOFOLLOW, 0o600);
    temporary = candidate;
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (checkedSnapshot(path) !== before) throw invalid();
    fs.renameSync(temporary, path);
    temporary = undefined;
  } catch { throw invalid(); }
  finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 오류 원문은 출력하지 않는다. */ } }
    if (temporary !== undefined) { try { fs.unlinkSync(temporary); } catch { /* 생성한 임시 파일 하나만 정리한다. */ } }
  }
}

export function readHiddenPassword(input: Input, output: Output, label: string,
  signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (input.isTTY !== true || output.isTTY !== true || typeof input.setRawMode !== 'function') {
      reject(invalid()); return;
    }
    if (signal?.aborted) { reject(cancelled()); return; }
    const previousRaw = input.isRaw === true;
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let value = '';
    let finished = false;
    const end = (failure?: Error) => {
      if (finished) return;
      finished = true;
      input.pause();
      input.removeListener('data', data);
      input.removeListener('end', stop);
      input.removeListener('close', stop);
      input.removeListener('error', stop);
      signal?.removeEventListener('abort', stop);
      try { input.setRawMode!(previousRaw); } catch { failure = invalid(); }
      try { output.write('\n'); } catch { failure = invalid(); }
      const result = value;
      value = '';
      if (failure) reject(failure); else resolve(result);
    };
    const stop = () => end(cancelled());
    const data = (chunk: Buffer | string) => {
      try {
        const source = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        for (const char of source) {
          if (char === '\r' || char === '\n') { validatePassword(value); end(); return; }
          if (char === '\x03' || char === '\x04') { stop(); return; }
          if (char === '\x7f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
          else {
            if (/[\u0000-\u001f]/u.test(char)) throw invalid();
            value += char;
            if (Buffer.byteLength(value, 'utf8') > 1024) throw invalid();
          }
        }
      } catch { end(invalid()); }
    };
    try {
      input.setRawMode(true);
      input.on('data', data);
      input.once('end', stop);
      input.once('close', stop);
      input.once('error', stop);
      signal?.addEventListener('abort', stop, { once: true });
      output.write(label);
      input.resume();
    } catch { end(invalid()); }
  });
}

export async function runDbSetup(options: { input: Input; output: Output; path: string; signal?: AbortSignal }): Promise<void> {
  const { input, output, path, signal } = options;
  if (input.isTTY !== true || output.isTTY !== true || typeof input.setRawMode !== 'function') throw invalid();
  let before: string;
  try { before = checkedSnapshot(path); } catch { throw invalid(); }
  const previousRaw = input.isRaw === true;
  const passwords: Passwords = { admin: '', app: '', auth: '' };
  try {
    input.setRawMode(true);
    passwords.admin = await readHiddenPassword(input, output, '1/3 신규 개발 DB 관리자 비밀번호: ', signal);
    passwords.app = await readHiddenPassword(input, output, '2/3 customer_app_login 비밀번호: ', signal);
    passwords.auth = await readHiddenPassword(input, output, '3/3 customer_auth_login 비밀번호: ', signal);
    if (signal?.aborted) throw cancelled();
    saveDbSetupEnv(path, passwords, before);
  } finally {
    passwords.admin = ''; passwords.app = ''; passwords.auth = '';
    input.pause();
    input.setRawMode(previousRaw);
  }
}
