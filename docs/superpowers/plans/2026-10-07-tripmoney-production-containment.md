# TripMoney 운영 경로 차단 Implementation Plan

Production의 레거시 데모와 베타 접수를 닫고, 민감 기능 없는 합성 시연만 보존한다.

> 실행 담당: `superpowers:executing-plans`를 사용해 작업별로 진행한다. 체크박스로 진행 상태를 기록한다. Codex 구현 후 Claude가 읽기 전용으로 독립 검토한다. 이 계획은 병렬 코드 수정이나 운영 변경을 승인하지 않는다.

- Goal: 00A의 첫 독립 결과물인 운영 HTTP 차단, 중앙 설정, 안전한 공개 응답, 계좌 기능 중지를 검증 가능한 코드로 만든다.
- Architecture: 환경 해석은 중앙 모듈, 접근 판단은 순수 함수로 분리한다. 모든 서버의 선행 guard와 명시적 정적 파일 목록을 함께 사용한다. DB 역할 분리 전에는 레거시 DB 실행을 중단하고 합성 메모리 데모만 사용한다.
- Tech Stack: TypeScript ESM, Node.js 22, 현재 pg/zod/MCP SDK, tsx와 node:test, Vercel Node API, GitHub Actions.
- Spec: [00 신뢰 기반 하위 설계](../specs/2026-09-02-tripmoney-trust-foundation-design.md), [전체 다음 개발 순서](2026-10-07-tripmoney-next-development-roadmap.md)
- Status: 사용자 요청에 따른 계획안. 구현 미착수. 00 하위 작성본 최종 승인 상태와 별도 코드 실행 승인을 실행 전에 확인한다.
- Baseline: `a73d38a`, main. 현재 작업 트리는 깨끗하며 기존 목업 작업은 보존한다.

## Global Constraints

- 검증 런타임: Node.js 22. 현재 로컬 Node 25의 통과 기록으로 Node 22 CI를 대신하지 않는다.
- 환경: `local|preview|production|test`. Vercel Preview의 `NODE_ENV=production`을 Production 판정 근거로 단독 사용하지 않는다.
- Production: `/mcp`, `/api/mcp`, `/prototype`, `/app.html`, `/api/web`와 직접 별칭은 모든 메서드 404. 데모 플래그로 열 수 없다.
- 접수: 00A-1의 `/api/beta`는 모든 환경에서 503. 실제 접수, 결제, 업로드, 계좌, 정산 확정, 조직 기능은 닫는다.
- 플래그: 정확한 문자열 `true`만 인정. 누락·오타·환경 충돌은 해당 기능을 닫는다.
- DB: 역할 분리 전에는 레거시 `DATABASE_URL` 연결과 DB fallback을 사용하지 않는다. 합성 메모리 모드는 명시적으로 선택한다.
- 계좌: 모든 환경에서 입력·출력·Toss 딥링크·계좌 포함 내보내기 금지. 산술 계산은 보존한다.
- 공개 진단: `status: ok|unavailable`, `request_id`만 반환. 원문 예외, SQL, DSN, 토큰, 요청 본문, 연락처를 기록하지 않는다.
- CI: High/Critical 런타임 취약점은 병합·출시 차단. 예외는 명세가 정한 창업자 승인 기록과 만료일이 필요하다.
- 범위 제외: 0008/0009 적용, 직원 인증 구현, 고객 신청 저장, 외부 저널, 백업 실행, 주문·결제·영수증·실제 정산.

## 파일과 인터페이스

| 파일 | 책임 |
|---|---|
| `lib/config.ts` 신규 | 환경·플래그·키·loopback 설정 해석. env 입력의 유일한 제품 설정 진입점 |
| `lib/surfacePolicy.ts` 신규 | 표면별 허용/거부의 순수 판단 |
| `lib/safeResponse.ts` 신규 | 최소 공개 오류/health와 allowlist 운영 로그 |
| `lib/payoutBoundary.ts` 신규 | 금지된 계좌·송금 입력 검출 |
| `api/mcp.ts`, `api/web.ts`, `api/beta.ts`, `api/health.ts` 수정 | 선행 경계, 최소 응답. 금지 요청에서 내부 로직 실행 없음 |
| `scripts/kakao-server.ts`, `scripts/prototype-server.mjs` 수정, `scripts/prototype-server.d.mts` 신규 | import 시 listen 없는 factory, 같은 정책과 loopback 기본값. mjs factory의 타입 선언 |
| `lib/db.ts`, `lib/prototypeStore.ts`, `lib/readiness.ts`, `lib/betaLeads.ts`, `lib/ocr.ts` 수정 | 레거시 DB 사용 차단, 명시적 합성 모드, 접수/OCR 직접 호출 차단, 공개 진단 분리 |
| `lib/server.ts`, `lib/mcpEngine.ts`, `lib/links.ts`, `lib/settlementExport.ts`, `public/app.html` 수정 | 입력 거부와 계좌 출력 제거 |
| `scripts/build-public.ts` 신규, `vercel.json`, `public/index.html` 수정 | 랜딩 전용 정적 산출물, 접수 중단 표시 |
| `test/security/*.test.ts` 신규 | 환경·HTTP·정적 산출물·계좌·로그 카나리 검증 |
| `package.json`, `package-lock.json`, `.nvmrc`, `.gitignore`, `.github/workflows/00a-boundary.yml` 수정/신규 | 재현 가능한 설치와 첫 경계 CI |
| `docs/superpowers/reviews/2026-10-07-tripmoney-00a-containment-verification.md` 신규 | 실행 시 작성하는 비식별 결과와 Claude 검토 기록 |

