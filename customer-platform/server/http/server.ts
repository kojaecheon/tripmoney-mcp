import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac,randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { IdentityError } from '../../core/contracts.js';
import type { AuthService } from '../auth/service.js';
import type { IdentityService } from '../identity/contracts.js';
import type { LedgerService } from '../ledger/contracts.js';
import type { HttpConfig } from './config.js';
import { cookieNames, readCookie, serializeCookie } from './cookies.js';
import { publicError } from './errors.js';
import { readBody } from './body.js';
import {handleAuthLinkRoute} from './auth-link-route.js';
import { handleIdentityRoute, matchIdentityRoute } from './identity-routes.js';
import { handleLedgerRoute, matchLedgerRoute } from './ledger-routes.js';
import {handlePlanningRoute,matchPlanningRoute,type DraftService} from './planning-routes.js';
import type {PlaceService} from '../places/contracts.js';
import {handlePhase2Route,matchPhase2Route,type Phase2Services} from './phase2-routes.js';
import {handleKakaoWeb,isKakaoWebRoute,readSkillBody,skillHeaders,SkillBodyLimit,type KakaoHttpService} from './kakao-routes.js';
import {readMapsClient,mapsCsp,type MapsClientInput} from './maps-config.js';
import {clientAddress} from './client-address.js';
import {handleChangesRoute} from './changes-route.js';
import type {TripChangesService} from '../sync/service.js';
const files: Record<string, { name: string; type: string }> = {
  '/': { name: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { name: 'index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { name: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.mjs': { name: 'app.mjs', type: 'text/javascript; charset=utf-8' },
  '/api.mjs': { name: 'api.mjs', type: 'text/javascript; charset=utf-8' },
  '/planning-recovery.mjs': {name:'planning-recovery.mjs',type:'text/javascript; charset=utf-8'},
  '/phase2-api.mjs': {name:'phase2-api.mjs',type:'text/javascript; charset=utf-8'},
  '/recommendation/controller.mjs': {name:'recommendation/controller.mjs',type:'text/javascript; charset=utf-8'},
  '/recommendation/view.mjs': {name:'recommendation/view.mjs',type:'text/javascript; charset=utf-8'},
  '/recommendation/style.css': {name:'recommendation/style.css',type:'text/css; charset=utf-8'},
  '/kakao/api.mjs': {name:'kakao/api.mjs',type:'text/javascript; charset=utf-8'},
  '/kakao/validation.mjs': {name:'kakao/validation.mjs',type:'text/javascript; charset=utf-8'},
  '/kakao/controller.mjs': {name:'kakao/controller.mjs',type:'text/javascript; charset=utf-8'},
  '/kakao/view.mjs': {name:'kakao/view.mjs',type:'text/javascript; charset=utf-8'},
  '/kakao/mount.mjs': {name:'kakao/mount.mjs',type:'text/javascript; charset=utf-8'},
  '/kakao/style.css': {name:'kakao/style.css',type:'text/css; charset=utf-8'},
  '/kakao-local/controller.mjs': {name:'kakao-local/controller.mjs',type:'text/javascript; charset=utf-8'},
  '/kakao-local/view.mjs': {name:'kakao-local/view.mjs',type:'text/javascript; charset=utf-8'},
  '/kakao-local/style.css': {name:'kakao-local/style.css',type:'text/css; charset=utf-8'},
  '/auth/callback': {name:'index.html',type:'text/html; charset=utf-8'},
  '/auth/email-link.mjs': {name:'auth/email-link.mjs',type:'text/javascript; charset=utf-8'},
  '/auth/controller.mjs': { name: 'auth/controller.mjs', type: 'text/javascript; charset=utf-8' },
  '/auth/view.mjs': { name: 'auth/view.mjs', type: 'text/javascript; charset=utf-8' },
  '/invite': { name: 'index.html', type: 'text/html; charset=utf-8' },
  '/travel/controller.mjs': { name: 'travel/controller.mjs', type: 'text/javascript; charset=utf-8' },
  '/travel/view.mjs': { name: 'travel/view.mjs', type: 'text/javascript; charset=utf-8' },
  '/travel/forms.mjs': { name: 'travel/forms.mjs', type: 'text/javascript; charset=utf-8' },
  '/invites/view.mjs': { name: 'invites/view.mjs', type: 'text/javascript; charset=utf-8' },
  '/ledger/controller.mjs': { name: 'ledger/controller.mjs', type: 'text/javascript; charset=utf-8' },
  '/ledger/view.mjs': { name: 'ledger/view.mjs', type: 'text/javascript; charset=utf-8' },
  '/ledger/forms.mjs': { name: 'ledger/forms.mjs', type: 'text/javascript; charset=utf-8' },
  '/ledger/itinerary-view.mjs': { name: 'ledger/itinerary-view.mjs', type: 'text/javascript; charset=utf-8' },
  '/ledger/expenses-view.mjs': { name: 'ledger/expenses-view.mjs', type: 'text/javascript; charset=utf-8' },
  '/ledger/settlement-view.mjs': { name: 'ledger/settlement-view.mjs', type: 'text/javascript; charset=utf-8' },
  '/maps/controller.mjs': {name:'maps/controller.mjs',type:'text/javascript; charset=utf-8'},
  '/maps/validation.mjs': {name:'maps/validation.mjs',type:'text/javascript; charset=utf-8'},
  '/maps/view.mjs': {name:'maps/view.mjs',type:'text/javascript; charset=utf-8'},
  '/maps/google-map.mjs': {name:'maps/google-map.mjs',type:'text/javascript; charset=utf-8'},
  '/maps/sdk-loader.mjs': {name:'maps/sdk-loader.mjs',type:'text/javascript; charset=utf-8'},
  '/maps/style.css': {name:'maps/style.css',type:'text/css; charset=utf-8'},
  '/drafts/controller.mjs': {name:'drafts/controller.mjs',type:'text/javascript; charset=utf-8'},
  '/drafts/view.mjs': {name:'drafts/view.mjs',type:'text/javascript; charset=utf-8'},
  '/drafts/style.css': {name:'drafts/style.css',type:'text/css; charset=utf-8'},
};
const missing = () => new IdentityError('not_found', '요청한 경로를 찾을 수 없습니다.');
const denied = () => new IdentityError('unauthenticated', '다시 로그인해 주세요.');
function exactlyOne(req: IncomingMessage, name: string, value: string): boolean {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === name) count++;
  return count === 1 && req.headers[name] === value;
}
export function createCustomerAuthServer({ config, authService, identityService, ledgerService, placeService, draftService, recommendationService,kakaoLocalService,kakaoService,mapsClient,changesService,webRoot = fileURLToPath(new URL('../../web/', import.meta.url)) }: Phase2Services & {
  config: HttpConfig; authService: AuthService; identityService?: IdentityService; ledgerService?: LedgerService; placeService?:PlaceService; draftService?:DraftService; webRoot?: string;kakaoService?:KakaoHttpService;mapsClient?:MapsClientInput;changesService?:TripChangesService;
}) {
  const publicMaps=readMapsClient(mapsClient);
  const names = cookieNames(config);
  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const head = req.method === 'HEAD';
    const path = req.url ?? '';
    let clearSessionOnUnauthorized = path === '/api/customer/me';
    const nonce=publicMaps?randomBytes(18).toString('base64url'):null;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(nonce){res.setHeader('Content-Security-Policy',mapsCsp(nonce));res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');}
    const json = (status: number, value?: unknown) => {
      if(res.destroyed||res.writableEnded)return;
      res.statusCode = status;
      if (status !== 204) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(head || value === undefined ? undefined : JSON.stringify(value));
    };
    const clear = (kind: 'session' | 'challenge') => serializeCookie(config, kind, '', 0);
    try {
      if (!exactlyOne(req, 'host', config.host)) throw new IdentityError('forbidden', '허용되지 않은 요청입니다.');
      // Use the unnormalized request target: URL parsing would silently collapse traversal.
      if (path.includes('?') || path.includes('%') || path.includes('#') || !path.startsWith('/')) throw missing();
      if(kakaoService&&req.method==='POST'&&path==='/api/channels/kakao/skill') {
        if(!exactlyOne(req,'content-type','application/json')||req.headers['content-encoding'])throw new IdentityError('forbidden','허용되지 않은 요청입니다.');
        const result=await kakaoService.handleSkill({headers:skillHeaders(req),rawBody:await readSkillBody(req)});
        json(result.status,result.body);return;
      }
      const kakaoWeb=Boolean(kakaoService&&isKakaoWebRoute(req.method,path));
      const identityRoute = identityService ? matchIdentityRoute(req.method, path) : undefined;
      const ledgerRoute = ledgerService ? matchLedgerRoute(req.method, path) : undefined;
      const candidateRoute = matchPlanningRoute(req.method,path);
      const planningRoute = candidateRoute && (candidateRoute.action==='draft'?draftService:placeService) ? candidateRoute : undefined;
      const phase2Route=matchPhase2Route(req.method,path,{recommendationService,kakaoLocalService});
      const changesRoute=changesService&&identityService&&req.method==='POST'?/^\/api\/customer\/trips\/([^/]+)\/changes$/.exec(path):null;
      clearSessionOnUnauthorized ||= Boolean(identityRoute || ledgerRoute || planningRoute || phase2Route || kakaoWeb);
      const linkRoute=config.mode==='customer'&&config.authMethod==='email-link'&&path==='/api/customer/auth/verify-link';
      const route = linkRoute || path === '/api/customer/auth/request-code' || path === '/api/customer/auth/verify-code' || path === '/api/customer/auth/logout';
      if ((req.method === 'POST' && route) || (identityRoute && req.method !== 'GET') || ledgerRoute?.action === 'execute' || planningRoute || (phase2Route&&req.method!=='GET') || kakaoWeb || changesRoute) {
        if (!exactlyOne(req, 'origin', config.publicOrigin) || !exactlyOne(req, 'x-tripmoney-request', '1')
          || !exactlyOne(req, 'content-type', 'application/json')) throw new IdentityError('forbidden', '허용되지 않은 요청입니다.');
      }
      if(changesRoute&&changesService&&identityService){
        // A stale long poll must never delete a newer session cookie on a 401.
        const controller=new AbortController();
        const abort=()=>controller.abort();
        req.once('aborted',abort);res.once('close',abort);
        try{json(200,await handleChangesRoute(req,changesRoute[1]!,controller.signal,{config,authService,identityService,changesService}));}
        finally{req.off('aborted',abort);res.off('close',abort);}
        return;
      }
      if(kakaoWeb&&kakaoService) {json(200,await handleKakaoWeb(req,path,{config,authService,kakaoService}));return;}
      if (req.method === 'POST' && route) {
        if(linkRoute){const result=await handleAuthLinkRoute(req,{config,authService});res.setHeader('Set-Cookie',result.cookies);json(200,{me:result.me});return;}
        if (path.endsWith('/request-code')) {
          const body = await readBody(req, 'email');
          const clientHash = createHmac('sha256', config.clientKey).update(`auth-client:${clientAddress(req,config)}`).digest('hex');
          const result = await authService.requestCode(body.email!, clientHash);
          res.setHeader('Set-Cookie', serializeCookie(config, 'challenge', result.challengeToken, 600));
          json(200, { message: config.mode==='customer'?(config.authMethod==='email-link'?'로그인을 요청한 브라우저에서 이메일의 로그인 링크를 열어 주세요.':'이메일로 받은 인증번호를 입력해 주세요.'):'로컬 인증번호를 입력해 주세요.' }); return;
        }
        if (path.endsWith('/verify-code')) {
          const body = await readBody(req, 'code');
          const challenge = readCookie(req.headers.cookie, names.challenge); if (!challenge) throw denied();
          const result = await authService.verifyCode(challenge, body.code!);
          const me = { userId: result.me.userId, email: result.me.email, expiresAt: result.me.expiresAt };
          res.setHeader('Set-Cookie', [serializeCookie(config, 'session', result.sessionToken, (Date.parse(me.expiresAt) - Date.now()) / 1000), clear('challenge')]);
          json(200, { me }); return;
        }
        await readBody(req);
        const session = readCookie(req.headers.cookie, names.session); if (session) await authService.logout(session);
        res.setHeader('Set-Cookie', [clear('session'), clear('challenge')]); json(204); return;
      }
      if (identityService && identityRoute) {
        json(200, await handleIdentityRoute(req, identityRoute, { config, authService, identityService })); return;
      }
      if (ledgerService && ledgerRoute) {
        json(200, await handleLedgerRoute(req, ledgerRoute, { config, authService, ledgerService })); return;
      }
      if(planningRoute) {
        json(200,await handlePlanningRoute(req,planningRoute,{config,authService,placeService,draftService}));return;
      }
      if(phase2Route) {
        json(200,await handlePhase2Route(req,phase2Route,{config,authService,recommendationService,kakaoLocalService}));return;
      }
      if (req.method === 'GET' && path === '/api/customer/public-config') {
        const modeConfig=config.mode==='customer'?{mode:'customer',mailDelivery:config.mailDelivery,...(config.authMethod?{authMethod:config.authMethod}:{})}:{mode:'local-demo',mailDelivery:false,code:'123456'};
        json(200,{...modeConfig,...(publicMaps?{maps:publicMaps}:{}),...(config.mode==='customer'&&kakaoService?{channels:{kakao:{mode:'development',channelUrl:'https://pf.kakao.com/_xjvDxeX',botName:'TripMoney 개발봇'}}}:{}),...(changesService&&identityService?{changes:{mode:'long-poll'}}:{})});return;
      }
      if (req.method === 'GET' && path === '/api/customer/me') {
        const session = readCookie(req.headers.cookie, names.session); if (!session) throw denied();
        const result = await authService.authenticate(session);
        json(200, { me: { userId: result.actor.userId, email: result.email, expiresAt: result.expiresAt } }); return;
      }
      if ((req.method === 'GET' || head) && Object.hasOwn(files, path)) {
        const file = files[path]!;
        try {
          let current = webRoot;
          const root = await lstat(current); if (root.isSymbolicLink() || !root.isDirectory()) throw missing();
          for (const part of file.name.split('/')) { current = join(current, part); const stat = await lstat(current); if (stat.isSymbolicLink()) throw missing(); }
          const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await handle.stat(); if (!stat.isFile()) throw missing();
            res.setHeader('Content-Type', file.type);
            if (head) { res.end(); return; }
            const data = await handle.readFile();
            if(nonce&&file.name==='index.html'){
              const html=data.toString('utf8').replace(/<script\b/g,`<script nonce="${nonce}"`).replace('</head>',`<style nonce="${nonce}"></style></head>`);
              res.end(html);return;
            }
            res.end(data); return;
          } finally { await handle.close(); }
        } catch { throw missing(); }
      }
      throw missing();
    } catch (error) {
      req.resume();
      if(res.destroyed||res.writableEnded)return;
      if(error instanceof SkillBodyLimit){json(413,{error:{code:'validation',message:'요청 본문이 너무 큽니다.'}});return;}
      const value = publicError(error);
      if (value.status === 401 && clearSessionOnUnauthorized) res.setHeader('Set-Cookie', clear('session'));
      json(value.status, value.body);
    }
  }
  return server;
}
