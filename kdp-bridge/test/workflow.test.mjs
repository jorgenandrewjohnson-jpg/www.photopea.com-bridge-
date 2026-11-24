import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcp} from '../tools.mjs';
import {route} from '../extension/policy.js';
import {workflowOverview, preflight} from '../workflow.mjs';

const editionId = 'Ab-12_3';
const secret = 'PRIVATE_SENTINEL';
function tab(tab_id,stage,active=false,id=editionId,format='hardcover') {
  return {tab_id,active,...route(`https://kdp.amazon.com/en_US/print-setup/${format}/${id}/${stage}`)};
}
function snapshot(t,data={}) {
  const {tab_id,active,...page} = t;
  return {tab_id,expected_path:t.path,document_id:'private-document',
    result:{page,alerts:[],controls:[],...data}};
}
function paired(tabs, read=t=>snapshot(t)) {
  const calls = [];
  return {calls,status:()=>({paired:true}),async call(op,args) {
    calls.push({op,args});
    if (op === 'tabs') return tabs;
    assert.equal(op,'inspect');
    const t = tabs.find(t=>t.tab_id === args.tab_id);
    assert.deepEqual(args,{tab_id:t.tab_id,expected_path:t.path});
    return read(t);
  }};
}
const clean = {saving:false,unsaved_changes:false,upload_error:false,cover_status:'present',
  preview_approval_required:false,preview_enabled:true};
const price = value=>({kind:'fill',label:'List price',context:'Amazon.com USD',value});
const worldwide = {kind:'click',checked:true,label:'All territories (worldwide rights)'};

test('one edition is auto-selected and only allowlisted observations leave the scanner',async()=>{
  const tabs = [tab(1,'details'),tab(2,'content'),tab(3,'rights-and-pricing',true)];
  const browser = paired(tabs,t=>{
    const data = {
      details:{controls:[{kind:'fill',label:'Book Title',value:'The Open Sea'},{kind:'fill',label:'Author',value:secret}]},
      content:{content_state:clean,text:'ISBN: 978-0-306-40615-7\n'+secret,alerts:['Print Previewer approved.']},
      'rights-and-pricing':{controls:[price('19.95'),worldwide,{...price('8.95'),context:'Amazon.com.au AUD'}],
        alerts:['Review pricing '+secret]}
    };
    return snapshot(t,{title:secret,...data[t.stage]});
  });
  const report = await workflowOverview(browser);
  assert.equal(report.status,'observed');
  assert.equal(report.edition_id,editionId);
  assert.equal(report.edition,'hardcover');
  assert.equal(report.title,'The Open Sea');
  assert.equal(report.isbn,'9780306406157');
  assert.equal(report.amazon_com_list_price_usd,'19.95');
  assert.equal(report.rights,'worldwide');
  assert.equal(report.current_stage,'rights-and-pricing');
  assert.equal(report.print_preview_approval,'confirmed');
  assert.deepEqual(report.pricing.alert_categories,['pricing']);
  assert.equal(report.pricing.status,'review_alerts');
  assert.equal(report.content.cover_status,'present');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_SENTINEL|https:|private-document|Review pricing/);
  const result = preflight(report);
  assert.equal(result.status,'unknown');
  assert.equal(result.checks.previewer_approval,'confirmed');
  assert.equal(result.checks.latest_manuscript_amazon_upload,'unknown');
  assert.equal(result.checks.latest_cover_amazon_upload,'unknown');
  assert.ok(result.missing_or_unknown.includes('territorial_rights'));
});

test('multiple IDs and overlapping formats are ambiguous before inspection; exact IDs are case-sensitive',async()=>{
  const a = tab(1,'content'), b = tab(2,'details',true,'Other');
  const browser = paired([b,a,tab(3,'content',false,'new')]);
  const ambiguous = await workflowOverview(browser);
  assert.equal(ambiguous.status,'ambiguous');
  assert.deepEqual(ambiguous.available_ids,[editionId,'Other']);
  assert.equal((await workflowOverview(browser,'other')).status,'not_found');
  assert.equal(browser.calls.filter(c=>c.op==='inspect').length,0);
  const report = await workflowOverview(browser,editionId);
  assert.deepEqual(report.tabs.map(t=>t.tab_id),[1]);
  assert.equal(browser.calls.at(-1).args.tab_id,1);
  const shared = paired([a,tab(4,'pricing',false,editionId,'paperback')]);
  assert.equal((await workflowOverview(shared,editionId)).status,'ambiguous');
  assert.equal(shared.calls.length,1);
  const unsaved = paired([tab(3,'details',true,'new'),{tab_id:5,...route('https://kdp.amazon.com/print-preview')}]);
  assert.equal((await workflowOverview(unsaved)).status,'not_found');
  assert.equal(unsaved.calls.length,1);
});

