// 실제 터미널의 숨김 입력을 합성 값으로만 검사한다. 실제 .env 파일은 사용하지 않는다.
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { runDbSetup } from '../scripts/db-setup.js';
import { readDbTestConfig } from '../server/db/config.js';

const directory = fs.mkdtempSync(join(tmpdir(), 'tripmoney-db-setup-tty-'));
const path = join(directory, '.env.db-test');
fs.writeFileSync(path, 'CUSTOMER_DB_TEST_APPROVED=true\n', { mode: 0o600 });
const cancellationExpected = process.argv[2] === '--cancel';
try {
  await runDbSetup({ input: process.stdin, output: process.stdout, path });
  if (cancellationExpected) throw new Error();
  const config = readDbTestConfig(parseEnv(fs.readFileSync(path, 'utf8')));
  const expected = ['synthetic-admin-@#%', 'synthetic-app-한글🙂', 'synthetic-auth-:/$'];
  if ([config.adminUrl, config.appUrl, config.authUrl].some((url, index) =>
    decodeURIComponent(new URL(url).password) !== expected[index])) throw new Error();
  console.log('synthetic_tty_setup_pass');
} catch {
  if (cancellationExpected && process.stdin.isRaw !== true
    && fs.readFileSync(path, 'utf8') === 'CUSTOMER_DB_TEST_APPROVED=true\n') {
    console.log('synthetic_tty_cancel_pass');
  } else {
    console.error('synthetic_tty_setup_failed');
    process.exitCode = 1;
  }
} finally {
  fs.unlinkSync(path);
  fs.rmdirSync(directory);
}
