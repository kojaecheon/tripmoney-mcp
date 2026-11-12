import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const mailModule='../../server/integration/mail-permit.js';
const stateModule='../../scripts/live-state.js';
const recipient='owner@example.invalid';
async function moduleAt(name:string){const result=await import(name).catch(()=>undefined);assert.ok(result,'live-state feature is available');return result;}
function fixture(t:test.TestContext){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tripmoney-live-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('one mail permit survives restart and concurrent attempts cannot resend',async t=>{
 const dir=fixture(t),file=path.join(dir,'mail-permit.json');
 const {createLiveMailPermit,readLiveMailPermit}=await moduleAt(mailModule);
 createLiveMailPermit(file,recipient);assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.throws(()=>readLiveMailPermit(file,'other@example.invalid'));
 const first=readLiveMailPermit(file,recipient),second=readLiveMailPermit(file,recipient);
 await assert.rejects(async()=>first.consume('other@example.invalid'));
 const attempts=await Promise.allSettled([first.consume(recipient),second.consume(recipient)]);
 assert.equal(attempts.filter(v=>v.status==='fulfilled').length,1);
 await assert.rejects(async()=>readLiveMailPermit(file,recipient).consume(recipient));
 assert.throws(()=>createLiveMailPermit(file,recipient));
 assert.ok(!fs.readFileSync(file,'utf8').includes(recipient));
});
test('mail permits reject symlinks, unsafe permissions and a changed acceptance scope',async t=>{
 const dir=fixture(t),file=path.join(dir,'permit.json');
 const {createLiveMailPermit,readLiveMailPermit}=await moduleAt(mailModule);
 createLiveMailPermit(file,recipient);fs.symlinkSync(file,path.join(dir,'link'));
 assert.throws(()=>readLiveMailPermit(path.join(dir,'link'),recipient));
 fs.chmodSync(file,0o644);assert.throws(()=>readLiveMailPermit(file,recipient));
 fs.chmodSync(file,0o600);const value=JSON.parse(fs.readFileSync(file,'utf8'));value.scope='other';fs.writeFileSync(file,JSON.stringify(value));
 assert.throws(()=>readLiveMailPermit(file,recipient));
});
test('keys persist across reads, are purpose separated and never overwrite an existing file',async t=>{
 const dir=fixture(t),file=path.join(dir,'keys.env');
 const {createLiveKeyFile,readLiveKeyFile}=await moduleAt(stateModule);
 createLiveKeyFile(file);const first=readLiveKeyFile(file),second=readLiveKeyFile(file);
 assert.deepEqual(first,second);assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.equal(new Set([JSON.parse(first.CUSTOMER_AUTH_KEYS).live,JSON.parse(first.CUSTOMER_INVITE_KEYS).live,first.CUSTOMER_AUTH_RATE_KEY,first.CUSTOMER_HTTP_CLIENT_KEY]).size,4);
 assert.throws(()=>createLiveKeyFile(file));assert.deepEqual(readLiveKeyFile(file),first);
});
