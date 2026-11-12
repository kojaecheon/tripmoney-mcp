-- 원격 적용 버전: 20261020053810.
-- PostgreSQL 17의 CREATEROLE 자동 ADMIN 멤버십에는 SET 권한이 없다.
-- 실제 RLS 검증용 관리자만 실행 역할로 전환할 수 있게 한다.
begin;
grant customer_app, customer_auth_runtime to postgres with inherit false, set true;
commit;
