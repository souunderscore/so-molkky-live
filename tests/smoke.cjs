const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
async function main() {
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(fs.readFileSync(root + '/Index.html', 'utf8'), {
    url: 'http://localhost:8000/Index.html', runScripts: 'dangerously',
    pretendToBeVisual: true, virtualConsole: console
  });
  try {
    const w = dom.window, $ = id => w.document.getElementById(id);
    assert.equal($('count').textContent, '0件');
    $('event').value = '環境確認大会'; $('team').value = 'テストチーム';
    $('add1').click();
    assert.equal($('count').textContent, '1件');
    await $('generate').onclick();
    assert.match($('matches').textContent, /環境確認大会/);
    $('saveDraft').click();
    const draft = JSON.parse(w.localStorage.getItem('live_scheduler_v06_draft'));
    assert.equal(draft.rows.length, 1);
    assert.match(draft.rows[0].title, /テストチーム/);
    await $('insertExample').onclick(); $('parsePaste').click();
    assert.equal($('pasteError').textContent, '');
    const count = $('parsedRows').children.length;
    assert.ok(count > 0);
    await $('applyPaste').onclick();
    assert.equal($('matches').children.length, count + 1);
    await assert.rejects(w.api('listMyBroadcasts'), /Google Apps Script/);
    assert.equal(errors.length, 0, errors.map(String).join('\n'));
    process.stdout.write('PASS: DOM startup, match addition, title generation, draft persistence, example parsing/import, explicit GAS-only API boundary\n');
  } finally { dom.window.close(); }
  let calls = 0;
  const properties = new Map();
  const propertyStore = { getProperty: key => properties.get(key) || null,
    setProperty: (key, value) => properties.set(key, value) };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => propertyStore, getUserProperties: () => propertyStore },
    LockService: { getScriptLock: () => ({tryLock: () => true, releaseLock() {}}) },
    ScriptApp: { getOAuthToken: () => 'local-test-only' },
    Utilities: { getUuid: () => 'local-template', formatDate: d => new Date(d.getTime() + 9*3600000).toISOString().slice(0,16).replace('T',' ') },
    UrlFetchApp: { fetch: (url, options) => {
      calls++;
      assert.match(url, /^https:\/\/www\.googleapis\.com\/youtube\/v3\/liveBroadcasts/);
      assert.equal(options.method, 'post');
      const body = JSON.parse(options.payload);
      assert.equal(body.status.privacyStatus, 'private');
      assert.equal(body.snippet.scheduledStartTime, '2099-01-01T00:00:00.000Z');
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({id:'abcdefghijk'}) };
    } }
  });
  vm.runInContext(fs.readFileSync(root+'/Code.gs', 'utf8'), context);
  const input = {requestId:'local_smoke_123456', title:'環境確認', date:'2099-01-01', time:'09:00', privacy:'private'};
  assert.equal(context.createBatchRow(input).id, 'abcdefghijk');
  assert.equal(context.createBatchRow(input).id, 'abcdefghijk');
  assert.equal(calls, 1);
  assert.throws(() => context.createBroadcast({...input, time:'25:00'}), /日時が不正/);
  assert.throws(() => context.validateRequestId_('bad'), /不正/);
  assert.equal(context.saveTemplate({name:'環境確認', privacy:'private', interval:30}).length, 1);
  assert.equal(context.getTemplates()[0].name, '環境確認');
  assert.equal(context.deleteTemplate('local-template').length, 0);
  process.stdout.write('PASS: GAS logic with local service doubles: private reservation payload/JST conversion, duplicate prevention, invalid-input rejection, template save/read/delete; no Google API requests made\n');
}
main().catch(e => { process.stderr.write(e.stack+'\n'); process.exitCode=1; });
