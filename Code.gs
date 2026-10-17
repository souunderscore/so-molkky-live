/** Live Scheduler v0.6 - Google Apps Script */
const API_BASE = 'https://www.googleapis.com/youtube/v3';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Live Scheduler v0.6')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function authorize() {
  ScriptApp.getOAuthToken();
  return '認証を確認しました';
}

/** v0.1互換。既存の関数名を維持します。 */
function createBroadcast(input) {
  return createBroadcastCore_(input);
}

/**
 * 同じrequestIdで再送した際、成功記録がある予約枠は再作成しない。
 * 作成後にGASの保存処理自体が失敗した場合の二重作成までは防げないため、
 * 通信エラー時はYouTube Studioを確認してから再試行すること。
 */
function createBatchRow(input) {
  if (!input || typeof input !== 'object') throw new Error('入力がありません');
  const requestId = validateRequestId_(input.requestId);
  const key = 'ls02_' + requestId; // v0.2の作成記録も利用
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('処理が混み合っています。再試行前にYouTube Studioを確認してください');
  try {
    const store = PropertiesService.getScriptProperties();
    let record = store.getProperty(key);
    let result;
    if (record) {
      result = JSON.parse(record);
    } else {
      result = createBroadcastCore_(input);
      // 先に予約作成記録を保存。サムネ失敗時も動画を二重作成しない。
      store.setProperty(key, JSON.stringify(result));
    }
    if (!input.thumbnail) return Object.assign({}, result, {thumbnailState: result.thumbnailState || 'none'});
    // 同じリクエストで画像アップロードに成功済みなら再実行しない
    if (result.thumbnailState === 'ok') return Object.assign({}, result, {reused: true});
    try {
      uploadThumbnailCore_(result.id, input.thumbnail);
      result.thumbnailState = 'ok';
      result.thumbnailError = '';
    } catch (e) {
      result.thumbnailState = 'error';
      result.thumbnailError = String(e.message || e);
    }
    store.setProperty(key, JSON.stringify(result));
    return result;
  } finally { lock.releaseLock(); }
}

function retryThumbnail(input) {
  if (!input || typeof input !== 'object') throw new Error('入力がありません');
  const requestId = validateRequestId_(input.requestId);
  const key = 'ls02_' + requestId;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('処理が混み合っています');
  try {
    const store = PropertiesService.getScriptProperties();
    const saved = store.getProperty(key);
    if (!saved) throw new Error('予約の記録がありません。YouTube Studioで確認してください');
    const result = JSON.parse(saved);
    if (result.thumbnailState === 'ok') return result;
    try {
      uploadThumbnailCore_(result.id, input.thumbnail);
      result.thumbnailState = 'ok';
      result.thumbnailError = '';
    } catch (e) {
      result.thumbnailState = 'error';
      result.thumbnailError = String(e.message || e);
    }
    store.setProperty(key, JSON.stringify(result));
    return result;
  } finally { lock.releaseLock(); }
}

function validateRequestId_(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(id)) throw new Error('リクエストIDが不正です');
  return id;
}

function uploadThumbnailCore_(videoId, thumbnail) {
  if (!thumbnail || typeof thumbnail !== 'object' ||
      !['image/jpeg', 'image/png'].includes(thumbnail.mime)) {
    throw new Error('JPEGまたはPNG画像を指定してください');
  }
  if (typeof thumbnail.base64 !== 'string' || thumbnail.base64.length > 4200000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(thumbnail.base64)) {
    throw new Error('画像データが不正か大きすぎます');
  }
  const bytes = Utilities.base64Decode(thumbnail.base64);
  if (bytes.length > 3000000) throw new Error('画像は3MB以下にしてください');
  const response = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=' + encodeURIComponent(videoId) + '&uploadType=media', {
      method: 'post', contentType: thumbnail.mime, payload: bytes,
      headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()},
      muteHttpExceptions: true
    });
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    let detail = response.getContentText().slice(0,500);
    try { detail = JSON.parse(detail).error.message || detail; } catch (_) {}
    throw new Error('サムネイル設定エラー（HTTP ' + status + '）：' + detail);
  }
}

