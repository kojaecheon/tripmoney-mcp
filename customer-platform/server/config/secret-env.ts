import fs from 'node:fs';
import { parseEnv } from 'node:util';

const maximumBytes = 64 * 1024;
const configurationError = (): never => { throw new Error('customer_secret_env_configuration'); };

export function readSecretEnvFile(path: string | URL, allowedKeys: readonly string[]): NodeJS.ProcessEnv {
  let fd: number | undefined;
  try {
    const uid = process.getuid?.();
    if (uid === undefined || allowedKeys.some((key) => !/^CUSTOMER_[A-Z0-9_]+$/.test(key))) return configurationError();
    // NONBLOCK은 FIFO 같은 일반 파일 이외의 경로에서 open이 멈추는 것을 막는다.
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600
      || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximumBytes) return configurationError();
    // 검사 뒤 파일이 커져도 상한보다 1바이트까지만 읽는다. 경로를 다시 열지 않는다.
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maximumBytes) return configurationError();
    const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    const allowed = new Set(allowedKeys);
    // parseEnv가 __proto__ 같은 키를 생략해도 허용 목록 검사를 피하지 못하게 한다.
    // 키 앞에 접두사만 추가하므로 따옴표·주석·여러 줄 값의 해석은 내장 파서가 맡는다.
    const prefix = 'TRIPMONEY_ENV_';
    const named = parseEnv(source.replace(/^([ \t]*(?:export[ \t]+)?)([^\s=#]+)([ \t]*=)/gm, `$1${prefix}$2$3`));
    if (Object.keys(named).some((key) => !key.startsWith(prefix) || !allowed.has(key.slice(prefix.length)))) {
      return configurationError();
    }
    const parsed = parseEnv(source);
    const result: NodeJS.ProcessEnv = Object.create(null);
    for (const [key, value] of Object.entries(parsed)) {
      if (!allowed.has(key)) return configurationError();
      result[key] = value;
    }
    return result;
  } catch {
    return configurationError();
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { configurationError(); }
    }
  }
}