테스트는 `node:test`와 `node:assert/strict`를 tsx로 실행한다. `npm run test:security`는 `tsx --test test/security/*.test.ts`, `npm run test:mockups`는 `node --test docs/design/mockups/tests/*.test.cjs`로 정의한다. 신규 테스트 파일은 tsconfig 기존 포함 패턴에서 누락되지 않도록 확인한다.

## Task 1: 의존성 차단과 Node 22 재현

파일: `package.json`, `package-lock.json`, `.nvmrc`, `test/security/dependency-policy.test.ts`.

입력: 현재 lockfile과 npm advisory. 출력: 런타임 High/Critical 처리 결과, Node 22 설치·회귀 증거, 보안 테스트 실행 스크립트.

- [ ] audit 실패 기준을 먼저 기록한다.

```bash
npm audit --omit=dev --audit-level=high
npm explain proxy-addr
npm explain @modelcontextprotocol/sdk
npm explain pptxgenjs
rg -n 'docx|pptxgenjs' api lib scripts test package.json
shasum -a 256 package-lock.json
```

기대: 현재 audit는 종료 코드 1, Critical 1/High 6/Moderate 3. 예외·DSN·고객 입력은 기록하지 않고 패키지 이름, advisory, lockfile 해시만 검증 기록에 남긴다.

