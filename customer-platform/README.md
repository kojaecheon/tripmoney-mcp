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

경비 내역에서는 직접 입력, 영수증 이미지 미리보기, 카드 문자·텍스트 초안을 선택할 수 있다. 사진과 문자 원문은 브라우저에서 처리하고, 사용자가 경비를 저장할 때 장부에는 확인한 입력값만 남긴다.

일일·여행 최종 정산은 확정 후 공유 문구를 미리 보고 복사하거나, 지원 기기의 앱 선택창에서 공유할 수 있다. 자세한 장부는 해당 여행에 참여 중인 동행자가 로그인해 확인한다. 최종 확정 뒤 남은 잔액과 지급·취소 확인 대기 건이 모두 0이면 소유자가 정산을 마감할 수 있다. 재개해도 기존 확정과 마감 이력은 남는다.

## Gemini 무료 등급 시험

[Google AI Studio](https://aistudio.google.com/api-keys)에서 결제 등급이 **무료 등급**인 프로젝트의 인증 키(Auth key)를 확인한다. 키 자체로는 무료 등급을 판별할 수 없다. macOS의 zsh에서는 다음 명령으로 키를 화면에 표시하지 않고 입력할 수 있다.

```zsh
read -rs 'tripmoney_trial_key?Gemini 무료 API 키: '
TRIPMONEY_GEMINI_API_KEY="$tripmoney_trial_key" npm run start:local -- --gemini-free-trial
unset tripmoney_trial_key
```

로컬 화면에서 아래 두 가상 부산 여행 중 하나를 만든다. 시간대는 `Asia/Seoul`이다. 2인 여행은 먼저 편집자 초대를 발급하고 다른 `example.invalid` 계정으로 수락한다. 로그인 쿠키를 공유하지 않는 브라우저에서 참여하거나, 소유자가 로그아웃한 뒤 동행자 계정으로 다시 로그인한다.

| 여행 기간 | 인원 | 전체 예산 | 관심사 | 여행 속도 |
| --- | --- | --- | --- | --- |
| 2026-12-12 하루 | 1명 | 60,000원 | `시장, 산책` | 여유롭게 |
| 2026-12-12부터 2026-12-14까지 | 2명 | 120,000원 | `시장, 바다` | 적당하게 |

추천을 누르면 Gemini 3.1 Flash-Lite에 표의 가상 여행 조건을 전송한다. 서버 실행당 최대 한 번 호출하며 날짜마다 후보 한 건을 받는다. 선택한 후보만 일정에 저장된다. 장소와 영업 정보는 사용자가 확인한다.

부산 예시에 없는 가상 여행을 시험하려면 위 명령을 실행할 때 `--gemini-free-trial`을 `--gemini-free-recommendations`로 바꾼다. 최대 14일의 여행을 만들고 관심사와 여행 속도를 선택한 뒤, 추천 화면에서 전송 항목을 확인하고 동의하면 날짜마다 후보 한 건을 받는다. 여행지와 관심사에는 개인정보를 입력하지 않는다. 추천에는 일행 전체 기준의 예상 비용이 표시된다. Google은 무료 등급의 입력과 응답을 제품 개선에 사용할 수 있다. [Gemini API 이용약관](https://ai.google.dev/gemini-api/terms)

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

최종 마감은 로컬 체험에 활성화했다. 개발 DB 연결에서 활성화하기 전에 [정산 마감 증분 검토안](supabase/reviewed/settlement-closure.sql)의 적용과 복구를 검증한다.

Chrome 로그인과 Mac 카카오톡 개발 채널에서 여행 연결, 경비 확인 저장, 중복 방지, 연결 해제, DB 재조회까지 개발 환경에서 검증했다. 지도와 AI 실제 호출은 후속 검증 범위다.
