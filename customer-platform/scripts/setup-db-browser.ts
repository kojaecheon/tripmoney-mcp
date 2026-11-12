import { fileURLToPath, pathToFileURL } from 'node:url';
import { startDbBrowserSetup } from './db-browser-setup.js';

function exitAfterFlush(code: number): Promise<never> {
  return new Promise(() => {
    setTimeout(() => process.exit(code), 1000);
    let remaining = 2;
    for (const stream of [process.stdout, process.stderr]) {
      let done = false;
      const flushed = () => { if (!done) { done = true; if (--remaining === 0) process.exit(code); } };
      stream.once('error', flushed);
      try { stream.write('', flushed); } catch { flushed(); }
    }
  });
}
export async function runDbBrowserSetupCli(start: typeof startDbBrowserSetup = startDbBrowserSetup): Promise<never> {
  let code = 78;
  let server: Awaited<ReturnType<typeof startDbBrowserSetup>> | undefined;
  const cancel = () => { void server?.close(); };
  try {
    if (process.argv.length !== 2 || process.env.CUSTOMER_DB_AUTO_SETUP_APPROVED !== 'true') throw new Error();
    server = await start({ path: fileURLToPath(new URL('../.env.db-test', import.meta.url)) });
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    // 이 URL에는 비밀번호나 CSRF token이 들어가지 않는다.
    console.log(server.url);
    const result = await server.completed;
    code = result.status === 'saved' ? 0 : result.status === 'cancelled' ? 130 : result.fileSaved === false ? 78 : 1;
    if (result.status === 'cancelled') console.error('customer_db_browser_cancelled');
    else if (result.status === 'failed') console.error(result.code ?? 'customer_db_browser_setup_failed');
  } catch { console.error('customer_db_browser_setup_not_started'); }
  finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await server?.close();
  }
  return exitAfterFlush(code);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await runDbBrowserSetupCli();