- [ ] 운영 실행 코드에 문서 전용 패키지를 다시 넣지 못하는 실패 테스트를 작성한다.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("문서 전용 패키지는 운영 의존성에 없다", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.dependencies.docx, undefined);
  assert.equal(pkg.dependencies.pptxgenjs, undefined);
});
```

실행: `npx tsx --test test/security/dependency-policy.test.ts`. 기대: 현재 두 의존성이 존재해 실패.

- [ ] Node 22를 선택하고 `.nvmrc`에는 `22`, package.json engines에는 `{"node":"22.x"}`를 기록한다. 문서 생성 실행 코드가 없다는 재확인 후 미사용 런타임 패키지를 제거한다.

```bash
npm uninstall docx pptxgenjs
npm update @modelcontextprotocol/sdk
npm update
npm ci
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
```

`npm update`의 변경 범위는 lockfile diff와 MCP API 회귀로 검토한다. audit의 강제 downgrade나 `npm audit fix --force`를 실행하지 않는다. High/Critical이 남으면 영향 경로와 공식 advisory의 수정 범위를 확인해 개별 갱신한다. 해결 또는 명세에 맞는 승인 예외 없이 통과로 표시하지 않는다. 전체 audit도 기록하며 dev 도구 위험을 숨기지 않는다.

- [ ] 아래 package.json 스크립트를 추가하고 Node 22에서 검증한다.

```json
{
  "test:security": "tsx --test test/security/*.test.ts",
  "test:mockups": "node --test docs/design/mockups/tests/*.test.cjs"
}
```

```bash
node --version
npm run typecheck
npm test
npm run smoke:mcp
npm run test:security
npm run test:mockups
```

기대: Node 22, 회귀 실패 0, 기본 MCP 도구 11개. 해당 시점 audit 결과와 전체 테스트 수를 기록한다.

- [ ] 검증 후 작업 파일만 커밋한다.

```bash
git add package.json package-lock.json .nvmrc test/security/dependency-policy.test.ts
git commit -m "chore: 운영 의존성과 Node 22 검증 기준 정비"
```

## Task 2: 중앙 설정과 닫힌 접근 정책

파일: `lib/config.ts`, `lib/surfacePolicy.ts`, `test/security/config.test.ts`, `test/security/surface-policy.test.ts`.

소비 인터페이스: env 문자열 사전. 생산 인터페이스:

```ts
export const FEATURE_KEYS = [
  "REAL_DATA_INTAKE_ENABLED", "BETA_LEAD_INTAKE_ENABLED",
  "MCP_DEMO_ENABLED", "DEMO_SURFACES_ENABLED", "PAYMENTS_ENABLED",
  "RECEIPT_UPLOAD_ENABLED", "PAYOUT_METHODS_ENABLED",
  "SETTLEMENT_FINALIZATION_ENABLED", "ORGANIZATIONS_ENABLED",
] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];
export type AppEnvironment = "local" | "preview" | "production" | "test";
export type AppConfig = {
  environment: AppEnvironment | null;
  valid: boolean;
  issues: readonly ("invalid_environment" | "environment_conflict" | "invalid_flag" | "invalid_port" | "invalid_host")[];
  flags: Readonly<Record<FeatureKey, boolean>>;
  syntheticMode: "memory" | "disabled";
  legacyDatabaseEnabled: false;
  apiDemoKey: string | null;
  webDemoKey: string | null;
  listener: { host: "127.0.0.1"; port: number };
};
export function readAppConfig(env: NodeJS.ProcessEnv): AppConfig;
export type Surface = "mcp" | "demoWeb" | "prototype" | "beta";
export type SurfaceDecision = { allowed: true } | { allowed: false; status: 401 | 404 | 503 };
export function decideSurface(surface: Surface, config: AppConfig, suppliedHeaderKey?: string): SurfaceDecision;
```

- [ ] 다음 실패 테스트를 작성한다. 환경 해석은 config.test.ts, 접근 판단은 surface-policy.test.ts로 나눠 기록한다.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readAppConfig } from "../../lib/config.js";
import { decideSurface } from "../../lib/surfacePolicy.js";
test("Preview의 NODE_ENV production은 데모 운영환경으로 오인하지 않는다", () => {
  const cfg = readAppConfig({
    TRIPMONEY_APP_ENV: "preview", VERCEL_ENV: "preview", NODE_ENV: "production",
    TRIPMONEY_PROTOTYPE_MODE: "mock", DEMO_SURFACES_ENABLED: "true",
    TRIPMONEY_WEB_DEMO_KEY: "synthetic-test-key",
  });
  assert.equal(cfg.environment, "preview");
  assert.deepEqual(decideSurface("demoWeb", cfg, "synthetic-test-key"), { allowed: true });
});
test("Production에서는 플래그와 올바른 키도 데모를 열지 않는다", () => {
  const cfg = readAppConfig({ TRIPMONEY_APP_ENV: "production", VERCEL_ENV: "production",
    MCP_DEMO_ENABLED: "true", DEMO_SURFACES_ENABLED: "true", TRIPMONEY_API_KEY: "synthetic-test-key" });
  assert.deepEqual(decideSurface("mcp", cfg, "synthetic-test-key"), { allowed: false, status: 404 });
  assert.deepEqual(decideSurface("beta", cfg), { allowed: false, status: 503 });
});
```

실행: `npx tsx --test test/security/config.test.ts test/security/surface-policy.test.ts`. 기대: 신규 모듈 부재로 실패.

- [ ] 위 타입과 아래 결정 계약을 구현한다.

```ts
export function decideSurface(surface: Surface, config: AppConfig, suppliedHeaderKey?: string): SurfaceDecision {
  if (surface === "beta") return { allowed: false, status: 503 };
  if (config.environment === "production" || config.environment === null)
    return { allowed: false, status: 404 };
  if (!config.valid || config.syntheticMode !== "memory") return { allowed: false, status: 503 };
  const enabled = surface === "mcp" ? config.flags.MCP_DEMO_ENABLED : config.flags.DEMO_SURFACES_ENABLED;
  if (!enabled) return { allowed: false, status: 404 };
  if (surface === "prototype") return { allowed: true };
  const expected = surface === "mcp" ? config.apiDemoKey : config.webDemoKey;
  if (!expected) return { allowed: false, status: 503 };
  return suppliedHeaderKey === expected ? { allowed: true } : { allowed: false, status: 401 };
}
```

`readAppConfig` 구현 계약: `TRIPMONEY_APP_ENV`는 명시값만 인정. VERCEL_ENV production/preview/development는 production/preview/local로 대조, 알 수 없는 환경값이나 불일치는 environment=null, valid=false로 처리한다. 따라서 VERCEL_ENV=production과 앱 preview가 충돌해도 데모는 404다. NODE_ENV만으로 환경을 선택하지 않는다. 각 플래그는 true/false/누락만 정상 입력, 그 외는 false와 invalid_flag. 이 단계는 real intake와 모든 후속 기능 플래그를 입력과 무관하게 false로 고정한다. Production과 불명확한 환경에서는 데모 플래그도 false. mock은 정상 non-production의 명시 입력일 때만 memory. DB 사용은 항상 false. HOST는 누락/127.0.0.1/localhost만 loopback으로 정규화하고 다른 입력은 invalid_host. PORT는 누락 시 3000, 지정 시 1~65535 정수만 허용한다. 키와 env 객체는 진단 로그에 직렬화하지 않는다.

