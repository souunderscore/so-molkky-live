/* Three-step browser UI. All Google writes go through the existing guarded adapter. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const make = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const PRIV = { public:'公開', unlisted:'限定公開', private:'非公開' };
  const DRAFT = 'live_scheduler_v06_draft', CLIENT_ID = 'live_scheduler_pages_client_id';
  let rows = [], step = 1, view = 'create', previousView = 'create', parsedText = '', commonThumb = null;
  let busy = false, dirty = false, channel = [], selected = new Set(), expanded = null, editor = null, editInitial = '';
  let lastChannel = null, recoverySignature = '', recoveryLoading = false;
  const uid = () => 'ls' + crypto.randomUUID().replaceAll('-', '');
  const client = LiveSchedulerPages.createClient({ onState: renderConnection });
  window.liveSchedulerPages = client;
  const message = (id, text, error = false) => { $(id).textContent = text; $(id).className = error ? 'error' : 'muted'; };
  const auto = t => { t.style.height = 'auto'; t.style.height = Math.max(48, t.scrollHeight + 2) + 'px'; };
  const markDirty = () => { dirty = true; message('draftStatus', '未保存の変更があります。画像は下書きに保存されません。'); };
  function confirmAction(title, content, text = '実行') {
    return new Promise(resolve => {
      const d = $('confirmDialog'); $('confirmTitle').textContent = title;
      $('confirmContent').replaceChildren(typeof content === 'string' ? make('p', content) : content);
      $('acceptConfirm').textContent = text;
      function finish(value) { d.close(); $('acceptConfirm').onclick = null; $('cancelConfirm').onclick = null; d.oncancel = null; resolve(value); }
      $('acceptConfirm').onclick = () => finish(true); $('cancelConfirm').onclick = () => finish(false);
      d.oncancel = e => { e.preventDefault(); finish(false); }; d.showModal();
    });
  }
  function readEditor() {
    if (!editor) return null;
    return { title:$('editTitle').value, date:$('editDate').value, time:$('editTime').value,
      privacy:$('editPrivacy').value, description:$('editDescription').value, image:$('editThumb').files[0]?.name || '' };
  }
  const editChanged = () => editor && JSON.stringify(readEditor()) !== editInitial;
  async function leaveEditor() {
    if (editChanged() && !await confirmAction('変更を破棄しますか？', '未保存の編集内容を破棄します。', '破棄する')) return false;
    editor = null; editInitial = ''; return true;
  }
  let disabledBefore = [];
  function setBusy(value) {
    busy = value;
    if (value) { disabledBefore = [...document.querySelectorAll('button,input,textarea,select')].map(n => [n,n.disabled]); disabledBefore.forEach(([n]) => n.disabled = true); }
    else { disabledBefore.forEach(([n, was]) => n.disabled = was); disabledBefore = []; renderConnection(client.state()); updateBulk(); }
  }
  function renderConnection(s) {
    if (!$('connectionStatus')) return;
    $('connectionStatus').textContent = s.authorizing ? 'Googleに接続中…' : s.connected && s.channel ? '接続先：' + s.channel.title : '未接続 · Googleへの接続が必要です';
    $('connectGoogle').textContent = s.connected ? '再接続' : 'Googleに接続';
    $('connectGoogle').disabled = busy || !!s.active || s.authorizing;
    $('disconnectGoogle').disabled = busy || !!s.active || s.authorizing || !s.connected;
    $('oauthClientId').disabled = busy || s.connected || s.authorizing;
    if (s.connected && s.channel && lastChannel !== s.channel.id) {
      if (lastChannel !== null) { channel = []; selected.clear(); expanded = null; editor = null; $('broadcasts').replaceChildren(); message('manageStatus', '接続先が変わりました。「更新」で取得してください。'); }
      lastChannel = s.channel.id; recoverySignature = '';
    }
  }
  $('connectGoogle').onclick = () => {
    if (busy) return;
    const id = $('oauthClientId').value.trim();
    if (!id) { showView('settings'); $('connectionSettings').open = true; $('oauthClientId').focus(); return; }
    if (editChanged()) { message('connectionStatus', '編集中の変更を保存またはキャンセルしてから再接続してください。', true); return; }
    try {
      localStorage.setItem(CLIENT_ID, id);
      // Synchronous invocation preserves iPhone's popup permission.
      client.connect(id).then(() => { $('connectionSettings').open = false; refreshRecovery(); })
        .catch(e => message('connectionStatus', e.message, true));
    } catch (e) { message('connectionStatus', e.message, true); }
  };
  $('disconnectGoogle').onclick = async () => { if (busy || !await leaveEditor()) return; try { client.disconnect(); channel = []; selected.clear(); renderManage(); } catch (e) { message('connectionStatus', e.message, true); } };
  async function showView(next) {
    if (busy || (next !== view && !await leaveEditor())) return;
    if (next === 'settings') previousView = view === 'settings' ? previousView : view;
    view = next; ['create','manage','settings'].forEach(v => $(v+'View').hidden = v !== next);
    $('createNav').setAttribute('aria-pressed', String(next === 'create')); $('manageNav').setAttribute('aria-pressed', String(next === 'manage'));
    if (next === 'manage') { renderManage(); if (!channel.length && client.state().connected) refreshManage(); }
  }
  $('createNav').onclick = () => showView('create'); $('manageNav').onclick = () => showView('manage');
  $('openSettings').onclick = () => showView('settings'); $('closeSettings').onclick = () => showView(previousView);
  function showStep(n) {
    step = n; ['inputStep','settingsStep','reviewStep','completeStep'].forEach((id,i) => $(id).hidden = i+1 !== n);
    $('steps').hidden = n === 4; $('createFooter').hidden = n === 4; $('back').hidden = n === 1;
    [...$('steps').children].forEach((li,i) => i+1 === n ? li.setAttribute('aria-current','step') : li.removeAttribute('aria-current'));
    $('next').textContent = n === 1 ? '試合を読み取る →' : n === 2 ? '予約内容を確認 →' : rows.filter(r=>r.state!=='ok').length+'件をYouTubeに予約';
    $('count').textContent = rows.length+'件'; if (n === 3) renderReview();
    $('schedule').disabled = rows.some(r => r.state !== 'pending');
  }
  function parseSchedule(text) {
    const lines = text.replace(/\r/g,'').split('\n').map((t,i)=>({t:t.trim(),line:i+1})).filter(x=>x.t);
    if (!lines.length) throw Error('時刻とタイトルを入力してください。');
    const parsed = [];
    for (let i=0; i<lines.length; i+=2) {
      const a=lines[i], b=lines[i+1];
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(a.t)) throw Error(a.line+'行目：時刻を「時:分」で入力してください。');
      if (!b) throw Error(a.line+'行目の時刻の次にタイトルを入力してください。');
      if (b.t.length>100) throw Error(b.line+'行目：タイトルを100文字以内にしてください。');
      parsed.push({ id:uid(),time:a.t.padStart(5,'0'),title:b.t,state:'pending',url:'',thumbMode:'inherit',thumb:null,overrides:{},error:'',thumbnailError:'' });
    }
    if (parsed.length>50) throw Error('一度に作成できるのは50件までです。');
    return parsed;
  }
  function syncText() { $('schedule').value = rows.map(r=>r.time+'\n'+r.title).join('\n\n'); parsedText = $('schedule').value; }
  function field(parent, label, type, value, onChange, id) {
    const l = make('label', label), f = make(type==='textarea'?'textarea':'input');
    if (type==='textarea') { f.rows=1; f.className='autosize'; } else f.type=type;
    if (id) { f.id=id; l.htmlFor=id; } else { f.id='f-'+uid(); l.htmlFor=f.id; }
    if (type!=='file'&&type!=='checkbox') f.value=value??'';
    f.oninput=()=>{ onChange(f.value); if(type==='textarea') auto(f); };
    parent.append(l,f); if(type==='textarea') requestAnimationFrame(()=>auto(f)); return f;
  }
  function select(parent,label,value,options,onChange,id) {
    const l=make('label',label),s=make('select');s.id=id||'f-'+uid();l.htmlFor=s.id;
    Object.entries(options).forEach(([v,t])=>{const o=make('option',t);o.value=v;s.append(o)});s.value=value;s.onchange=()=>onChange(s.value);parent.append(l,s);return s;
  }
  function preview(parent, image, alt) { if (!image) return; const img=make('img');img.className='thumbnail';img.alt=alt;img.src='data:'+image.mime+';base64,'+image.base64;parent.append(img); }
  async function fileToThumb(file) {
    if (!file || !file.type.startsWith('image/')) throw Error('画像ファイルを選択してください。');
    const image=await new Promise((resolve,reject)=>{const img=new Image(),url=URL.createObjectURL(file);img.onload=()=>{URL.revokeObjectURL(url);resolve(img)};img.onerror=()=>{URL.revokeObjectURL(url);reject(Error('画像を読み込めません。'))};img.src=url});
    const canvas=document.createElement('canvas'),scale=Math.min(1,1280/image.width,720/image.height);
    canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
    let uri;for(const quality of [.85,.7,.5,.3]){uri=canvas.toDataURL('image/jpeg',quality);if(uri.length<2700000)break}
    if(uri.length>=2700000)throw Error('画像が大きすぎます。');return{mime:'image/jpeg',base64:uri.split(',')[1]};
  }
  $('commonThumb').onchange=async()=>{if(busy)return;try{const file=$('commonThumb').files[0];if(!file){commonThumb=null;$('commonPreview').hidden=true;return}setBusy(true);commonThumb=await fileToThumb(file);$('commonPreview').src='data:'+commonThumb.mime+';base64,'+commonThumb.base64;$('commonPreview').hidden=false;markDirty();message('settingsError','')}catch(e){commonThumb=null;$('commonPreview').hidden=true;message('settingsError',e.message,true)}finally{setBusy(false)}};
  function effective(r) { return { requestId:r.id,title:r.title.trim(),time:r.time,date:r.overrides.date??$('date').value,privacy:r.overrides.privacy??$('privacy').value,description:r.overrides.description??$('description').value,thumbnail:r.thumbMode==='none'?null:r.thumbMode==='custom'?r.thumb:commonThumb }; }
  function validInput(p) {
    if (!p.title || p.title.length>100) throw Error('タイトルは1〜100文字にしてください。');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time)) throw Error('日付・開始時刻を確認してください。');
    const d=new Date(p.date+'T'+p.time+':00+09:00');if(!Number.isFinite(+d)||new Date(+d+9*3600000).toISOString().slice(0,16)!==p.date+'T'+p.time)throw Error('存在しない日時です。');
    if(d<=new Date())throw Error('開始予定時刻は未来にしてください。');if(p.description.length>4900)throw Error('説明文は4900文字以内にしてください。');
  }
  function renderReview() {
    $('commonSummary').replaceChildren(make('h3','全試合共通'),make('div',$('date').value+' · '+PRIV[$('privacy').value]),make('div',$('description').value?'説明文あり':'説明文なし'),make('div',commonThumb?'共通サムネイルあり':'サムネイルなし'));preview($('commonSummary'),commonThumb,'共通サムネイル');
    $('matches').replaceChildren(); rows.forEach((r,i)=>{
      const card=make('article',undefined,'card');card.dataset.rowId=r.id;
      card.append(make('h3','試合 '+(i+1)+(r.state==='ok'?' · 登録済み':r.state==='error'?' · 登録失敗':'')));
      const time=field(card,'開始時刻','time',r.time,v=>{r.time=v;syncText();markDirty()});
      const title=field(card,'タイトル','textarea',r.title,v=>{r.title=v;syncText();markDirty()});title.maxLength=100;
      const details=make('details'),summary=make('summary',Object.keys(r.overrides).length||r.thumbMode!=='inherit'?'個別設定あり':'個別設定');details.append(summary);
      const box=make('div');
      const updateLabel=()=>{summary.textContent=Object.keys(r.overrides).length||r.thumbMode!=='inherit'?'個別設定あり':'個別設定';markDirty()};
      field(box,'予約日（この試合）','date',r.overrides.date??$('date').value,v=>{r.overrides.date=v;updateLabel()});
      select(box,'公開設定（この試合）',r.overrides.privacy??$('privacy').value,PRIV,v=>{r.overrides.privacy=v;updateLabel()});
      field(box,'説明文（この試合）','textarea',r.overrides.description??$('description').value,v=>{r.overrides.description=v;updateLabel()});
      const fileWrap=make('div');fileWrap.hidden=r.thumbMode!=='custom';const imageStatus=make('p',r.thumb?'画像を選択済み':'画像を選択してください。',r.thumb?'muted':'error');
      const file=field(fileWrap,'個別サムネイル','file','',()=>{});file.accept='image/*';file.onchange=async()=>{if(!file.files[0])return;setBusy(true);try{r.thumb=await fileToThumb(file.files[0]);imageStatus.textContent='画像を選択済み';imageStatus.className='muted';markDirty()}catch(e){imageStatus.textContent=e.message;imageStatus.className='error'}finally{setBusy(false)}};fileWrap.append(imageStatus);preview(fileWrap,r.thumb,'個別サムネイル');
      select(box,'サムネイル',r.thumbMode,{inherit:'共通設定を使用',custom:'この試合だけ指定',none:'使用しない'},v=>{r.thumbMode=v;fileWrap.hidden=v!=='custom';updateLabel()});box.append(fileWrap);
      const reset=make('button','共通設定に戻す','quiet');reset.onclick=async()=>{if(!await confirmAction('共通設定に戻しますか？','この試合の個別設定を解除します。','戻す'))return;r.overrides={};r.thumbMode='inherit';r.thumb=null;markDirty();renderReview()};box.append(reset);details.append(box);card.append(details);
      if(r.error)card.append(make('p',r.error,'error'));if(r.thumbnailError)card.append(make('p','サムネイル：'+r.thumbnailError,'error'));
      if(r.url){const a=make('a','YouTubeで開く ↗');a.href=r.url;a.target='_blank';a.rel='noopener noreferrer';card.append(a)}
      if(r.state!=='pending'){[...card.querySelectorAll('input,textarea,select,button')].forEach(n=>n.disabled=!(r.state==='error'&&n.type==='file'))}
      if(r.state==='pending'){const remove=make('button','一覧から削除','quiet');remove.onclick=async()=>{if(!await confirmAction('試合を一覧から削除しますか？',r.title,'削除'))return;rows=rows.filter(x=>x!==r);syncText();markDirty();showStep(rows.length?3:1)};card.append(remove)}
      $('matches').append(card);
    });
  }
  $('next').onclick=async()=>{
    if(busy)return;
    try{
      if(step===1){if($('schedule').value!==parsedText||!rows.length){const next=parseSchedule($('schedule').value);if(rows.length&&!await confirmAction('試合一覧を更新しますか？','試合ごとの設定を解除し、入力内容から一覧を作り直します。','更新'))return;rows=next;parsedText=$('schedule').value;markDirty()}message('inputError','');showStep(2)}
      else if(step===2){if(!$('date').value)throw Error('予約日を選択してください。');message('settingsError','');showStep(3)}
      else await submit(rows.filter(r=>r.state!=='ok'));
    }catch(e){message(step===1?'inputError':step===2?'settingsError':'progress',e.message,true)}
  };
  $('back').onclick=()=>{if(!busy)showStep(step-1)};
  $('returnReview').onclick=()=>showStep(3);
  $('goManage').onclick=async()=>{await showView('manage');if(channel.length)await refreshManage()};
  function batchConfirmation(targets) {
    const box=make('div');box.append(make('p',targets.length+'件をYouTubeに予約します。'));
    targets.forEach(r=>{const p=effective(r),item=make('div',undefined,'confirm-row');item.append(make('div',p.date+' '+p.time+' JST · '+PRIV[p.privacy]),make('strong',p.title),make('div',p.description?'説明文：'+p.description:'説明文なし'),make('div',p.thumbnail?'サムネイルあり':'サムネイルなし'));preview(item,p.thumbnail,'予約するサムネイル');box.append(item)});return box;
  }
  async function submit(targets) {
    if(busy)return;if(!targets.length)throw Error('登録する試合がありません。');if(!client.state().connected)throw Error('画面上部の「Googleに接続」から接続してください。');
    for(const [i,r] of targets.entries()){try{validInput(effective(r));if(r.thumbMode==='custom'&&!r.thumb)throw Error('個別サムネイルを再選択してください。')}catch(e){throw Error('試合 '+(rows.indexOf(r)+1)+'：'+e.message)}}
    if(!await confirmAction('予約登録の最終確認',batchConfirmation(targets),'YouTubeに登録'))return;
    const inputs=targets.map(effective);setBusy(true);$('results').replaceChildren();let success=0;
    try{for(let i=0;i<targets.length;i++){
      const r=targets[i];message('progress','登録中 '+(i+1)+'/'+targets.length+'件：'+r.title);
      try{const result=await client.call('createBatchRow',inputs[i]);r.state='ok';r.overrides={date:inputs[i].date,privacy:inputs[i].privacy,description:inputs[i].description};r.url=result.url;r.thumbnailError=result.thumbnailError||'';r.error='';success++;
        const item=make('div','✓ '+r.title+(r.thumbnailError?' · 予約成功／サムネイル失敗：'+r.thumbnailError:' · 登録成功'),'card');const a=make('a','YouTubeで開く ↗');a.href=r.url;a.target='_blank';a.rel='noopener noreferrer';item.append(make('br'),a);$('results').append(item);
      }catch(e){r.state='error';r.error=e.message;$('results').append(make('div','× '+r.title+'：'+e.message,'card error'))}
    }}finally{setBusy(false);markDirty();message('progress','');$('completeTitle').textContent='成功 '+success+'件 / 失敗 '+(targets.length-success)+'件';$('retryFailed').hidden=!rows.some(r=>r.state==='error');showStep(4);await refreshRecovery()}
  }
  $('retryFailed').onclick=()=>submit(rows.filter(r=>r.state==='error')).catch(e=>{$('results').prepend(make('p',e.message,'error'))});
  const newBatch=make('button','新しい予約を作る','full');$('completeStep').append(newBatch);newBatch.onclick=async()=>{if(busy||!await confirmAction('新しい予約を作りますか？','現在の試合一覧を空にします。YouTubeの予約・保存済み下書きは削除しません。','新しく作る'))return;rows=[];parsedText='';$('schedule').value='';markDirty();showStep(1)};
  const category=b=>['created','ready','testStarting','testing'].includes(b.lifeCycle)?'scheduled':['liveStarting','live'].includes(b.lifeCycle)?'live':'complete';
  const editable=b=>['created','ready'].includes(b.lifeCycle);
  const lifeLabel=b=>({scheduled:'予約済み',live:'配信中',complete:'終了済み'})[category(b)];
  function parts(iso){if(!iso)return{date:'',time:''};const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso));const o=Object.fromEntries(p.map(x=>[x.type,x.value]));return{date:o.year+'-'+o.month+'-'+o.day,time:o.hour+':'+o.minute}}
  function filtered(){return channel.filter(b=>($('statusFilter').value==='all'||category(b)===$('statusFilter').value)&&b.title.toLocaleLowerCase().includes($('filter').value.toLocaleLowerCase())).sort((a,b)=>String(a.scheduledStartTime).localeCompare(String(b.scheduledStartTime))*($('manageSort').value==='asc'?1:-1))}
  function updateBulk(){ $('bulkCount').textContent=selected.size+'件選択';$('bulkDelete').textContent='選択した'+selected.size+'件を削除';$('bulkDelete').disabled=busy||!selected.size;$('clearSelection').disabled=busy||!selected.size; }
  async function refreshManage(){if(busy||!await leaveEditor())return;setBusy(true);message('manageStatus','YouTubeから取得中…');try{const res=await client.call('listMyBroadcasts');channel=res.items||[];selected.clear();expanded=null;renderManage();message('manageStatus',channel.length+'件取得'+(res.hasMore?'（上限500件。古い予約が表示されない場合があります）':''))}catch(e){message('manageStatus','取得失敗：'+e.message,true)}finally{setBusy(false)}}
  $('refresh').onclick=refreshManage;
  const filterState={statusFilter:'scheduled',manageSort:'asc',filter:''};
  for(const id of Object.keys(filterState))$(id).addEventListener(id==='filter'?'input':'change',async()=>{if(busy)return;if(!await leaveEditor()){$(id).value=filterState[id];return}filterState[id]=$(id).value;selected.clear();expanded=null;renderManage()});
  $('clearSelection').onclick=()=>{selected.clear();$('broadcasts').querySelectorAll('input[type=checkbox]').forEach(n=>n.checked=false);updateBulk()};
  function renderManage(){
    $('broadcasts').replaceChildren();const list=filtered();
    for(const b of list){const card=make('article',undefined,'card'),head=make('div',undefined,'booking-head');card.dataset.id=b.id;
      const label=make('label'),cb=make('input');cb.type='checkbox';cb.checked=selected.has(b.id);cb.disabled=!editable(b);cb.setAttribute('aria-label',b.title+'を選択');cb.onchange=()=>{cb.checked?selected.add(b.id):selected.delete(b.id);updateBulk()};label.append(cb);
      const toggle=make('button',undefined,'booking-toggle'),d=parts(b.scheduledStartTime);toggle.append(make('span',b.title),make('span',d.date+' '+d.time+' JST · '+PRIV[b.privacy]+' · '+lifeLabel(b),'muted'));toggle.setAttribute('aria-expanded',String(expanded===b.id));toggle.disabled=false;
      toggle.onclick=async()=>{if(busy||!await leaveEditor())return;expanded=expanded===b.id?null:b.id;renderManage()};head.append(label,toggle);card.append(head);
      if(expanded===b.id){const box=make('div',undefined,'edit');if(editor===b.id)buildEditor(box,b);else{
        box.append(make('p',b.description||'説明文なし','muted'));const link=make('a','YouTubeで開く ↗');link.href=b.url;link.target='_blank';link.rel='noopener noreferrer';box.append(link);
        if(editable(b)){const actions=make('div',undefined,'actions'),edit=make('button','編集'),del=make('button','削除','danger');edit.onclick=()=>{if(busy)return;editor=b.id;renderManage()};del.onclick=()=>deleteMany([b]);actions.append(edit,del);box.append(actions)}
        else box.append(make('p','編集・削除は配信前の待機中の予約で行えます。','muted'));
      }card.append(box)}$('broadcasts').append(card);
    }
    if(!list.length)$('broadcasts').append(make('p',client.state().connected?'条件に一致する予約はありません。':'Googleに接続して「更新」を押してください。','muted'));
    updateBulk();if(editor)editInitial=JSON.stringify(readEditor());
  }
  function buildEditor(box,b){
    const d=parts(b.scheduledStartTime);field(box,'タイトル','textarea',b.title,()=>{},'editTitle').maxLength=100;
    const pair=make('div',undefined,'pair'),a=make('div'),c=make('div');field(a,'予約日','date',d.date,()=>{},'editDate');field(c,'開始時刻','time',d.time,()=>{},'editTime');pair.append(a,c);box.append(pair);
    select(box,'公開設定',b.privacy,PRIV,()=>{},'editPrivacy');field(box,'説明文','textarea',b.description,()=>{},'editDescription').maxLength=4900;
    const thumb=field(box,'サムネイル差し替え（任意）','file','',()=>{},'editThumb');thumb.accept='image/*';
    const status=make('p',undefined,'error');status.setAttribute('role','status');box.append(status);
    const actions=make('div',undefined,'actions'),save=make('button','変更を保存','primary'),cancel=make('button','キャンセル'),del=make('button','削除','danger');
    save.onclick=async()=>{
      if(busy)return;const data=readEditor();delete data.image;data.id=b.id;
      try{validInput(data)}catch(e){status.textContent=e.message;return}
      const file=thumb.files[0];setBusy(true);status.textContent='保存中…';let changed=false;
      try{const image=file?await fileToThumb(file):null;const result=await client.call('updateBroadcast',data);Object.assign(b,result);changed=true;if(image)await client.call('replaceBroadcastThumbnail',{id:b.id,thumbnail:image});editor=null;renderManage();message('manageStatus','変更を保存しました。')}
      catch(e){status.textContent=(changed?'テキスト設定は保存済みです。サムネイルの更新に失敗しました：':'保存に失敗しました。YouTube上で更新されている場合があります：')+e.message}
      finally{setBusy(false)}
    };
    cancel.onclick=async()=>{if(!busy&&await leaveEditor())renderManage()};del.onclick=()=>deleteMany([b]);actions.append(save,cancel,del);box.append(actions);
    // The snapshot is captured after renderManage attaches the editor.
  }
  async function deleteMany(targets){
    if(busy)return;targets=targets.filter(b=>editable(b));if(!targets.length)return;
    const content=make('div');content.append(make('p',targets.length+'件のYouTube予約を削除します。元に戻せません。'));
    targets.forEach(b=>{const d=parts(b.scheduledStartTime);content.append(make('div',d.date+' '+d.time+' · '+b.title,'confirm-row'))});
    if(!await confirmAction('予約を削除',content,'削除'))return;
    if(!await leaveEditor())return;
    setBusy(true);let success=0;const failures=[];
    try{for(let i=0;i<targets.length;i++){const b=targets[i];message('manageStatus','削除中 '+(i+1)+'/'+targets.length+'件');try{await client.call('deleteBroadcast',b.id);channel=channel.filter(x=>x.id!==b.id);selected.delete(b.id);if(expanded===b.id)expanded=null;success++}catch(e){failures.push(b.title+'：'+e.message)}}}
    finally{setBusy(false);renderManage();message('manageStatus','削除成功 '+success+'件 / 失敗 '+failures.length+'件'+(failures.length?'\n'+failures.join('\n'):''),!!failures.length)}
  }
  $('bulkDelete').onclick=()=>deleteMany(channel.filter(b=>selected.has(b.id)));
  function draft(){return{v:6,date:$('date').value,event:'',team:'',pattern:'',description:$('description').value,privacy:$('privacy').value,interval:'30',sort:'manual',inputText:$('schedule').value,rows:rows.map((r,i)=>({...r,thumb:null,order:i,round:'',format:'',opponent:''}))}}
  function savedClean(){dirty=false;message('draftStatus','下書きを保存しました。画像は保存されません。')}
  $('saveDraft').onclick=()=>{if(busy)return;try{localStorage.setItem(DRAFT,JSON.stringify(draft()));savedClean()}catch(e){message('draftStatus','保存失敗：'+e.message,true)}};
  async function applyDraft(d){
    if(!d||d.v!==6||!Array.isArray(d.rows)||d.rows.length>50)throw Error('下書きの形式が不正です。');
    if(d.rows.some(r=>typeof r.title!=='string'||typeof r.time!=='string'||typeof r.id!=='string'||!['pending','ok','error'].includes(r.state)))throw Error('下書きの試合データが不正です。');
    if(dirty&&!await confirmAction('下書きを読み込みますか？','現在入力中の内容を置き換えます。','読み込む'))return;
    rows=d.rows.map(r=>({...r,overrides:r.overrides||{},thumb:null,thumbMode:['custom','none'].includes(r.thumbMode)?r.thumbMode:'inherit'}));
    $('date').value=d.date||'';$('privacy').value=d.privacy||'public';$('description').value=d.description||'';commonThumb=null;$('commonThumb').value='';$('commonPreview').hidden=true;
    syncText();const canonical=parsedText;if(typeof d.inputText==='string'){$('schedule').value=d.inputText;if(rows.some(r=>r.state!=='pending'))parsedText=d.inputText;}
    dirty=false;showStep(rows.length&&($('schedule').value===canonical||rows.some(r=>r.state!=='pending'))?3:1);await showView('create');message('draftStatus','下書きを読み込みました。サムネイル画像は再選択してください。');
  }
  $('loadDraft').onclick=async()=>{if(busy)return;try{const d=JSON.parse(localStorage.getItem(DRAFT)||'null');if(!d)throw Error('保存済み下書きがありません。');await applyDraft(d)}catch(e){message('draftStatus',e.message,true)}};
  async function refreshRecovery(){
    if(recoveryLoading||busy||!client.state().connected)return;recoveryLoading=true;
    try{const records=await client.call('getUncertainRecords');$('recoveryPanel').hidden=!records.length;const signature=JSON.stringify(records);if(signature===recoverySignature)return;recoverySignature=signature;$('uncertainList').replaceChildren();
      for(const r of records){const card=make('div',undefined,'card'),d=parts(r.scheduledStartTime);card.append(make('h3',r.title),make('p',d.date+' '+d.time));const input=field(card,'作成された動画のURLまたはID','text','',()=>{});input.autocapitalize='none';input.spellcheck=false;const attach=make('button','作成済みの予約と照合','full'),absent=make('button','未登録を確認して再試行を許可','full');const status=make('p');status.setAttribute('role','status');card.append(attach,absent,status);
        async function act(fn){setBusy(true);try{await fn();recoverySignature='';status.textContent='確認しました。元の予約結果から失敗分を再試行してください。'}catch(e){status.textContent=e.message}finally{setBusy(false);refreshRecovery()}}
        attach.onclick=()=>act(async()=>{let id=input.value.trim();if(id.startsWith('https://')){const u=new URL(id);if(['www.youtube.com','youtube.com','m.youtube.com'].includes(u.hostname)&&u.pathname==='/watch')id=u.searchParams.get('v');else if(u.hostname==='youtu.be')id=u.pathname.slice(1);else throw Error('YouTubeの動画URLを指定してください。')}await client.call('resolveUncertain',{requestId:r.requestId,id})});
        absent.onclick=async()=>{if(!await confirmAction('未登録を確認しましたか？','YouTube Studioの一覧を更新し、同じタイトル・開始日時の予約が存在しないことを確認してください。','未登録を確認した'))return;act(()=>client.call('clearUncertain',{requestId:r.requestId,confirmedAbsent:true}))};$('uncertainList').append(card);
      }
    }catch(e){message('connectionStatus',e.message,true)}finally{recoveryLoading=false}
  }
  $('insertExample').onclick=async()=>{if(busy||$('schedule').disabled)return;if($('schedule').value&&!await confirmAction('入力例に置き換えますか？','現在の入力内容を置き換えます。','置き換える'))return;$('schedule').value=$('exampleText').textContent.trim();markDirty()};
  $('exampleText').textContent='9:30\n予選①(2チーム×表裏) | 相手 vs SASHIMÖ | 第N回 SASHIMÖ杯\n\n10:00\n予選②(2チーム×表裏) | 相手 vs SASHIMÖ | 第N回 SASHIMÖ杯\n\n10:30\n予選③(2チーム×表裏) | 相手 vs SASHIMÖ | 第N回 SASHIMÖ杯\n\n11:05\n決勝T1回戦(2チーム×2先) | 相手 vs SASHIMÖ | 第N回 SASHIMÖ杯\n\n11:45\n決勝T準決勝(2チーム×2先) | 相手 vs SASHIMÖ | 第N回 SASHIMÖ杯\n\n12:45\n決勝T決勝(2チーム×2先) | 相手 vs SASHIMÖ | 第N回 SASHIMÖ杯';
  ['schedule','date','privacy','description'].forEach(id=>$(id).addEventListener('input',markDirty));
  window.addEventListener('beforeunload',e=>{if(dirty||editChanged()||busy){e.preventDefault();e.returnValue=''}});
  try{$('oauthClientId').value=localStorage.getItem(CLIENT_ID)||''}catch(e){message('connectionStatus','ブラウザの保存設定を確認してください。',true)}
  showStep(1);renderConnection(client.state());setInterval(()=>{renderConnection(client.state());if(!client.state().connected)$('recoveryPanel').hidden=true;else if(!client.state().active)refreshRecovery()},5000);
})();
