import { fileURLToPath } from 'node:url';
import { runDbSetup } from './db-setup.js';

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  if (process.argv.length !== 2) throw new Error();
  console.log('TripMoney 신규 개발 DB 로컬 설정');
  console.log('이미 설정한 세 계정의 비밀번호를 한 번씩 입력하고 Enter를 누르세요.');
  console.log('입력 글자와 별표는 표시되지 않습니다. URL 인코딩·0600 저장은 자동 처리합니다.');
  console.log('DB 비밀번호 변경·접속 활성화·외부 연결은 이 도우미가 수행하지 않습니다.');
  console.log('취소는 Ctrl+C입니다. 세 입력이 끝나기 전에는 기존 파일을 변경하지 않습니다.\n');
  await runDbSetup({ input: process.stdin, output: process.stdout,
    path: fileURLToPath(new URL('../.env.db-test', import.meta.url)), signal: controller.signal });
  console.log('저장 완료. Codex 채팅에 "입력 완료"라고 알려주세요. 비밀번호는 보내지 마세요.');
} catch {
  console.error('customer_db_setup_not_saved: 취소되었거나 입력·파일 조건을 확인하지 못했습니다. 오류 원문은 출력하지 않습니다.');
  process.exitCode = 78;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