- [ ] 누락, TRUE/1/오타, 환경 충돌, 키 누락, query key 무시, Production mock 요청, 잘못된 HOST/PORT를 표 기반 테스트에 추가한다. 각 경우 결정 결과를 401/404/503으로 명시한다. 전체 타입 검사와 Task 2 테스트가 통과해야 한다.
- [ ] 검증 후 커밋한다.

```bash
git add lib/config.ts lib/surfacePolicy.ts test/security/config.test.ts test/security/surface-policy.test.ts
git commit -m "feat: 환경과 데모 접근 정책 중앙화"
```

## Task 3: 모든 서버 선행 차단과 안전 응답

파일: 4개 `api/*.ts`, `lib/safeResponse.ts`, `lib/db.ts`, `lib/readiness.ts`, `lib/prototypeStore.ts`, `lib/betaLeads.ts`, `lib/ocr.ts`, `lib/server.ts`, 두 서버 스크립트와 mjs 타입 선언, `test/security/http-boundary.test.ts`, `test/security/safe-response.test.ts`.

소비: Task 2의 `AppConfig`, `decideSurface`. 생산:

```ts
export type PublicHealth = { status: "ok" | "unavailable"; request_id: string };
export type OperationalEvent = { request_id: string; action: "surface_denied" | "health" | "request_failed";
  status: number; latency_ms: number };
export function publicHealth(ready: boolean, requestId: string): PublicHealth;
export function writeOperationalEvent(event: OperationalEvent, sink: (line: string) => void): void;
export function sendSafeStatus(res: import("node:http").ServerResponse, status: number, requestId: string, method?: string): void;
export function createKakaoServer(config: AppConfig): import("node:http").Server;
// prototype-server.mjs와 prototype-server.d.mts의 factory 계약
export function createPrototypeServer(config: AppConfig): import("node:http").Server;
```

