# TripMoney KakaoCloud 재승인 체크리스트

목표: Agentic Player 10 공모전 요건에 맞춰, 기존 승인 버전과 동일한 11개 MCP tool을 KakaoCloud 배포 URL로 다시 심사 요청한다.

## 배포 표면

- MCP endpoint: `https://<kakao-cloud-domain>/mcp`
- Health endpoint: `https://<kakao-cloud-domain>/health`
- 실행 명령: `npm run start:kakao`
- Docker entrypoint: `Dockerfile`
- Container port: `8000`
- 기본 tools/list: 11개

기본 배포에서는 `TRIPMONEY_ENABLE_ITINERARY_RECOMMENDATION`을 설정하지 않는다. 이 값을 `true`로 설정하면 `recommendItinerary`가 추가되어 12개 tool이 되므로, 재승인 전에는 사용하지 않는다.

## KakaoCloud 환경변수

필수:

- `DATABASE_URL`: Supabase Postgres Transaction Pooler URL

권장:

- `TRIPMONEY_API_KEY`: PlayMCP Key/Token 인증에 등록할 값
- `NODE_ENV`: `production`

선택:

- `CLOVA_OCR_INVOKE_URL`: CLOVA OCR 영수증 Invoke URL
- `CLOVA_OCR_SECRET`: CLOVA OCR Secret

설정하지 말 것:

- `TRIPMONEY_PROTOTYPE_MODE=mock`
- `TRIPMONEY_ENABLE_ITINERARY_RECOMMENDATION=true`

## 배포 후 확인

```bash
curl -s https://<kakao-cloud-domain>/health

curl -s https://<kakao-cloud-domain>/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'x-api-key: <TRIPMONEY_API_KEY>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

tools/list에 아래 11개만 보여야 한다.

- `createTrip`
- `addMember`
- `addSchedule`
- `updateSchedule`
- `addExpense`
- `scanReceipt`
- `getBudgetSummary`
- `calculateSettlement`
- `updateExpense`
- `deleteExpense`
- `createShareLink`

## PlayMCP 재심사

1. PlayMCP 개발자 콘솔에서 MCP endpoint를 KakaoCloud URL로 등록한다.
2. 인증 방식은 기존과 동일하게 Key/Token 인증을 사용한다.
3. 필드명은 `x-api-key`로 설정한다.
4. 등록 및 심사 요청을 보낸다.
5. 승인 후 공개 범위를 전체 공개로 바꾼다.
6. Agentic Player 10 예선 접수를 다시 진행한다.