function createBroadcastCore_(input) {
  if (!input || typeof input !== 'object') throw new Error('入力がありません');
  const title = String(input.title || '').trim();
  const day = String(input.date || '');
  const time = String(input.time || '');
  const privacy = String(input.privacy || 'public');
  const description = String(input.description || '').trim();

  if (!title || title.length > 100) throw new Error('タイトルは1〜100文字で入力してください');
  if (description.length > 4900) throw new Error('説明文は4900文字以内にしてください');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error('日時が不正です');
  }
  if (!['public', 'unlisted', 'private'].includes(privacy)) throw new Error('公開設定が不正です');
  const start = new Date(`${day}T${time}:00+09:00`);
  if (!Number.isFinite(start.getTime()) || start.getTime() <= Date.now()) {
    throw new Error('未来の日時を指定してください');
  }
  const check = Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  if (check !== `${day} ${time}`) throw new Error('存在しない日時です');

  const payload = {
    snippet: { title, description: description,
      scheduledStartTime: start.toISOString() },
    status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
    contentDetails: { enableAutoStart: false, enableAutoStop: false, enableDvr: true }
  };
  const response = UrlFetchApp.fetch(`${API_BASE}/liveBroadcasts?part=snippet,status,contentDetails`, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload),
    headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  let data;
  try { data = JSON.parse(response.getContentText()); }
  catch (_) { throw new Error(`API応答を読み取れません（HTTP ${code}）。予約一覧を確認してください`); }
  if (code < 200 || code >= 300) {
    throw new Error(`YouTube API（HTTP ${code}）: ${(data.error && data.error.message) || '不明なエラー'}`);
  }
  if (!data.id) throw new Error('API応答に動画IDがありません。予約一覧を確認してください');
  return { id: data.id, title: title, url: `https://www.youtube.com/watch?v=${data.id}` };
}


