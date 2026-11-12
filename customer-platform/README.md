# TripMoney 고객 플랫폼

여행을 만들고 동행자와 일정, 예산, 경비, 정산을 관리하는 고객용 웹 플랫폼이다.

## 로컬에서 실행

Node.js 22 환경에서 다음 명령을 실행한다.

```sh
cd customer-platform
npm ci
npm run start:local
```

[로컬 체험 화면](http://127.0.0.1:8125/)에서 `owner@example.invalid`와 인증번호 `123456`으로 로그인한다. 별도 브라우저에서 다른 `example.invalid` 주소로 로그인하면 동행자 초대를 체험할 수 있다. 이 모드는 메모리에 저장하며 서버를 종료하면 초기화된다. 지도, 추천, 카카오 체험에는 합성 데이터를 사용한다.

## 검증

```sh
npm run typecheck
node --import tsx --test --test-concurrency=4 --test-reporter=spec tests/unit/*.test.ts
npm run test:http
```

단위와 HTTP 테스트는 합성 입력과 로컬 서버로 실행한다. 실제 DB 검증은 `test:db`와 `tests/db/`에 있으며 전용 개발 DB 연결 설정이 필요하다.

## 개발 연결

`start:live`는 지정된 개발 DB, 인증 제공자, 카카오 개발 채널을 조립한다. 로컬 설정 파일 `.env.db-test`, `.env.provider-setup`, `.customer-live/keys.env`와 연결별 승인 플래그가 필요하다. `--preflight`는 설정을 검사하고 외부 연결 없이 종료한다. 실제 메일 발송은 기본 비활성이며, 로컬 설정의 수신 주소와 실행 인자가 일치하고 해당 주소의 일회용 허가 파일을 검증해야 활성화된다.

[DB 변경 이력](supabase/migrations/)과 [영구 저장 검토 SQL](supabase/reviewed/durable-store.sql)은 개발 DB 구조를 확인하는 자료다. SQL 적용은 백업과 대상 확인 후 별도로 수행한다. 기본 실행과 CI는 SQL을 적용하지 않는다.

Chrome 로그인과 Mac 카카오톡 개발 채널에서 여행 연결, 경비 확인 저장, 중복 방지, 연결 해제, DB 재조회까지 개발 환경에서 검증했다. 지도와 AI 실제 호출은 후속 검증 범위다.