test('duplicate stages use one active copy or remain unknown within a bounded read budget',async()=>{
  const tabs = [tab(1,'pricing'),tab(2,'rights-and-pricing'),tab(3,'details'),
    ...Array.from({length:20},(_,i)=>tab(i+4,'content',i===19))];
  const browser = paired(tabs);
  const report = await workflowOverview(browser,editionId);
  assert.equal(report.status,'partial');
  assert.equal(report.current_stage,'content');
  assert.equal(report.pricing.status,'unknown');
  assert.deepEqual(browser.calls.filter(c=>c.op==='inspect').map(c=>c.args.tab_id),[23,3]);
  assert.equal(report.tabs.length,12);
  assert.equal(report.omitted_tab_count,11);
  assert.deepEqual(report.found_stages,['pricing','rights-and-pricing','details','content']);
});

test('stale, missing and mismatched snapshots never contribute evidence',async()=>{
  const t = tab(1,'content',true);
  const foreign = snapshot(t,{content_state:clean,alerts:['Print Previewer approved.'],text:secret});
  const wrongPage = changes=>({...foreign,result:{...foreign.result,page:{...foreign.result.page,...changes}}});
  for (const reply of [null,{}, {...foreign,tab_id:2},{...foreign,document_id:null},
    {...foreign,expected_path:secret},wrongPage({path:secret}),wrongPage({edition:'paperback'}),
    wrongPage({edition_id:'other'}),wrongPage({stage:'details'})]) {
    const report = await workflowOverview(paired([t],()=>reply),editionId);
    assert.equal(report.tabs[0].inspection,'unavailable');
    assert.equal(report.current_stage,'unknown');
    assert.equal(report.print_preview_approval,'unknown');
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_SENTINEL/);
  }
  const old = paired([t],()=>snapshot(t,{alerts:undefined,controls:undefined}));
  assert.equal((await workflowOverview(old)).content.status,'unknown');
  const failed = paired([t,tab(2,'pricing')],t=>{
    if (t.tab_id === 1) throw Error(secret);
    return snapshot(t,{controls:[price('7.50')]});
  });
  const report = await workflowOverview(failed);
  assert.equal(report.amazon_com_list_price_usd,'7.50');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_SENTINEL/);
});

test('offline, inventory failures and unsafe inventory return fixed diagnostics',async()=>{
  const offline = await workflowOverview({status:()=>({paired:false}),call:assert.fail},editionId);
  assert.equal(offline.status,'offline');
  const broken = await workflowOverview({status:()=>({paired:true}),call(){throw Error(secret);}},editionId);
  assert.equal(broken.status,'inventory_unavailable');
  const t = tab(1,'details');
  for (const tabs of [null,[t,t],[{...t,path:t.path+'?token='+secret}],[{...t,path:'https://example.org'}],
    [{...t,edition_id:'other'}],[{...t,stage:'content'}]]) {
    const browser = paired(tabs);
    assert.equal((await workflowOverview(browser)).status,'inventory_unavailable');
    assert.equal(browser.calls.length,1);
  }
  for (const report of [broken,offline]) {
    const result = preflight(report);
    assert.equal(result.status,'unknown');
    assert.equal(result.missing_or_unknown.length,6);
    assert.doesNotMatch(JSON.stringify([report,result]),/PRIVATE_SENTINEL/);
  }
});

test('staging, old filenames, a checked control and a Previewer launch are not release facts',async()=>{
  const t = tab(1,'content',true);
  for (const flags of [clean,{...clean,preview_enabled:false},{}]) {
    const report = await workflowOverview(paired([t],()=>snapshot(t,{content_state:flags,
      alerts:['Print Previewer not approved.'],text:'Print Previewer approved.\nCover "OLD.pdf" uploaded successfully\nISBN: 9780306406152',
      controls:[{kind:'click',label:'Launch Print Previewer',checked:true}]})));
    assert.equal(report.print_preview_approval,'unknown');
    assert.equal(report.isbn,null);
    assert.equal(preflight(report).status,'unknown');
    assert.equal(preflight(report).missing_or_unknown.length,6);
  }
  const blocked = await workflowOverview(paired([t],()=>snapshot(t,{alerts:['Print Previewer approved.'],
    content_state:{...clean,preview_approval_required:true,cover_status:'missing',upload_error:true}})));
  assert.equal(blocked.print_preview_approval,'unknown');
  assert.equal(preflight(blocked).status,'blocked');
  assert.equal(preflight(blocked).checks.latest_cover_amazon_upload,'missing');
  assert.equal(preflight(blocked).checks.previewer_approval,'required');
  assert.deepEqual(new Set(blocked.blockers),new Set(['upload_error','cover_missing','preview_approval_required']));
});

