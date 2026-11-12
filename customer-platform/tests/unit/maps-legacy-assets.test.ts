import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

test('customer app dependencies keep working with the already running static asset allowlist',async()=>{
 const root=new URL('../../web/',import.meta.url),pending=['app.mjs'],seen=new Set<string>();
 // These two optional entry points did not exist in the running server allowlist.
 const newEntries=new Set(['maps/google-map.mjs','maps/sdk-loader.mjs']);
 while(pending.length){
  const path=pending.pop()!;if(seen.has(path))continue;seen.add(path);
  assert.ok(!newEntries.has(path),`기존 서버가 제공하지 않는 필수 의존성: ${path}`);
  const file=new URL(path,root),source=await readFile(fileURLToPath(file),'utf8');
  for(const row of source.matchAll(/(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?['"](\.[^'"]+)['"]/g)){
    const target=new URL(row[1]!,file);assert.equal(target.protocol,'file:');
    const next=fileURLToPath(target).slice(fileURLToPath(root).length);assert.ok(!next.startsWith('..'));pending.push(next);
  }
 }
 assert.ok(seen.has('maps/view.mjs'));assert.ok(seen.has('maps/validation.mjs'));
});
