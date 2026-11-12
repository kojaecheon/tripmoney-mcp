-- 실제 COMMIT에서 P0422로 실패해야 한다. 성공이면 owner 무결성 결함이다.
begin;
insert into customer.trips(id,owner_user_id,name,destination,start_date,end_date,time_zone,
  budget_krw,settlement_mode,daily_time)
  values(pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),'합성 owner 누락','서울',
    '2026-11-01','2026-11-02','Asia/Seoul',0,'daily','20:00');
commit;