- [ ] 공개 진단에 내부 정보가 추가되지 않는 실패 테스트를 작성한다.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { publicHealth, writeOperationalEvent } from "../../lib/safeResponse.js";
test("공개 health와 로그는 허용 필드만 출력한다", () => {
  assert.deepEqual(publicHealth(false, "request-test"), { status: "unavailable", request_id: "request-test" });
  const lines: string[] = [];
  const event = { request_id: "request-test", action: "request_failed" as const, status: 503,
    latency_ms: 1, error: "synthetic-contact-canary@example.invalid", body: "token-canary" };
  writeOperationalEvent(event, line => lines.push(line));
  assert.equal(lines.length, 1);
  assert.equal(lines.join("").includes("canary"), false);
});
```

실행: `npx tsx --test test/security/safe-response.test.ts`. 기대: 모듈 부재로 실패.

- [ ] API 핸들러 최상단에 guard를 넣는다. 판단은 CORS, OPTIONS, 본문 처리, buildServer, DB 호출보다 먼저 실행한다.

```ts
const config = readAppConfig(process.env);
const requestId = crypto.randomUUID();
const headerKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined;
const decision = decideSurface("mcp", config, headerKey);
if (!decision.allowed) {
  sendSafeStatus(res, decision.status, requestId, req.method);
  return;
}
```

`process.env`의 전체 객체는 중앙 해석 함수에 전달하는 진입점에서만 사용한다. 개별 env 읽기는 제거한다. web의 키는 `x-demo-key`로 통일하고 query `demo_key`는 인정하지 않는다. 원문 예외를 API JSON/MCP 오류 message로 반환하지 않는다. 404는 일반 오류와 request_id, 503은 unavailable과 request_id, HEAD는 동일 상태·헤더와 빈 본문으로 처리한다. 거부 응답에 wildcard CORS를 넣지 않는다.

- [ ] `lib/safeResponse.ts`는 들어온 객체를 spread하지 않고 지정 필드만 직렬화한다.

```ts
export function publicHealth(ready: boolean, requestId: string): PublicHealth {
  return { status: ready ? "ok" : "unavailable", request_id: requestId };
}
export function writeOperationalEvent(event: OperationalEvent, sink: (line: string) => void): void {
  sink(JSON.stringify({ request_id: event.request_id, action: event.action,
    status: event.status, latency_ms: event.latency_ms }));
}
```

health는 최소 계약만 응답한다. 코드 import, DB 비밀번호 미설정, 거부된 DB 초기화에서도 원문 에러를 출력하지 않는다. 현재 서비스 접수는 닫혀 있으므로 준비상태를 false로 반환하며 unavailable/503을 정상 안전 상태로 검사한다.

- [ ] 두 서버 스크립트는 `createKakaoServer(config)`와 `createPrototypeServer(config)`를 export한다. `import.meta.url`과 실행 파일 경로를 대조한 직접 실행 분기에서만 listen한다. factory 테스트는 port 0으로 실행하고 finally에서 server.close한다. prototype 스크립트의 env 강제 mock 대입을 제거하고 config.syntheticMode를 사용한다. `scripts/prototype-server.d.mts`에는 `import type { AppConfig } from "../lib/config.js"; export function createPrototypeServer(config: AppConfig): import("node:http").Server;`를 선언한다.
- [ ] `lib/db.ts`의 q/one/tx 계약은 유지하되 역할별 안전 연결 구현 전에는 getPool에서 `legacy_database_disabled` 고정 오류로 연결을 중단한다. DB 생성 자체가 일어나지 않는 spy를 검증한다. prototype은 memory 모드를 명시적으로 확인하며 DB 누락 시 자동 성공 fallback을 하지 않는다. `/api/beta`는 submitBetaLead를 호출하지 않고 503으로 종료한다. 기존 베타 저장 함수를 제품 진입점에서 실행할 수 없게 한다.
- [ ] `submitBetaLead`와 `betaLeadStats`도 직접 호출 시 `beta_intake_disabled` 고정 오류로 종료하고 env 접근·메모리 저장 성공을 제거한다. `lib/ocr.ts`의 `isConfigured()`는 false, `runReceiptOcr`는 `receipt_upload_disabled`로 종료한다. 이미지/base64 입력은 데모 진입점에서도 거부하며 외부 OCR fetch는 0회로 검사한다. URL·base64 순수 검증 함수는 기존 단위 테스트를 위해 보존한다. `lib/server.ts`의 itinerary recommendation env 분기는 비활성으로 고정해 도구 목록 11개를 유지한다. 이미지 없는 합성 금액 계산 시연만 허용한다.

```ts
export function isConfigured(): boolean { return false; }
export async function runReceiptOcr(_image: {
  url?: string; dataBase64?: string; format?: string;
}): Promise<ReceiptParse> {
  throw new Error("receipt_upload_disabled");
}
export async function submitBetaLead(_input: BetaLeadInput): Promise<{ id: string; stored: "database" | "memory" }> {
  throw new Error("beta_intake_disabled");
}
```

실행 코드의 `process.env` 검색 결과는 `readAppConfig(process.env)` 진입점 외에는 남기지 않는다. 이번 단계에서 사용하지 않는 provider 비밀값을 config에 새로 추가하지 않는다.
- [ ] HTTP 매트릭스 테스트를 작성한다.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readAppConfig } from "../../lib/config.js";
import { createKakaoServer } from "../../scripts/kakao-server.js";
import { createPrototypeServer } from "../../scripts/prototype-server.mjs";

async function response(port: number, method: string, path: string) {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method, path }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("synthetic_http_test_timeout")));
    req.end();
  });
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}
const methods = ["GET", "POST", "HEAD", "OPTIONS", "DELETE"];
const deniedPaths = ["/mcp", "/api/mcp", "/prototype", "/app.html", "/api/web",
  "/mcp/", "/MCP", "/%6dcp", "/%61pi/mcp", "/api/web?action=listTrips&demo_key=synthetic-test-key"];
for (const factory of [createKakaoServer, createPrototypeServer]) {
  test(`${factory.name}: Production HTTP 경계`, async () => {
    const server = factory(readAppConfig({ TRIPMONEY_APP_ENV: "production", VERCEL_ENV: "production",
      MCP_DEMO_ENABLED: "true", DEMO_SURFACES_ENABLED: "true", TRIPMONEY_PROTOTYPE_MODE: "mock" }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      for (const method of methods) {
        for (const path of deniedPaths) {
          const result = await response(port, method, path);
          assert.equal(result.status, 404, `${method} ${path}`);
        }
        assert.equal((await response(port, method, "/api/beta")).status, 503);
      }
    } finally { await close(server); }
  });
}
```

Vercel 핸들러도 node:http 임시 서버에서 직접 호출해 같은 매트릭스로 검사한다. Kakao 서버에 beta 경로도 동일 503으로 추가한다. 거부 경로에서 DB·MCP 생성·베타 저장 호출 횟수 0을 검사한다. 로컬 데모는 플래그 false/키 없음/잘못된 키/query 키 거부와 올바른 header 키의 합성 응답을 함께 검사한다.

