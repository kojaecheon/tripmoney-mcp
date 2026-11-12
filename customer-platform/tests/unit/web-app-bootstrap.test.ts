import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// The real module loader fails absent legacy assets. Existing visual renderers
// are stubbed; app, API, controllers and the selected Kakao mount execute.
test('legacy asset set boots local demo and callback exchange still precedes app startup',()=>{
 const script=fileURLToPath(new URL('../fixtures/legacy-web-bootstrap.mjs',import.meta.url));
 const result=spawnSync(process.execPath,['--experimental-vm-modules',script],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr+result.stdout);
});
