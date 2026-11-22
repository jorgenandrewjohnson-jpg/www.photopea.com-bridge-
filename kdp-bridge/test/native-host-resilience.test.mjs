import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('native PDF host returns a bounded error for malformed JSON and continues serving',async()=>{
  const proc=spawn('python3',['native-host/kdp_native_host.py'],{stdio:['pipe','pipe','pipe']});
  try {
    const write=object=>{
      const body=Buffer.from(object);
      const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
      proc.stdin.write(Buffer.concat([header,body]));
    };
    let data=Buffer.alloc(0);
    const responses=[];
    const feed=chunk=>{
      data=Buffer.concat([data,chunk]);
      while(data.length>=4){
        const size=data.readUInt32LE(0);
        if(data.length<4+size)break;
        responses.push(JSON.parse(data.subarray(4,4+size).toString()));
        data=data.subarray(4+size);
      }
    };
    proc.stdout.on('data',feed);
    write('not JSON');
    write(JSON.stringify({id:'safe',action:'health'}));
    const deadline=Date.now()+5000;
    while(responses.length<2 && Date.now()<deadline)
      await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(responses.length,2,'host must reply twice, without crashing');
    assert.equal(responses[0].ok,false);
    assert.equal(responses[1].id,'safe');
    assert.equal(responses[1].ok,true);
  } finally {
    proc.stdin.end();
    proc.kill();
  }
});