- [ ] 실행: `npm run typecheck`, `npm run test:security`, `npm test`, `npm run smoke:mcp`. 기대: 전체 통과, production DB 연결 0회, 도구 목록 11개 유지.
- [ ] 검증 후 커밋한다.

```bash
git add api/mcp.ts api/web.ts api/beta.ts api/health.ts lib/safeResponse.ts lib/db.ts lib/readiness.ts lib/prototypeStore.ts lib/betaLeads.ts lib/ocr.ts lib/server.ts scripts/kakao-server.ts scripts/prototype-server.mjs scripts/prototype-server.d.mts test/security/http-boundary.test.ts test/security/safe-response.test.ts
git commit -m "fix: 운영 데모와 접수 경로 선행 차단"
```

## Task 4: 정적 파일 직접 접근 차단

파일: `scripts/build-public.ts`, `vercel.json`, `public/index.html`, `.gitignore`, `package.json`, `test/security/public-build.test.ts`.

소비: Task 3의 보호된 API와 기존 랜딩. 생산: `buildPublic(sourceDir: string, outputDir: string): Promise<void>`, 정적 파일은 index.html 한 개, API는 서버 경계 유지.

- [ ] 안전 산출물 테스트를 작성한다.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPublic } from "../../scripts/build-public.js";
test("정적 산출물은 랜딩만 포함한다", async () => {
  const output = await mkdtemp(join(tmpdir(), "tripmoney-public-test-"));
  try {
    await buildPublic("public", output);
    assert.deepEqual(await readdir(output), ["index.html"]);
    const html = await readFile(join(output, "index.html"), "utf8");
    assert.doesNotMatch(html, /\/api\/beta|\/prototype|\/app\.html/);
  } finally { await rm(output, { recursive: true, force: true }); }
});
```

실행: `npx tsx --test test/security/public-build.test.ts`. 기대: build 모듈 부재로 실패.

- [ ] 랜딩에서 데모 링크와 기존 개인정보 신청 폼·저장 JS를 제거하고 “현재 베타 신청을 받지 않습니다.”를 표시한다. 디자인 목업 원본은 수정하지 않는다. build는 public 폴더 전체 복사가 아니라 index.html만 복사한다.

```ts
import { mkdir, copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";
export async function buildPublic(sourceDir: string, outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const existing = await readdir(outputDir);
  if (existing.some(name => name !== "index.html")) throw new Error("unexpected_public_artifact");
  await copyFile(join(sourceDir, "index.html"), join(outputDir, "index.html"));
}
```

새 build 출력은 `dist/public`으로 고정한다. import 시 build 실행 없이 직접 실행일 때 `buildPublic("public", "dist/public")`를 호출한다. 기존 dist 산출물은 검증 없이 광역 삭제하지 않는다. 빌드 실패 시 공개 배포 중단.

- [ ] package.json에 `"build:public":"tsx scripts/build-public.ts"`를 추가하고 아래 Vercel 구성을 적용한다.

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": null,
  "buildCommand": "npm run build:public",
  "outputDirectory": "dist/public",
  "rewrites": [
    { "source": "/", "destination": "/index.html" },
    { "source": "/health", "destination": "/api/health" }
  ],
  "functions": { "api/mcp.ts": { "maxDuration": 30 } }
}
```

`outputDirectory`는 기본 public 대신 지정한 디렉터리를 제공하는 Vercel 설정이다. [Vercel 공식 설정](https://vercel.com/docs/project-configuration/vercel-json#outputdirectory). 실제 빌드 산출물과 Preview 검사에서 app.html, test-receipt.png, docs 목업, 소스 파일이 제공되지 않는지도 확인한다. API 보호와 정적 제외를 별도로 검사하며 rewrite 제거만으로 통과 처리하지 않는다.

- [ ] 실행: `npm run build:public`, `npx tsx --test test/security/public-build.test.ts`, `npm run test:mockups`. 기대: 정적 파일 1개, 목업 72개 기존 기준 유지. 배포 검증은 별도 권한 확인 후 수행한다.
- [ ] 검증 후 커밋한다.

```bash
git add scripts/build-public.ts vercel.json public/index.html package.json .gitignore test/security/public-build.test.ts
git commit -m "fix: 공개 배포 산출물에서 데모 화면 제외"
```

## Task 5: 계좌 입력·출력과 송금 딥링크 중지

파일: `lib/payoutBoundary.ts`, `lib/server.ts`, `lib/mcpEngine.ts`, `api/web.ts`, `lib/prototypeStore.ts`, `lib/links.ts`, `lib/settlementExport.ts`, `public/app.html`, `test/logic.test.ts`, `test/security/payout-boundary.test.ts`.

소비: 현재 정산 계산 함수와 합성 입력. 생산: `assertNoPayoutFields(value: unknown): void`. 금지 필드가 하나라도 있으면 `payout_fields_disabled` 고정 오류. 정산 계산의 금액 결과는 변경하지 않는다.

- [ ] 입력 거부와 출력 카나리 테스트를 먼저 작성한다.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { assertNoPayoutFields } from "../../lib/payoutBoundary.js";
import { buildSettlementExport } from "../../lib/settlementExport.js";
test("중첩 계좌 필드는 값이 비어 있어도 거부한다", () => {
  assert.throws(() => assertNoPayoutFields({ members: [{ account_no: null }] }), /payout_fields_disabled/);
});
test("레거시 계좌 카나리는 모든 내보내기에서 제외된다", () => {
  const result = buildSettlementExport({ tripName: "합성 여행", baseCurrency: "KRW", mode: "equal",
    total: 100, perMember: [], transfers: [{ from: "A", to: "B", amount: 100,
      payee_account: "SYNTHETIC_ACCOUNT_CANARY", toss_link: "https://example.invalid/payout-canary" }] });
  assert.equal(JSON.stringify(result).includes("CANARY"), false);
  assert.equal(JSON.stringify(result).includes("payout-canary"), false);
  assert.equal(result.csv.includes("account"), false);
});
```

실행: `npx tsx --test test/security/payout-boundary.test.ts`. 기대: 신규 모듈 부재와 현재 CSV 계좌 출력으로 실패.

- [ ] 입력 guard를 구현한다. 계좌 관련 키는 존재만으로 거부한다.

```ts
const forbidden = new Set(["bank_name", "account_no", "bankName", "accountNo", "payee_account",
  "toss", "toss_link", "tossLink", "kakaopay_link"]);
export function assertNoPayoutFields(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) assertNoPayoutFields(item); return; }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error("payout_fields_disabled");
    assertNoPayoutFields(item);
  }
}
```

guard는 JSON 파싱 후, SDK schema가 알 수 없는 필드를 지우기 전에 API/MCP tools/call arguments에 실행한다. 내부 createTrip/addMember 함수에도 적용한다. 과대 본문은 해석 전에 제한하고 제한 초과는 최소 413 응답을 반환한다. schema·UI에서 은행·계좌 입력을 제거하고 기존 클라이언트가 보내면 성공으로 무시하지 않는다.

- [ ] SQL의 계좌 조회 필드를 제거하고 신규 저장은 NULL로 고정한다. API/도구 JSON은 명시적 허용 필드만 반환한다. 샘플 계좌 값은 삭제한다. Toss 함수는 호출 경로를 제거하고 기존 `tossSendLink`는 NULL 반환으로 막는다. 송금 실행 CTA와 기존 일반 송금 링크도 화면·출력에서 제거한다.

```ts
export function tossSendLink(_amount: number, _acc?: PayeeAccount): null { return null; }
// buildSettlementExport의 CSV 열은 아래 8개만 사용한다.
const columns = ["section", "name", "paid", "owed", "net", "from", "to", "amount"];
// card.transfers는 route, amount만 반환한다. account, toss, toss_link 키를 추가하지 않는다.
```

내보내기 입력 타입의 레거시 옵션은 기존 payload 누출 카나리 검사에만 사용하고 반환 타입에서는 계좌 필드를 제거한다. 링크 helper의 비계좌 텍스트 기능은 보존한다. 기존 tests에서 계좌 출력 기대만 새 금지 계약으로 갱신하고 금액·분담 계산 기대값을 바꾸지 않는다.

- [ ] MCP createTrip/addMember, web, 합성 store 직접 호출에 금지 필드가 포함되면 변경 0회인 테스트를 추가한다. 기존 raw account 데이터가 있더라도 JSON/CSV/카카오 텍스트/카드에 나오지 않는지 카나리로 검사한다.
- [ ] 실행: `npm run typecheck`, `npm test`, `npm run smoke:mcp`, `npm run test:security`, `npm run test:mockups`. 기대: 금액 회귀와 도구 11개 유지, 계좌 카나리 출력 0.
- [ ] 검증 후 커밋한다.

```bash
git add lib/payoutBoundary.ts lib/server.ts lib/mcpEngine.ts api/web.ts lib/prototypeStore.ts lib/links.ts lib/settlementExport.ts public/app.html test/logic.test.ts test/security/payout-boundary.test.ts
git commit -m "fix: 계좌 입력과 송금 정보 출력 중지"
```

## Task 6: 첫 경계 CI와 독립 검토 인계

파일: `.github/workflows/00a-boundary.yml`, 검증 기록, `README.md`. 생성된 workflow는 전체 00A 완료 검사가 아니라 00A-1 경계 검사다.

소비: Task 1~5의 scripts/tests. 생산: Node 22 재현 기록, 독립 검토의 실제 결과, 00A-2에 넘길 미완료 항목.

- [ ] 최종 검증을 실행하고 실패 항목을 그대로 기록한다.

```bash
npm ci
npm run typecheck
npm test
npm run smoke:mcp
npm run test:security
npm run test:mockups
npm run build:public
npm audit --omit=dev --audit-level=high
git diff --check
```

기대: 전체 성공. Node 22, lockfile 해시, commit, 신규 테스트 수와 기존 회귀 수, audit의 측정 시각을 기록한다. 승인 예외가 있다면 audit 성공으로 바꿔 표현하지 않는다.

- [ ] 아래 CI 구조를 구현한다. checkout/setup-node는 2026-10-07 공식 저장소의 tag 참조로 확인한 commit SHA를 사용한다. write token이나 Production 비밀값을 전달하지 않는다. [checkout 공식 저장소](https://github.com/actions/checkout), [setup-node 공식 저장소](https://github.com/actions/setup-node).

```yaml
name: 00A boundary
on: [pull_request, workflow_dispatch]
permissions:
  contents: read
