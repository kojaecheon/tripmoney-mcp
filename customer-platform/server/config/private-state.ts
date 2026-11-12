import fs from 'node:fs';
import {dirname} from 'node:path';
const invalid=():never=>{throw new Error('customer_private_state_configuration');};
export function assertPrivateDirectory(file:string):void {
 try {
  const stat=fs.lstatSync(dirname(file));
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o7777)!==0o700)invalid();
 } catch {invalid();}
}
export function writePrivateState(file:string,value:string):void {
 let fd:number|undefined;
 try {
  assertPrivateDirectory(file);
  fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  fs.writeFileSync(fd,value,{encoding:'utf8'});fs.fsyncSync(fd);
  // Persist directory entries before any external operation can spend this permit.
  const directory=fs.openSync(dirname(file),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
  try {fs.fsyncSync(directory);}finally {fs.closeSync(directory);}
 } catch {invalid();} finally {if(fd!==undefined)fs.closeSync(fd);}
}
export function readPrivateState(file:string):string {
 let fd:number|undefined;
 try {
  assertPrivateDirectory(file);
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o7777)!==0o600||stat.size>4096)invalid();
  const bytes=Buffer.alloc(4097);let length=0;
  while(length<bytes.length){const count=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
  if(length>4096)invalid();
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length));
 } catch {return invalid();} finally {if(fd!==undefined)fs.closeSync(fd);}
}
