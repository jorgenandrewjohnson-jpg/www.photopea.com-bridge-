import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';

const code=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const args={tab_id:7,document_id:'doc',expected_path:'https://kdp.amazon.com/en_US/title-setup/kindle/BOOK/pricing',
  control_id:randomUUID(),title:'Book',edition:'kindle',edition_id:'BOOK',price:'9.99',rights:'worldwide',warnings:[],chat_approved:true};
function fixture() {
  let active=7, now=1000, clickCount=0, reviewCount=0, popupCount=0, fail=false;
  let next=0; const timers=new Map();
  const noop=()=>{};
  const event={addListener:noop};
  const chrome={runtime:{getURL:p=>'chrome-extension://test/'+p,onStartup:event,onInstalled:event,onMessage:event},
    storage:{local:{setAccessLevel:async()=>{},get:async()=>({})}},
    alarms:{onAlarm:event,get:async()=>true,create:async()=>{}},
    tabs:{get:async()=>({id:7,windowId:1}),update:async()=>{},query:async()=>[{id:active}]},
    windows:{update:async()=>{}},
    action:{setBadgeText:async()=>{},openPopup:async()=>{popupCount++;}}};
  const box=vm.createContext({chrome,crypto:{randomUUID},Date:{now:()=>now},transferState:async()=>null,
    setTimeout:(f)=>{const id=++next;timers.set(id,f);return id;},
    clearTimeout:id=>timers.delete(id),clearInterval:noop,
    mockPage:async(a,op)=>{if(op==='review_publish'){reviewCount++;return {result:{button:'Publish Your Kindle eBook'}};}
      assert.equal(op,'publish');if(fail)throw Error('Pricing page changed');clickCount++;return {result:{dispatched:true}};}});
  vm.runInContext(code+'\npaired=true; context=async()=>({t:{id:7,windowId:1}}); inPage=mockPage; globalThis.api={run,publish,confirmPublication,stop};',box);
  const api=box.api;
  return {api, counts:()=>({clickCount,reviewCount,popupCount}),setActive:v=>{active=v;},
    fail:()=>{fail=true;},expire:()=>{now+=300001;for(const f of [...timers.values()])f();}};
}
test('publication returns pending immediately; only exact local confirmation dispatches once',async()=>{
  const f=fixture(),p=await f.api.run('publish',args);
  assert.equal(p.status,'awaiting_owner_confirmation');
  assert.equal(p.popup_opened,true);
  assert.deepEqual(f.counts(),{clickCount:0,reviewCount:1,popupCount:1});
  assert.equal((await f.api.run('publication_status',args)).request_id,p.request_id);
  assert.equal((await f.api.run('publication_status',{...args,edition_id:'OTHER'})).status,'no_request_observed');
  await assert.rejects(f.api.run('inspect',args),/pending/);
  await assert.rejects(f.api.confirmPublication({request_id:'wrong',approve:true}),/exact pricing tab/);
  f.setActive(8);await assert.rejects(f.api.confirmPublication({request_id:p.request_id,approve:true}),/exact pricing tab/);
  f.setActive(7);
  assert.equal((await f.api.confirmPublication({request_id:p.request_id,approve:true})).status,'submitted_unverified');
  assert.equal(f.counts().clickCount,1);
  await assert.rejects(f.api.confirmPublication({request_id:p.request_id,approve:true}),/exact pricing tab/);
  await assert.rejects(f.api.publish(args),/outcome is uncertain/);
});
test('decline, expiry, disconnect and changed page never cause publication',async()=>{
  for(const action of ['decline','expire','disconnect','changed']) {
    const f=fixture(),p=await f.api.publish(args);
    let expected;
    if(action==='decline'){await f.api.confirmPublication({request_id:p.request_id,approve:false});expected='declined';}
    if(action==='expire'){f.expire();expected='expired';}
    if(action==='disconnect'){f.api.stop();expected='disconnected';}
    if(action==='changed'){f.fail();await assert.rejects(f.api.confirmPublication({request_id:p.request_id,approve:true}),/Pricing page changed/);expected='outcome_unknown';}
    assert.equal((await f.api.run('publication_status',args)).status,expected);
    assert.equal(f.counts().clickCount,0);
    await assert.rejects(f.api.confirmPublication({request_id:p.request_id,approve:true}),/exact pricing tab/);
  }
});
