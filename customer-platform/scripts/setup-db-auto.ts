import { fileURLToPath, pathToFileURL } from 'node:url';
import { AutoDbSetupError, runAdminDbSetup } from './db-auto-setup.js';

export async function runDbAutoSetupCli(run: (signal: AbortSignal) => Promise<void>): Promise<never> {
  let exitCode = 0;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    await run(controller.signal);
    console.log('저장 완료. Codex 채팅에 "입력 완료"라고 알려주세요.');
    console.log('두 서비스 접속은 아직 비활성 상태입니다. Codex가 확인 후 활성화와 실제 DB 테스트를 이어갑니다.');
  } catch (error) {
    console.error(error instanceof AutoDbSetupError ? error.message : 'customer_db_auto_setup_not_started');
    console.error('자동 설정이 완료되지 않았습니다. 오류 코드만 Codex에 알려주세요. 비밀번호나 화면은 보내지 마세요.');
    exitCode = error instanceof AutoDbSetupError && error.fileSaved ? 1 : 78;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
  // Client.end의 대기 상한 뒤에도 남는 핸들은 이 전용 CLI의 종료 경계에서 정리한다.
  // 두 출력 스트림의 기존 쓰기를 마친 후 종료해 고정 결과 메시지를 보존한다.
  return new Promise<never>(() => {
    // 출력 대상이 응답하지 않아도 종료를 무한히 미루지 않는다.
    setTimeout(() => process.exit(exitCode), 1000);
    let remaining = 2;
    for (const stream of [process.stdout, process.stderr]) {
      let completed = false;
      const flushed = () => {
        if (completed) return;
        completed = true;
        if (--remaining === 0) process.exit(exitCode);
      };
      stream.once('error', flushed);
      try { stream.write('', flushed); } catch { flushed(); }
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await runDbAutoSetupCli(async signal => {
  if (process.argv.length !== 2 || process.env.CUSTOMER_DB_AUTO_SETUP_APPROVED !== 'true'
    || process.stdin.isTTY !== true || process.stdout.isTTY !== true) throw new Error();
  console.log('TripMoney 전용 개발 DB 자동 설정: tripmoney-customer-dev');
  console.log('관리자 비밀번호만 한 번 입력하고 Enter를 누르세요. 글자와 별표는 보이지 않습니다.');
  console.log('두 서비스 비밀번호는 자동 생성·재설정하고 0600·Git 제외 파일에 저장합니다.');
  console.log('관리자 비밀번호·기존 DB·결제 설정은 변경하지 않습니다. 취소는 Ctrl+C입니다.\n');
  await runAdminDbSetup({ input: process.stdin, output: process.stdout,
    path: fileURLToPath(new URL('../.env.db-test', import.meta.url)), signal });
});
