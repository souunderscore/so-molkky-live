/* Connection and migration controls for the Pages build only. */
(function () {
  'use strict';
  const clientIdKey = 'live_scheduler_pages_client_id';
  const section = make('section', 'panel'); section.setAttribute('aria-label', 'Google接続');
  // Static markup only. User/channel/API content is always assigned with textContent.
  section.innerHTML = `<div class="panel-title"><h2>Google接続</h2></div>
    <div id="connectionStatus" class="statusline" role="status" aria-live="polite"></div>
    <div class="actions"><button id="connectGoogle" class="primary">Googleに接続</button><button id="disconnectGoogle" disabled>接続を解除</button></div>
    <details id="connectionSettings" style="margin-top:12px"><summary>Google連携設定</summary>
      <div class="field" style="margin-top:10px"><label for="oauthClientId">クライアントID</label><input id="oauthClientId" type="text" autocomplete="off" spellcheck="false" autocapitalize="none"></div>
      <div class="hint">初回のみGoogle Cloudで発行したWeb用クライアントIDを設定します。このブラウザに保存します。</div>
      <a href="https://github.com/souunderscore/so-molkky-live/blob/main/docs/pages-migration.md" target="_blank" rel="noopener noreferrer">設定手順を開く ↗</a>
    </details><details id="recoveryPanel" class="hide" style="margin-top:12px"><summary>登録結果の確認</summary><div class="hint">通信が途切れた予約があります。YouTube Studioで登録結果を確認してください。</div><a href="https://studio.youtube.com/" target="_blank" rel="noopener noreferrer">YouTube Studioを開く ↗</a><div id="uncertainList" class="stack" style="margin-top:12px"></div></details>`;
  document.querySelector('nav.tabs').before(section);
  let lastChannel = null, lastRecovery = '', recoveryLoading = false, message = '';
  const working = () => busy || manageBusy || !$('modalLayer').classList.contains('hide');
  function clearChannelView() {
    channel = []; selected.clear(); expandedBroadcast = null; editId = null; editingSnapshot = null;
    $('broadcasts').replaceChildren(); $('manageStatus').textContent = ''; updateBulk();
  }
  function render(s) {
    const current = s.connected ? s.channel?.id : null;
    if (current !== lastChannel) { clearChannelView(); lastChannel = current; lastRecovery = ''; }
    const blocked = working() || !!s.active || s.authorizing;
    $('connectGoogle').disabled = blocked;
    $('disconnectGoogle').disabled = blocked || !s.connected;
    $('oauthClientId').disabled = blocked || s.connected;
    $('connectionStatus').textContent = message || (s.authorizing ? 'Googleに接続中…' :
      s.connected && s.channel ? `接続先：${s.channel.title}\nチャンネルID：${s.channel.id}` : '未接続です。YouTubeの予約操作にはGoogleへの接続が必要です。');
    $('connectionStatus').className = 'statusline' + (message ? ' error' : s.connected ? ' success' : '');
    if (s.connected && s.channel && !s.active && !recoveryLoading) refreshRecovery();
    if (!s.connected) { $('recoveryPanel').classList.add('hide'); $('uncertainList').replaceChildren(); }
  }
  const client = LiveSchedulerPages.createClient({ onState:render });
  window.liveSchedulerPages = client;
  try { $('oauthClientId').value = localStorage.getItem(clientIdKey) || ''; }
  catch (_) { message = 'ブラウザの保存設定を確認してください'; }
  if (!$('oauthClientId').value) $('connectionSettings').open = true;
  $('connectGoogle').onclick = () => {
    if (working()) return;
    try {
      const id = $('oauthClientId').value.trim();
      if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(id)) throw Error('Google連携設定に有効なクライアントIDを入力してください');
      localStorage.setItem(clientIdKey, id);
      message = '';
      // Call synchronously from the click to preserve popup permission on iOS.
      client.connect(id).then(() => { $('connectionSettings').open = false; render(client.state()); })
        .catch(e => { message = e.message; render(client.state()); });
    } catch (e) { message = e.message; render(client.state()); }
  };
  $('disconnectGoogle').onclick = () => {
    if (working()) return;
    if (editingSnapshot && isEditingChanged() && !confirm('未保存の予約編集を破棄して接続を解除しますか？')) return;
    try { message = ''; client.disconnect(); } catch (e) { message = e.message; render(client.state()); }
  };
  async function refreshRecovery() {
    recoveryLoading = true;
    try {
      const records = await client.call('getUncertainRecords');
      const signature = JSON.stringify(records);
      $('recoveryPanel').classList.toggle('hide', !records.length);
      if (signature === lastRecovery) return;
      lastRecovery = signature;
      $('uncertainList').replaceChildren();
      for (const record of records) {
        const card = make('div', 'result stack'), time = localParts(record.scheduledStartTime);
        card.append(make('strong', null, record.title), make('div', 'muted', time.date + ' ' + time.time + ' JST'));
        const fieldWrap = field('作成された動画のURLまたはID', '', () => {}), input = fieldWrap.querySelector('input');
        input.autocapitalize = 'none'; input.spellcheck = false; card.append(fieldWrap);
        const status = make('div', 'statusline'), attach = make('button', 'small', '作成済みの予約と照合'), absent = make('button', 'small danger', '未登録を確認して再試行を許可');
        async function action(fn) {
          attach.disabled = absent.disabled = true;
          try { await fn(); lastRecovery = ''; await refreshRecovery(); status.textContent = '確認を保存しました。元の試合一覧から再試行できます。'; }
          catch (e) { status.textContent = e.message; }
          finally { attach.disabled = absent.disabled = false; }
        }
        attach.onclick = () => action(async () => {
          let id = input.value.trim();
          if (id.startsWith('https://')) {
            const u = new URL(id);
            if (['www.youtube.com','youtube.com','m.youtube.com'].includes(u.hostname) && u.pathname === '/watch') id = u.searchParams.get('v');
            else if (u.hostname === 'youtu.be') id = u.pathname.slice(1);
            else throw Error('YouTubeの動画URLを指定してください');
          }
          await client.call('resolveUncertain', { requestId:record.requestId, id });
        });
        absent.onclick = () => action(async () => {
          if (!await modalConfirm('未登録を確認しましたか？', make('p', null, 'YouTube Studioの予約一覧を更新し、同じタイトル・開始日時の予約が存在しないことを確認した場合だけ解除してください。既に作成済みの場合は二重登録になります。'), '未登録を確認したので解除')) return;
          await client.call('clearUncertain', { requestId:record.requestId, confirmedAbsent:true });
        });
        card.append(attach, absent, status); $('uncertainList').append(card);
      }
    } catch (e) { $('connectionStatus').textContent = e.message; }
    finally { recoveryLoading = false; }
  }
  // The GAS build exports the same format; credentials and images are excluded.
  const backupPanel = $('exportBackup').closest('section');
  backupPanel.append(make('div', 'divider'));
  const importWrap = make('div', 'field'), label = make('label', null, '設定・下書きの書き出しファイルを選択'), input = make('input');
  input.type = 'file'; input.accept = '.json,application/json'; input.id = 'importBackupFile'; label.htmlFor = input.id; importWrap.append(label,input);
  const importButton = make('button', 'full', '設定・下書きを読み込む'); importButton.id = 'importBackup';
  const importStatus = make('div', 'statusline'); importStatus.id = 'importBackupStatus';
  backupPanel.append(importWrap, importButton, make('div', 'hint', '保存済み下書き・テンプレートを置き換えます。画像は再選択してください。読み込み後、「保存済み下書きを読み込む」で編集を再開できます。'), importStatus);
  importButton.onclick = async () => {
    if (busy || manageBusy || client.state().active) return;
    try {
      const file = input.files[0]; if (!file) throw Error('書き出しファイルを選択してください');
      if (file.size > 1024*1024) throw Error('ファイルが大きすぎます');
      const data = JSON.parse(await file.text());
      const content = make('p', null, `保存済み下書き・テンプレートを置き換えます（試合 ${data.draft?.rows?.length ?? '?'}件、テンプレート ${data.templates?.length ?? '?'}件）。現在画面にある入力は変えません。`);
      if (!await modalConfirm('設定・下書きを読み込みますか？', content, '読み込む')) return;
      const result = client.importBackup(data);
      importStatus.textContent = `試合 ${result.rowCount}件、テンプレート ${result.templateCount}件を保存しました。「保存済み下書きを読み込む」で開けます。`;
      await loadTemplates();
    } catch (e) { importStatus.textContent = '読み込み失敗：' + e.message; }
  };
  const templateHint = $('saveTemplate').nextElementSibling;
  templateHint.textContent += ' このブラウザだけに保存します。端末間の移動には書き出しファイルを使ってください。';
  const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
  script.onerror = () => { message = 'Google認証を読み込めませんでした。通信を確認してページを再読み込みしてください'; render(client.state()); };
  document.head.append(script);
  render(client.state());
  setInterval(() => render(client.state()), 1000);
})();
