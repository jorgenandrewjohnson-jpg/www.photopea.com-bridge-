import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm, truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const host=resolve('native-host/kdp_native_host.py');
function message(payload,home) {
  const body=Buffer.from(JSON.stringify(payload));
  const size=Buffer.alloc(4);size.writeUInt32LE(body.length);
  const result=spawnSync('python3',[host],{input:Buffer.concat([size,body]),
    env:{...process.env,HOME:home},maxBuffer:2*1024*1024});
  if(result.status!==0) throw Error(result.stderr?.toString()||'Native host crashed');
  const length=result.stdout.readUInt32LE(0);
  return JSON.parse(result.stdout.subarray(4,4+length).toString());
}
test('native PDF host reads only explicitly allowed Desktop PDFs in bounded chunks',async()=>{
  const home=await mkdtemp(join(tmpdir(),'kdp-native-'));
  try {
    await mkdir(join(home,'Desktop'));
    await mkdir(join(home,'Downloads'));
    await mkdir(join(home,'Documents'));
    const file=join(home,'Desktop','Hardcover.pdf');
    await writeFile(file,Buffer.from('%PDF-1.7 TEST'));
    const stat=message({action:'stat',path:file,id:'one'},home);
    assert.equal(stat.ok,true);
    assert.equal(stat.id,'one');
    assert.equal(stat.size,13);
    const read=message({action:'read',path:file,id:'two',offset:0,count:13,
      size:stat.size,mtime_ns:stat.mtime_ns},home);
    assert.equal(read.ok,true);
    assert.equal(Buffer.from(read.data,'base64').toString(),'%PDF-1.7 TEST');
    assert.equal(message({action:'read',path:file,offset:0,count:262145,
      size:stat.size,mtime_ns:stat.mtime_ns},home).ok,false);
    assert.equal(message({action:'read',path:file,offset:0,count:1,
      size:stat.size,mtime_ns:'0'},home).ok,false);
    const workspace=join(home,'Library/Application Support/KDP Brave Bridge/Publishing');
    await mkdir(workspace,{recursive:true});
    const workspaceFile=join(workspace,'Proof.pdf');
    await writeFile(workspaceFile,'%PDF-1.7 proof');
    assert.equal(message({action:'stat',path:workspaceFile},home).size,14);
    const oversized=join(home,'Desktop','too-large.pdf');
    await writeFile(oversized,'%PDF-1.7');
    await truncate(oversized,250*1024*1024+1);
    assert.equal(message({action:'stat',path:oversized},home).ok,false);
    const privateFile=join(home,'Documents','private.pdf');
    await writeFile(privateFile,'secret');
    assert.equal(message({action:'stat',path:privateFile},home).ok,false);
    const fake=join(home,'Desktop','link.pdf');
    await symlink(privateFile,fake);
    assert.equal(message({action:'stat',path:fake},home).ok,false);
  } finally {
    await rm(home,{recursive:true,force:true});
  }
});