jobs:
  boundary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run smoke:mcp
      - run: npm run test:security
      - run: npm run test:mockups
      - run: npm run build:public
      - run: npm audit --omit=dev --audit-level=high
      - run: git diff --check
```

이 workflow만으로 TF-10 전체 통과를 선언하지 않는다. lint/format, 실제 DB 마이그레이션·역할 부정 검사, secret scan, 실제 배포 브라우저 카나리는 00A-3의 필수 추가 검사다. branch protection 변경은 별도 권한 확인이 필요한 저장소 설정이다.

- [ ] README에서 운영 MCP 공개·키 생략 허용·광역 DATABASE_URL·베타 메모리 성공·계좌 입력을 현재 유효한 배포 안내로 설명하지 않게 수정한다. 합성 로컬 실행에 필요한 환경과 header key, 접수 중단 상태를 명시한다. `.env` 예시는 가짜 값만 사용한다.
- [ ] Claude에 명세, 기준 commit, 비식별 diff, 검증 결과를 읽기 전용으로 전달한다. 운영 키나 고객 데이터 없이 경로 우회, 가드 순서, query 키, 계좌 출력, DB fallback을 검토하도록 요청한다. 검토 승인 권한은 코드 수정·운영 변경 권한과 분리한다.
- [ ] 지적사항 수정 후 해당 실패 테스트와 전체 검증을 다시 실행한다. 검토가 실행되지 않으면 대기 상태로 기록한다.
- [ ] 검증 후 커밋한다.

```bash
git add .github/workflows/00a-boundary.yml README.md docs/superpowers/reviews/2026-10-07-tripmoney-00a-containment-verification.md
git commit -m "ci: 운영 경로 차단 회귀 검증 추가"
```

PR 생성 요청이 있으면 제목·본문을 한국어로 작성하고 생성된 PR을 현재 채팅에 연결한다. 요청 없는 push·배포·auto-merge는 실행하지 않는다.

## 자기 검토와 다음 게이트

| 명세 기준 | 이 계획의 검사 | 범위 한계 |
|---|---|---|
| TF-01 | Task 3 HTTP, Task 4 정적 제외 | 실제 배포 산출물·브라우저 검사는 운영 권한 확인 후 |
| TF-02 | Task 2 환경/플래그, Task 3 DB 차단 | 실제 역할별 환경 식별은 00A-2 |
| TF-03 | 레거시 DB 사용 불가 | DB 권한·분류·자식 제약은 00A-2, 미충족으로 유지 |
| TF-09 | Task 3 공개 오류·health·로그 카나리 | 제공자 로그 설정과 보안기록 90일 정리는 후속 00A/00B 검사 |
| TF-10 | Task 1 의존성, Task 6 첫 CI | 전체 마이그레이션·secret scan·lint/format 포함 검사는 00A-3 |
| TF-13 | Task 6 실제 Claude 검토 | 검토 미실행을 완료로 기록하지 않음 |

완료 판단: 이 계획의 모든 작업을 통과해도 00A-1만 완료다. 실제 접수는 계속 닫는다. 00A-2 계획에는 0008 전체 SQL, 인증용 DB 계약, 역할별 DSN와 TLS/환경 확인, 직접 부정 테스트를 별도 명시하고 검토한 뒤 착수한다.
