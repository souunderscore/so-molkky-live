const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { JSDOM, ResourceLoader, VirtualConsole } = require('jsdom');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'pages/client.js'), 'utf8');
const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const sample = { requestId:'test_request_000001', title:'検証用タイトル', description:'説明', date:'2099-01-01', time:'09:00', privacy:'private' };
const thumb = { mime:'image/jpeg', base64:'AQID' };
class Storage {
  map = new Map(); fail = false;
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.get(k) ?? null; }
  setItem(k,v) { if (this.fail) throw Error('quota'); this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
function mutex() {
  const tails = new Map();
  return { request(name, options, work) {
    const next = (tails.get(name) || Promise.resolve()).catch(() => {}).then(work);
    tails.set(name, next); return next;
  } };
}
function reply(data, status = 200) { return { ok: status < 300, status, text:async () => typeof data === 'string' ? data : JSON.stringify(data) }; }
function broadcast(id = 'abcdefghijk', lifeCycle = 'ready', channelId = 'channel-A') {
  return { id, snippet:{ title:sample.title, description:'元の説明', channelId, scheduledStartTime:'2099-01-01T00:00:00.000Z',
    scheduledEndTime:'2099-01-01T01:00:00Z', publishedAt:'2026-01-01T00:00:00Z', liveChatId:'preserve-readonly-test' },
    status:{ privacyStatus:'private', lifeCycleStatus:lifeCycle, selfDeclaredMadeForKids:true } };
}
function fixture({ storage = new Storage(), locks = mutex() } = {}) {
  let clock = Date.parse('2026-10-17T00:00:00Z'), channelId = 'channel-A', tokenOptions = {}, popups = 0;
  let handler = () => { throw Error('Unexpected request'); };
  const calls = [];
  const context = vm.createContext({ setTimeout, clearTimeout, AbortController, atob, crypto:webcrypto, URL, Uint8Array,
    navigator:{ locks }, localStorage:storage,
    google:{ accounts:{ oauth2:{ initTokenClient(options) {
      tokenOptions = options;
      return { requestAccessToken(request) {
        popups++; assert.equal(request.prompt, 'select_account');
        queueMicrotask(() => options.callback({ access_token:'memory-only-token', expires_in:3600, scope:SCOPE }));
      } };
    } } } },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      assert.equal(options.headers.Authorization, 'Bearer memory-only-token');
      if (url.includes('/channels?')) return reply({ items:[{ id:channelId, snippet:{ title:'接続先' } }] });
      return handler(url, options);
    }
  });
  vm.runInContext(source, context);
  const client = context.LiveSchedulerPages.createClient({ now:() => clock });
  return { client, calls, storage, context, handler(fn) { handler = fn; }, channel(id) { channelId = id; },
    expire() { clock += 3600000; }, get popups() { return popups; }, get tokenOptions() { return tokenOptions; } };
}
async function authenticate(f) {
  const pending = f.client.connect(CLIENT_ID);
  assert.equal(f.popups > 0, true, 'OAuth popup requested synchronously');
  await pending;
  assert.equal(f.client.state().connected, true);
  assert.equal(f.tokenOptions.scope, SCOPE);
}
async function apiTests() {
  const f = fixture();
  await assert.rejects(f.client.call('listMyBroadcasts'), /Googleに接続/);
  await authenticate(f);
  let creates = 0, uploads = 0;
  f.handler((url, o) => {
    if (url.includes('/thumbnails/set?')) { uploads++; assert.equal(o.body.length, 3); return reply({ error:{ message:'image rejected' } }, 400); }
    assert.equal(o.method, 'POST'); creates++;
    const body = JSON.parse(o.body);
    assert.equal(body.snippet.scheduledStartTime, '2099-01-01T00:00:00.000Z');
    assert.equal(body.status.privacyStatus, 'private');
    assert.equal(body.contentDetails.enableAutoStart, false);
    return reply(broadcast());
  });
  const created = await f.client.call('createBatchRow', { ...sample, thumbnail:thumb });
  assert.equal(created.thumbnailState, 'error'); assert.equal(creates, 1);
  f.handler((url, o) => { assert.match(url, /thumbnails\/set/); uploads++; return reply({ items:[] }); });
  const retry = await f.client.call('createBatchRow', { ...sample, thumbnail:thumb });
  assert.equal(retry.id, created.id); assert.equal(retry.thumbnailState, 'ok'); assert.equal(creates,1); assert.equal(uploads,2);
  await f.client.call('retryThumbnail', { requestId:sample.requestId, thumbnail:thumb }); assert.equal(uploads,2);
  await assert.rejects(f.client.call('createBatchRow', { ...sample, title:'変更' }), /既に登録/);
  await assert.rejects(f.client.call('createBatchRow', { ...sample, date:'2099-02-31' }), /存在しない/);
  await assert.rejects(f.client.call('createBatchRow', { ...sample, time:'25:00' }), /不正/);
  await assert.rejects(f.client.call('createBatchRow', { ...sample, thumbnail:{ ...thumb, base64:'?' } }), /2MB/);
  assert.ok(![...f.storage.map.values()].join('').includes('memory-only-token'));
  f.expire();
  const before = f.calls.length;
  await assert.rejects(f.client.call('listMyBroadcasts'), /再接続/);
  assert.equal(f.calls.length,before);
  await authenticate(f);
  f.handler(() => reply({ error:{ message:'Unauthorized' } },401));
  await assert.rejects(f.client.call('listMyBroadcasts'), /再接続/);
  assert.equal(f.client.state().connected,false);

  // Cross-tab and cross-reload duplicate prevention, scoped to the selected channel.
  const store = new Storage(), locks = mutex(), a = fixture({storage:store,locks}), b = fixture({storage:store,locks});
  await authenticate(a); await authenticate(b); let posts = 0;
  for (const x of [a,b]) x.handler(() => { posts++; return reply(broadcast()); });
  await Promise.all([a.client.call('createBatchRow',sample), b.client.call('createBatchRow',sample)]);
  assert.equal(posts,1);
  b.client.disconnect(); b.channel('channel-B'); await authenticate(b);
  await b.client.call('createBatchRow',sample); assert.equal(posts,2);

  // Ambiguous POST must remain blocked even after reopening; unrelated creates stop too.
  const u = fixture(); await authenticate(u);
  u.handler(() => { throw Error('Network lost after server commit'); });
  await assert.rejects(u.client.call('createBatchRow',sample), /通信/);
  const persisted = u.storage;
  const reopened = fixture({storage:persisted}); await authenticate(reopened);
  reopened.handler(() => { throw Error('Must not POST'); });
  await assert.rejects(reopened.client.call('createBatchRow',sample), /前回の登録結果/);
  await assert.rejects(reopened.client.call('createBatchRow',{...sample,requestId:'another_request_000002'}), /登録結果が不明/);
  assert.equal((await reopened.client.call('getUncertainRecords')).length,1);
  assert.throws(() => reopened.client.assertExportable({draft:{rows:[{id:sample.requestId,state:'pending'}]}}), /作成記録/);
  reopened.handler(() => reply({ items:[broadcast()] }));
  await assert.rejects(reopened.client.call('resolveUncertain',{requestId:sample.requestId,id:'bad'}), /動画ID/);
  await reopened.client.call('resolveUncertain',{requestId:sample.requestId,id:'abcdefghijk'});
  assert.equal((await reopened.client.call('createBatchRow',sample)).id,'abcdefghijk');
  assert.equal((await reopened.client.call('getUncertainRecords')).length,0);
  reopened.client.assertExportable({draft:{rows:[{id:sample.requestId,state:'ok'}]}});
  const forbidden = fixture(); await authenticate(forbidden);
  forbidden.handler(() => reply({error:{message:'denied'}},403));
  await assert.rejects(forbidden.client.call('createBatchRow',sample),/denied/);
  assert.equal((await forbidden.client.call('getUncertainRecords')).length,0);
  forbidden.handler(() => reply('{broken JSON',200));
  await assert.rejects(forbidden.client.call('createBatchRow',sample),/応答を読み取れません/);
  assert.equal((await forbidden.client.call('getUncertainRecords')).length,1);
  await assert.rejects(forbidden.client.call('clearUncertain',{requestId:sample.requestId}),/未登録を確認/);
  await forbidden.client.call('clearUncertain',{requestId:sample.requestId,confirmedAbsent:true});
  forbidden.storage.fail = true; const preFail = forbidden.calls.length;
  await assert.rejects(forbidden.client.call('createBatchRow',sample),/端末に保存/);
  assert.equal(forbidden.calls.length,preFail,'storage failure must prevent POST');

  // A successful POST followed by a storage failure must remain ambiguous, never re-POST.
  const afterPost = fixture(); await authenticate(afterPost);
  afterPost.handler(() => { afterPost.storage.fail = true; return reply(broadcast()); });
  await assert.rejects(afterPost.client.call('createBatchRow',sample),/端末に保存/);
  afterPost.storage.fail = false;
  assert.equal((await afterPost.client.call('getUncertainRecords')).length,1);
  await assert.rejects(afterPost.client.call('createBatchRow',sample),/前回の登録結果/);
  assert.equal(afterPost.calls.filter(c => c.method === 'POST').length,1);
  const oauth = fixture();
  oauth.context.google.accounts.oauth2.initTokenClient = options => ({requestAccessToken:() => options.callback({error:'access_denied'})});
  await assert.rejects(oauth.client.connect(CLIENT_ID),/許可されません/);
  oauth.context.google.accounts.oauth2.initTokenClient = options => ({requestAccessToken:() => options.error_callback({type:'popup_closed'})});
  await assert.rejects(oauth.client.connect(CLIENT_ID),/開けませんでした/);
  oauth.context.google.accounts.oauth2.initTokenClient = options => ({requestAccessToken:() => options.callback({access_token:'no-scope',expires_in:3600,scope:''})});
  await assert.rejects(oauth.client.connect(CLIENT_ID),/操作権限/);

  const management = fixture(); await authenticate(management);
  let pages = 0;
  management.handler(url => { pages++; if(pages===1)return reply({items:[broadcast()],nextPageToken:'a+b'}); assert.match(url,/pageToken=a%2Bb/);return reply({items:[]}); });
  assert.equal((await management.client.call('listMyBroadcasts')).items.length,1);
  management.handler((url,o) => {
    if(o.method==='GET')return reply({items:[broadcast()]});
    const body=JSON.parse(o.body); assert.equal(o.method,'PUT');
    assert.equal(body.snippet.scheduledEndTime,'2099-01-01T01:00:00Z');
    assert.ok(!('publishedAt' in body.snippet)); assert.ok(!('channelId' in body.snippet));
    assert.equal(body.status.selfDeclaredMadeForKids,true);
    return reply({...broadcast(),snippet:{...body.snippet},status:{...body.status,lifeCycleStatus:'ready'}});
  });
  assert.equal((await management.client.call('updateBroadcast',{...sample,id:'abcdefghijk'})).id,'abcdefghijk');
  for(const method of ['updateBroadcast','replaceBroadcastThumbnail','deleteBroadcast']) {
    management.handler(() => reply({items:[broadcast('abcdefghijk','live')]}));
    await assert.rejects(management.client.call(method,method==='deleteBroadcast'?'abcdefghijk':{...sample,id:'abcdefghijk',thumbnail:thumb}),/待機中/);
  }
  management.handler(() => reply({items:[broadcast('abcdefghijk','ready','other-channel')]}));
  await assert.rejects(management.client.call('deleteBroadcast','abcdefghijk'),/接続先チャンネル/);
  management.handler((url,o) => o.method==='DELETE'?reply('',204):reply({items:[broadcast()]}));
  assert.equal((await management.client.call('deleteBroadcast','abcdefghijk')).deleted,true);
  a.handler((url,o) => o.method==='DELETE'?reply('',204):reply({items:[broadcast()]}));
  await a.client.call('deleteBroadcast','abcdefghijk');
  await assert.rejects(a.client.call('createBatchRow',sample),/削除済み/);
  const noLocks=fixture({locks:{}}); await authenticate(noLocks);
  await assert.rejects(noLocks.client.call('createBatchRow',sample),/二重登録防止/);
  process.stdout.write('PASS: Pages OAuth/session expiry, channel isolation, create/update/delete/list/upload, JST, pagination, persistent cross-tab deduplication, ambiguous-write recovery, storage failures; mocked API only\n');
}
async function migrationTests() {
  const f=fixture();
  const template = {name:'検証テンプレート',event:'',team:'',pattern:'',description:'',privacy:'private',interval:30};
  const saved=await f.client.call('saveTemplate',template); assert.equal(saved.length,1);
  assert.equal((await f.client.call('getTemplates'))[0].name,template.name);
  const data={format:'live-scheduler-backup',version:1,templates:saved,draft:{v:6,date:'',event:'',team:'',pattern:'',description:'',privacy:'private',interval:'30',sort:'time',rows:[]}};
  assert.equal(f.client.importBackup(data).templateCount,1);
  const withRow={...data,draft:{...data.draft,rows:[{...sample,state:'pending',id:sample.requestId,round:'予選',format:'',opponent:''}]}};
  assert.equal(f.client.importBackup(withRow).rowCount,1);
  const withOverrides={...withRow,draft:{...withRow.draft,inputText:'09:00\n自由なタイトル',rows:[{...withRow.draft.rows[0],thumbMode:'custom',overrides:{date:'2099-01-02',privacy:'unlisted',description:''}}]}};
  f.client.importBackup(withOverrides);
  const roundTrip=JSON.parse(f.storage.getItem('live_scheduler_v06_draft'));
  assert.equal(roundTrip.inputText,withOverrides.draft.inputText);
  assert.equal(roundTrip.rows[0].overrides.date,'2099-01-02');
  assert.equal(roundTrip.rows[0].overrides.description,'');
  assert.equal(roundTrip.rows[0].thumbMode,'custom');
  assert.throws(()=>f.client.importBackup({...withOverrides,draft:{...withOverrides.draft,rows:[{...withOverrides.draft.rows[0],overrides:{privacy:'invalid'}}]}}),/公開設定/);
  const before=[...f.storage.map.values()].join('');
  assert.throws(()=>f.client.importBackup({...data,version:9}),/書き出しファイル/);
  assert.throws(()=>f.client.importBackup({...withRow,draft:{...withRow.draft,rows:[{...withRow.draft.rows[0],state:'error'}]}}),/登録失敗/);
  assert.equal([...f.storage.map.values()].join(''),before);
  const originalSetItem = f.storage.setItem.bind(f.storage);
  let writeCount = 0;
  f.storage.setItem = (key,value) => { if (++writeCount === 2) throw Error('quota'); originalSetItem(key,value); };
  assert.throws(()=>f.client.importBackup({...data,templates:[]}),/端末に保存/);
  assert.equal([...f.storage.map.values()].join(''),before,'failed import rolls both keys back');
  f.storage.setItem = originalSetItem;
  await f.client.call('deleteTemplate',saved[0].id);
  assert.equal((await f.client.call('getTemplates')).length,0);
  process.stdout.write('PASS: Offline template operations and validated backup import, preserving saved data on invalid input\n');
}
async function domTests() {
  const errors=[], virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',e=>errors.push(e));
  let callbacks, connected=false, items=[], creates=[], updates=[], deletes=[], failCreate=false, releaseCreate=null;
  const fakeClient={
    state:()=>({connected,channel:connected?{id:'channel-A',title:'検証チャンネル'}:null,active:0,authorizing:false}),
    async connect(){connected=true;callbacks.onState(fakeClient.state());},
    disconnect(){connected=false;callbacks.onState(fakeClient.state());},
    async call(method,input){
      if(method==='getTemplates')return [];
      if(method==='getUncertainRecords')return [];
      if(method==='listMyBroadcasts')return {items:items.map(x=>({...x}))};
      if(method==='createBatchRow'){
        creates.push(input);if(releaseCreate)await new Promise(resolve=>{releaseCreate=resolve});
        if(failCreate){failCreate=false;throw Error('検証用エラー')}
        const id=String(creates.length).padStart(11,'x');
        items.push({id,title:input.title,description:input.description,privacy:input.privacy,scheduledStartTime:input.date+'T'+input.time+':00+09:00',lifeCycle:'ready',url:'https://www.youtube.com/watch?v='+id});
        return {id,url:'https://www.youtube.com/watch?v='+id};
      }
      if(method==='updateBroadcast'){updates.push(input);const b=items.find(x=>x.id===input.id);Object.assign(b,input,{scheduledStartTime:input.date+'T'+input.time+':00+09:00'});return {...b};}
      if(method==='deleteBroadcast'){deletes.push(input);items=items.filter(x=>x.id!==input);return {deleted:true};}
      throw Error('Unexpected method '+method);
    },assertExportable(){}
  };
  class LocalResources extends ResourceLoader{fetch(url){if(url==='https://accounts.google.com/gsi/client')return Promise.resolve(Buffer.from(''));const name=new URL(url).pathname.split('/').at(-1);if(name==='client.js')return Promise.resolve(Buffer.from(''));if(['ui.js','app.css'].includes(name))return Promise.resolve(fs.readFileSync(path.join(root,'dist',name)));throw Error('Unexpected resource '+url);}}
  const dom=new JSDOM(fs.readFileSync(path.join(root,'dist/index.html'),'utf8'),{url:'http://localhost:8000/',runScripts:'dangerously',resources:new LocalResources(),pretendToBeVisual:true,virtualConsole,beforeParse(w){
    w.crypto.randomUUID=()=>webcrypto.randomUUID();w.LiveSchedulerPages={createClient(o){callbacks=o;return fakeClient}};
    w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
  }});
  try{
    await new Promise(resolve=>dom.window.addEventListener('load',resolve,{once:true}));
    const w=dom.window,$=id=>w.document.getElementById(id),tick=()=>new Promise(r=>setTimeout(r,0));
    const input=(n,v)=>{n.value=v;n.dispatchEvent(new w.Event('input',{bubbles:true}));};
    const change=(n,v)=>{n.value=v;n.dispatchEvent(new w.Event('change',{bubbles:true}));};
    const confirm=async action=>{const pending=action();await tick();assert.equal($('confirmDialog').open,true);$('acceptConfirm').click();await pending;await tick();};
    assert.equal($('count').textContent,'0件');assert.equal($('privacy').value,'public');
    // The old saved draft key remains readable, without assigning new request IDs.
    w.localStorage.setItem('live_scheduler_v06_draft',JSON.stringify({v:6,date:'2099-01-01',privacy:'private',description:'旧下書き',rows:[{id:'legacy_request_123456',title:'旧版の試合',time:'09:00',state:'pending',thumbMode:'inherit'}]}));
    await $('loadDraft').onclick();assert.equal($('matches').children[0].dataset.rowId,'legacy_request_123456');assert.equal($('description').value,'旧下書き');
    await $('back').onclick();await $('back').onclick();
    $('schedule').value='';await $('next').onclick();assert.match($('inputError').textContent,/入力/);
    // Return to a fresh input without changing the test's save policy.
    await confirm(async()=>{ $('schedule').value='9:30\n自由なタイトル\n\n10:00\n別のタイトル'; return $('next').onclick(); });
    await $('back').onclick();
    input($('schedule'),'9:30\n自由なタイトル\n\n10:00\n別のタイトル');await $('next').onclick();assert.equal($('settingsStep').hidden,false);
    $('date').value='2099-01-01';$('privacy').value='private';await $('next').onclick();assert.equal($('matches').children.length,2);
    const first=$('matches').children[0],textarea=first.querySelector('textarea');input(textarea,'直接編集したタイトル');
    const individualDate=first.querySelector('input[type=date]');input(individualDate,'2099-01-02');
    change(first.querySelector('select'),'unlisted');input(first.querySelector('details textarea'),'個別の説明');
    $('saveDraft').click();const draft=JSON.parse(w.localStorage.getItem('live_scheduler_v06_draft'));assert.equal(draft.rows[0].overrides.date,'2099-01-02');assert.equal(draft.rows[0].title,'直接編集したタイトル');
    $('oauthClientId').value=CLIENT_ID;await $('connectGoogle').onclick();await tick();assert.match($('connectionStatus').textContent,/検証チャンネル/);
    // One failure, one success; only failure is retried. Submitted values include overrides.
    failCreate=true;await confirm(()=>$('next').onclick());assert.equal($('completeStep').hidden,false);assert.match($('completeTitle').textContent,/成功 1件 \/ 失敗 1件/);
    assert.equal(creates[0].date,'2099-01-02');assert.equal(creates[0].privacy,'unlisted');assert.equal(creates[0].description,'個別の説明');
    await confirm(()=>$('retryFailed').onclick());assert.equal(creates.length,3);assert.equal(creates[0].requestId,creates[2].requestId);assert.equal(creates[1].date,'2099-01-01');
    await $('goManage').onclick();await tick();assert.equal($('manageView').hidden,false);assert.equal($('broadcasts').children.length,2);
    const toggle=()=>$('broadcasts').querySelector('.booking-toggle');await toggle().onclick();await $('broadcasts').querySelector('.actions button').onclick();
    input($('editTitle'),'保存前の編集');const opening=$('broadcasts').querySelectorAll('.booking-toggle')[1].onclick();await tick();assert.equal($('confirmDialog').open,true);$('cancelConfirm').click();await opening;assert.equal($('editTitle').value,'保存前の編集');
    // Filtering cannot silently discard an editor. Cancel restores the previous filter.
    change($('manageSort'),'desc');await tick();$('cancelConfirm').click();await tick();assert.equal($('manageSort').value,'asc');assert.equal($('editTitle').value,'保存前の編集');
    await $('broadcasts').querySelector('.actions button').onclick();assert.equal(updates.length,1);assert.equal(updates[0].title,'保存前の編集');assert.equal($('editTitle'),null);
    let cb=$('broadcasts').querySelector('input[type=checkbox]');cb.checked=true;cb.dispatchEvent(new w.Event('change'));assert.equal($('bulkDelete').disabled,false);
    input($('filter'),'保存前');await tick();assert.equal($('bulkCount').textContent,'0件選択');assert.equal($('broadcasts').querySelectorAll('article').length,1);
    input($('filter'),'');await tick();change($('manageSort'),'desc');await tick();assert.match($('broadcasts').firstChild.textContent,/2099-01-02/);
    items.push({id:'live0000001',title:'配信中',lifeCycle:'live',privacy:'public',scheduledStartTime:'2099-01-03T00:00:00Z',url:'https://www.youtube.com/watch?v=live0000001'});
    await $('refresh').onclick();change($('statusFilter'),'live');await tick();assert.equal($('broadcasts').querySelector('input[type=checkbox]').disabled,true);assert.match($('broadcasts').textContent,/配信中/);
    change($('statusFilter'),'scheduled');await tick();for(const n of $('broadcasts').querySelectorAll('input[type=checkbox]')){n.checked=true;n.dispatchEvent(new w.Event('change'));}
    assert.match($('bulkDelete').textContent,/2件/);await confirm(()=>$('bulkDelete').onclick());assert.equal(deletes.length,2);assert.match($('manageStatus').textContent,/削除成功 2件/);
    assert.equal(errors.length,0,errors.map(String).join('\n'));
  }finally{dom.window.close()}
  process.stdout.write('PASS: Three-step UI, free titles, overrides, manual draft, partial retry, edit loss prevention, filters/sort/search, live restrictions, bulk deletion; mocked API only\n');
}
(async()=>{await apiTests();await migrationTests();await domTests();})().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