/** v0.4: YouTube API呼び出しを共通化 */
function ytRequest_(method, path, body) {
  const opt = {method: method, headers: {Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true};
  if (body !== undefined) {opt.contentType='application/json';opt.payload=JSON.stringify(body);}
  const res=UrlFetchApp.fetch(API_BASE+path,opt), status=res.getResponseCode();
  const raw=res.getContentText(); let data={};
  if (raw) {try {data=JSON.parse(raw);} catch (_) {if(status>=400) throw new Error('YouTube API HTTP '+status+': '+raw.slice(0,250));}}
  if(status<200||status>=300) throw new Error('YouTube API HTTP '+status+': '+(data.error&&data.error.message||raw.slice(0,300)));
  return data;
}
function ensureVideoId_(id){if(!/^[\w-]{11}$/.test(String(id||''))) throw new Error('動画IDが不正です');return id;}
function formatBroadcast_(b){
  const s=b.snippet||{},st=b.status||{};
  return {id:b.id,title:s.title||'',description:s.description||'',scheduledStartTime:s.scheduledStartTime||'',scheduledEndTime:s.scheduledEndTime||'',privacy:st.privacyStatus||'private',lifeCycle:st.lifeCycleStatus||'',url:'https://www.youtube.com/watch?v='+b.id};
}
/** mine=trueでチャンネル全件取得（現在のGAS実行時間を考慮して最大500件） */
function listMyBroadcasts(){
  let token='', result=[];
  for(let i=0;i<10;i++){
    let path='/liveBroadcasts?part=id,snippet,status&mine=true&broadcastType=all&maxResults=50';
    if(token) path+='&pageToken='+encodeURIComponent(token);
    const page=ytRequest_('get',path);
    result=result.concat((page.items||[]).map(formatBroadcast_));
    token=page.nextPageToken||'';
    if(!token)break;
  }
  return {items:result,hasMore:!!token};
}
function getBroadcast_(id){
  const data=ytRequest_('get','/liveBroadcasts?part=id,snippet,status&broadcastType=all&id='+encodeURIComponent(ensureVideoId_(id)));
  if(!data.items||!data.items.length)throw new Error('予約が見つかりません');
  return data.items[0];
}
function parseJst_(date,time){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw new Error('日時が不正です');
  const d=new Date(date+'T'+time+':00+09:00');
  if(!isFinite(d.getTime())||Utilities.formatDate(d,'Asia/Tokyo','yyyy-MM-dd HH:mm')!==date+' '+time)throw new Error('存在しない日時です');
  if(d.getTime()<=Date.now())throw new Error('開始予定時刻は未来にしてください');
  return d.toISOString();
}
/** 既存値を再取得して差分がない情報を維持 */
function updateBroadcast(input){
  const id=ensureVideoId_(input.id), b=getBroadcast_(id);
  if(!['created','ready'].includes(b.status&&b.status.lifeCycleStatus)) throw new Error('配信待機中の予約だけ編集できます');
  const title=String(input.title||'').trim(),description=String(input.description||'');
  if(!title||title.length>100||description.length>4900)throw new Error('タイトルまたは説明文が長すぎます');
  const privacy=String(input.privacy||'');
  if(!['public','unlisted','private'].includes(privacy))throw new Error('公開設定が不正です');
  const scheduledStartTime=parseJst_(String(input.date||''),String(input.time||''));
  const snippet=Object.assign({},b.snippet,{title,description,scheduledStartTime});
  // 読み取り専用フィールドは更新ペイロードから除外
  ['actualStartTime','actualEndTime','publishedAt','channelId','channelTitle','liveChatId','thumbnails'].forEach(k=>delete snippet[k]);
  const status={privacyStatus:privacy,selfDeclaredMadeForKids:!!b.status.selfDeclaredMadeForKids};
  const data=ytRequest_('put','/liveBroadcasts?part=snippet,status', {id,snippet,status});
  return formatBroadcast_(data);
}
function deleteBroadcast(id){
  const b=getBroadcast_(id);
  if(!['created','ready'].includes(b.status&&b.status.lifeCycleStatus))throw new Error('配信待機中の予約だけ削除できます');
  ytRequest_('delete','/liveBroadcasts?id='+encodeURIComponent(ensureVideoId_(id)));
  return {deleted:true,id};
}
function replaceBroadcastThumbnail(input){
  const b=getBroadcast_(input.id);
  if(!['created','ready'].includes(b.status&&b.status.lifeCycleStatus))throw new Error('配信待機中の予約だけ変更できます');
  uploadThumbnailCore_(b.id,input.thumbnail);
  return {ok:true};
}
const TEMPLATE_KEY_='live_scheduler_v04_templates';
function getTemplates(){return JSON.parse(PropertiesService.getUserProperties().getProperty(TEMPLATE_KEY_)||'[]');}
function saveTemplate(input){
  const t={id:String(input.id||Utilities.getUuid()),name:String(input.name||'').trim(),event:String(input.event||''),team:String(input.team||''),pattern:String(input.pattern||''),description:String(input.description||''),privacy:String(input.privacy||'public'),interval:Number(input.interval||30)};
  if(!t.name||t.name.length>60||t.event.length>200||t.team.length>100||t.pattern.length>300||t.description.length>4900||!['public','unlisted','private'].includes(t.privacy)||![20,25,30,40,60].includes(t.interval))throw new Error('テンプレートの入力を確認してください');
  const list=getTemplates().filter(x=>x.id!==t.id);
  if(list.length>=10)throw new Error('テンプレートは最大10件です');
  list.push(t);const str=JSON.stringify(list);
  if(str.length>8000)throw new Error('テンプレートの合計容量が上限です。説明文を短くするか、不要なテンプレートを削除してください');
  PropertiesService.getUserProperties().setProperty(TEMPLATE_KEY_,str);
  return list;
}
function deleteTemplate(id){const list=getTemplates().filter(x=>x.id!==id);PropertiesService.getUserProperties().setProperty(TEMPLATE_KEY_,JSON.stringify(list));return list;}