test('pricing can contradict an older content approval or explicitly require a price',async()=>{
  const tabs = [tab(1,'content'),tab(2,'pricing',true)];
  const data = {alerts:['Please enter a list price.','Preview your book before proceeding.'],content_state:{preview_approval_required:true}};
  const report = await workflowOverview(paired(tabs,t=>snapshot(t,t.stage === 'pricing' ? data : {
    content_state:clean,alerts:['Print Previewer approved.']
  })));
  assert.equal(report.print_preview_approval,'unknown');
  assert.ok(report.blockers.includes('list_price_required'));
  const result = preflight(report);
  assert.equal(result.status,'blocked');
  assert.deepEqual(result.alerts_to_review.pricing,['pricing','preview']);
});

test('conflicting values, unchecked territories, unrelated market prices and sensitive text stay out',async()=>{
  const details = tab(1,'details'), pricing = tab(2,'pricing');
  for (const title of ['token: private','alice@example.com','[redacted]','https://example.test','Multi\nline']) {
    const report = await workflowOverview(paired([details,pricing],t=>snapshot(t,{
      title:secret,text:secret,alerts:[secret],controls:t === details ? [
        {kind:'fill',label:'Book Title',value:title},{kind:'fill',label:'Password',value:secret}
      ] : [price('12.99'),price('13.99'),{...worldwide,checked:false}]
    })));
    assert.equal(report.title,null);
    assert.equal(report.rights,null);
    assert.equal(report.amazon_com_list_price_usd,null);
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_SENTINEL|example\.com|token: private/);
  }
  for (const context of ['Amazon.ca CAD','Amazon.com.au','Amazon.com USD Amazon.co.uk GBP']) {
    const report = await workflowOverview(paired([pricing],t=>snapshot(t,{controls:[{...price('12.99'),context}]})));
    assert.equal(report.amazon_com_list_price_usd,null);
  }
});

test('native MCP tools advertise strict read-only inputs and return structured JSON',async t=>{
  const browser = paired([tab(1,'details')]);
  const server = createMcp(browser);
  const client = new Client({name:'workflow-test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);
  t.after(()=>client.close());
  const defs = (await client.listTools()).tools;
  for (const name of ['kdp_workflow_overview','kdp_preflight_edition']) {
    const def = defs.find(d=>d.name === name);
    assert.equal(def.annotations.readOnlyHint,true);
    assert.equal(def.annotations.destructiveHint,false);
    for (const args of [{edition_id:'new'},{edition_id:'x/y'},{edition_id:'a'.repeat(65)},{edition_id:editionId,tab_id:1}]) {
      assert.equal((await client.callTool({name,arguments:args})).isError,true);
    }
    if (name === 'kdp_preflight_edition') assert.equal((await client.callTool({name,arguments:{}})).isError,true);
    assert.equal(browser.calls.length,0);
    const reply = await client.callTool({name,arguments:{edition_id:editionId}});
    assert.equal(reply.structuredContent.edition_id,editionId);
    assert.deepEqual(reply.structuredContent,JSON.parse(reply.content[0].text));
    browser.calls.length = 0;
  }
});


test('KDP current Amazon.com USD input is recognized only in the correct marketplace row',async()=>{
  const pricing = tab(42,'pricing',true);
  for (const context of ['Amazon.com\n(Primary Marketplace)\n$\nUSD\nMin. $7.52, Max. $250.00']) {
    const report=await workflowOverview(paired([pricing],()=>snapshot(pricing,{controls:[
      {kind:'fill',label:'Price for Amazon.com in USD',context,value:'7.80'},worldwide
    ]})));
    assert.equal(report.amazon_com_list_price_usd,'7.80');
    assert.equal(report.rights,'worldwide');
  }
  const mismatched=await workflowOverview(paired([pricing],()=>snapshot(pricing,{controls:[
    {kind:'fill',label:'Price for Amazon.com in USD',context:'Amazon.ca CAD',value:'7.80'}
  ]})));
  assert.equal(mismatched.amazon_com_list_price_usd,null);
});
