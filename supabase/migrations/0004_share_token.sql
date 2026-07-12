-- 읽기 전용 공유 토큰 (share_token)
-- trip_key(api_key)는 전체 권한, share_token 은 조회 전용 접근을 부여한다.
-- null = 공유 비활성. createShareLink 툴로 발급/폐기한다.
alter table tripmoney.trips
  add column if not exists share_token text;
