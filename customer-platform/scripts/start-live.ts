import {readLiveStartup,startLiveServer} from './live-startup.js';
try {
 const startup=readLiveStartup(process.argv.slice(2),process.env);
 const running=await startLiveServer(startup);
 if(!running)console.log('customer_live_preflight_ok: 로컬 설정 검사를 마쳤습니다. 외부 연결은 실행하지 않았습니다.');
 else {
  const settlement=startup.options.enableSettlementClosure?'정산 마감 사용':'정산 마감 비활성';
  console.log(`customer_live_ready: 실제 DB·카카오 개발 연결, 지도·AI 합성, 메일 승인 최대 1회, ${settlement}.`);
  const stop=()=>{void running.close().catch(()=>{console.error('customer_live_shutdown_failed');process.exitCode=1;});};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  running.server.on('error',()=>{console.error('customer_live_server_failed');process.exitCode=1;stop();});
 }
} catch {
 console.error('customer_live_startup_blocked: 승인 플래그, 개발 대상, HTTPS 주소, 비밀 파일과 정산 마감 SQL 설치 상태를 확인해 주세요.');
 process.exitCode=78;
}
