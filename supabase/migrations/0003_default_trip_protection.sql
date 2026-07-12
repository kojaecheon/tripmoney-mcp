-- C2 (방 단위 격리): 모든 여행방에 접근키(api_key)를 기본 부여한다.
-- 배경: requireTripKey 는 trips.api_key 가 NULL 이면 통과(no-op)였다.
--       기본값을 부여하고 NOT NULL 로 만들어, MCP 의 모든 조회·수정 도구가
--       항상 trip_key 검증을 강제하도록 한다. (web.ts 의 직접 insert 경로 포함)
-- gen_random_uuid() 는 Postgres 코어 내장(0001 에서 이미 사용 중).

-- 1) 신규 행 자동 키 발급 (하이픈 제거한 32자 hex)
alter table tripmoney.trips
  alter column api_key set default replace(gen_random_uuid()::text, '-', '');

-- 2) 기존 NULL 행 backfill
--    주의: 기존에 보호되지 않던 방은 이 시점부터 키가 생기며,
--    그 키는 아래 SELECT 로 한 번 확인해 안전한 곳에 보관해야 한다.
update tripmoney.trips
   set api_key = replace(gen_random_uuid()::text, '-', '')
 where api_key is null;

-- 3) 이후 NULL 금지
alter table tripmoney.trips
  alter column api_key set not null;

-- 백필된 키 확인용 (배포 시 1회 실행 후 결과를 안전 보관):
--   select id, name, api_key from tripmoney.trips order by created_at;
