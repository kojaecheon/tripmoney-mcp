import { randomBytes } from 'node:crypto';
import { readHttpConfig } from '../server/http/config.js';
import { createCustomerAuthServer } from '../server/http/server.js';
import { createLocalRuntime } from '../server/local/runtime.js';
const runtime = createLocalRuntime();
const server = createCustomerAuthServer({
  config: readHttpConfig({ publicOrigin: 'http://127.0.0.1:8125', clientKey: randomBytes(32) }),
  authService: runtime.authService,
  identityService: runtime.identityService,
  ledgerService: runtime.ledgerService,
  placeService:runtime.placeService,
  draftService:runtime.draftService,
  recommendationService:runtime.recommendationService,
  kakaoLocalService:runtime.kakaoLocalService,
  changesService:runtime.changesService,
});
server.once('error', () => {
  console.error('로컬 서버를 시작할 수 없습니다. 127.0.0.1:8125 포트 사용 여부를 확인해 주세요.');
  runtime.close(); process.exitCode = 1;
});
server.listen(8125, '127.0.0.1', () => console.log('TripMoney 로컬 체험: http://127.0.0.1:8125 (실제 메일 미발송, 인증번호 123456)'));
const close = () => { runtime.close();server.close(); };
process.once('SIGINT', close); process.once('SIGTERM', close);
