/* Browser-only YouTube adapter. Tokens stay in memory; never persist credentials. */
(function (root) {
  'use strict';
  const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
  const API = 'https://www.googleapis.com/youtube/v3/';
  const TEMPLATE_KEY = 'live_scheduler_pages_templates_v1';
  const RECORD_PREFIX = 'live_scheduler_pages_request_v1:';
  const DRAFT_KEY = 'live_scheduler_v06_draft';

  function createClient(options = {}) {
    const storage = options.storage || root.localStorage;
    const fetcher = options.fetch || root.fetch.bind(root);
    const locks = options.locks || root.navigator.locks;
    const now = options.now || Date.now;
    const notify = options.onState || (() => {});
    let session = null, active = 0, authorizing = false;
    function state() {
      return { connected: !!session && session.expiresAt > now() + 30000,
        channel: session?.channel || null, expiresAt: session?.expiresAt || 0,
        active, authorizing };
    }
    function changed() { notify(state()); }
    function context() {
      if (!state().connected) throw Error('画面上部の「Googleに接続」から再接続してください');
      return session;
    }
    function assertSession(ctx) {
      if (session !== ctx || ctx.expiresAt <= now() + 30000) {
        const e = Error('接続の有効期限が切れました。「Googleに接続」から再接続してください');
        e.unsent = true;
        throw e;
      }
    }
    function read(key, fallback) {
      const raw = storage.getItem(key);
      if (raw === null) return fallback;
      try { return JSON.parse(raw); } catch (_) { throw Error('保存データを読み取れません。設定・下書きを書き出し、保存状態を確認してください'); }
    }
    function write(key, value) {
      try { storage.setItem(key, JSON.stringify(value)); }
      catch (_) { throw Error('端末に保存できません。空き容量やブラウザの保存設定を確認してください'); }
    }
    async function request(ctx, path, { method = 'GET', body, media } = {}) {
      assertSession(ctx);
      const controller = new root.AbortController();
      const timer = root.setTimeout(() => controller.abort(), 30000);
      const headers = { Authorization: 'Bearer ' + ctx.token };
      if (body !== undefined) headers['Content-Type'] = media || 'application/json';
      let response;
      try {
        response = await fetcher(path.startsWith('https://www.googleapis.com/upload/') ? path : API + path, {
          method, headers, body: body === undefined ? undefined : media ? body : JSON.stringify(body),
          signal: controller.signal, credentials: 'omit', redirect: 'error'
        });
        const raw = await response.text();
        let data;
        try { data = raw ? JSON.parse(raw) : {}; }
        catch (_) { const e = Error('YouTubeの応答を読み取れません。予約一覧を確認してください'); e.uncertain = true; throw e; }
        if (!response.ok) {
          if (response.status === 401 && session === ctx) { session = null; changed(); }
          const e = Error(response.status === 401 ? 'Googleとの接続が切れました。再接続してください' :
            `YouTube API（HTTP ${response.status}）：${data.error?.message || '処理に失敗しました'}`);
          e.uncertain = response.status >= 500 || response.status === 408;
          throw e;
        }
        return data;
      } catch (e) {
        if (!response) {
          const error = Error('通信が完了しませんでした。作成操作の場合はYouTube Studioで登録結果を確認してください');
          error.uncertain = true;
          throw error;
        }
        if (e.uncertain === undefined) e.uncertain = true;
        throw e;
      } finally { root.clearTimeout(timer); }
    }
    // Must be invoked directly from a click, before any await, for iPhone popups.
    function connect(clientId) {
      if (active || authorizing) throw Error('処理が終わってから接続してください');
      if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId || '')) throw Error('Google連携設定に有効なクライアントIDを入力してください');
      if (!root.google?.accounts?.oauth2) throw Error('Google認証を読み込めていません。通信を確認してページを再読み込みしてください');
      session = null; authorizing = true; changed();
      return new Promise((resolve, reject) => {
        function fail(e) { session = null; authorizing = false; changed(); reject(e); }
        try {
          const client = root.google.accounts.oauth2.initTokenClient({
            client_id: clientId, scope: SCOPE, include_granted_scopes: false,
            callback: async response => {
              if (response.error || !response.access_token) return fail(Error('Googleへの接続が許可されませんでした'));
              if (!(response.scope || '').split(' ').includes(SCOPE)) return fail(Error('YouTubeの操作権限が必要です。再接続して許可してください'));
              const lifetime = Number(response.expires_in);
              if (!Number.isFinite(lifetime) || lifetime <= 60) return fail(Error('Googleから有効な接続情報を取得できませんでした'));
              const ctx = { token: response.access_token, expiresAt: now() + lifetime * 1000, channel: null };
              session = ctx;
              try {
                const data = await request(ctx, 'channels?part=id,snippet&mine=true');
                if (data.items?.length !== 1 || !data.items[0].id) throw Error('操作先チャンネルを1つに特定できませんでした。対象のYouTubeチャンネルで接続し直してください');
                ctx.channel = { id: data.items[0].id, title: data.items[0].snippet?.title || data.items[0].id };
                authorizing = false; changed(); resolve(state());
              } catch (e) { fail(e); }
            },
            error_callback: () => fail(Error('Googleの接続画面が閉じられたか、開けませんでした。接続ボタンから再試行してください'))
          });
          client.requestAccessToken({ prompt: 'select_account' });
        } catch (e) { fail(e); }
      });
    }
    function disconnect() {
      if (active || authorizing) throw Error('処理が終わってから接続を解除してください');
      session = null; changed();
    }
    function validate(input) {
      if (!input || typeof input !== 'object') throw Error('入力がありません');
      const title = String(input.title || '').trim(), description = String(input.description || '');
      if (!title || title.length > 100 || description.length > 4900) throw Error('タイトルは1〜100文字、説明文は4900文字以内にしてください');
      if (!['public', 'unlisted', 'private'].includes(input.privacy)) throw Error('公開設定が不正です');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time || '')) throw Error('日時が不正です');
      const start = new Date(`${input.date}T${input.time}:00+09:00`);
      if (!Number.isFinite(start.getTime()) || new Date(start.getTime() + 9*3600000).toISOString().slice(0,16) !== `${input.date}T${input.time}`) throw Error('存在しない日時です');
      if (start.getTime() <= now()) throw Error('開始予定時刻は未来にしてください');
      return { snippet: { title, description, scheduledStartTime: start.toISOString() },
        status: { privacyStatus: input.privacy, selfDeclaredMadeForKids: false },
        contentDetails: { enableAutoStart: false, enableAutoStop: false, enableDvr: true } };
    }
    function videoId(id) {
      if (!/^[\w-]{11}$/.test(id || '')) throw Error('動画IDが不正です');
      return id;
    }
    function requestId(id) {
      if (!/^[A-Za-z0-9_-]{12,80}$/.test(id || '')) throw Error('リクエストIDが不正です');
      return id;
    }
    function format(b) {
      return { id: b.id, title: b.snippet?.title || '', description: b.snippet?.description || '',
        scheduledStartTime: b.snippet?.scheduledStartTime || '', scheduledEndTime: b.snippet?.scheduledEndTime || '',
        privacy: b.status?.privacyStatus || 'private', lifeCycle: b.status?.lifeCycleStatus || '',
        url: 'https://www.youtube.com/watch?v=' + videoId(b.id) };
    }
    async function get(ctx, id) {
      const data = await request(ctx, 'liveBroadcasts?part=id,snippet,status&id=' + videoId(id));
      const b = data.items?.[0];
      if (!b) throw Error('予約が見つかりません。YouTube Studioで確認してください');
      if (b.snippet?.channelId !== ctx.channel.id) throw Error('接続先チャンネルの予約ではありません');
      return b;
    }
    function waiting(b) {
      if (!['created', 'ready'].includes(b.status?.lifeCycleStatus)) throw Error('配信待機中の予約だけ変更・削除できます');
    }
    function thumbnailBytes(image) {
      if (!image || !['image/jpeg', 'image/png'].includes(image.mime) || typeof image.base64 !== 'string' ||
        image.base64.length > 2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) throw Error('サムネイルは2MB以下のJPEGまたはPNGを指定してください');
      let raw;
      try { raw = root.atob(image.base64); } catch (_) { throw Error('画像データが不正です'); }
      if (!raw.length || raw.length > 2*1024*1024) throw Error('サムネイルは2MB以下にしてください');
      return Uint8Array.from(raw, c => c.charCodeAt(0));
    }
    async function thumbnail(ctx, id, image) {
      return request(ctx, 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?uploadType=media&videoId=' + videoId(id),
        { method: 'POST', media: image.mime, body: thumbnailBytes(image) });
    }
    function key(ctx, id) { return RECORD_PREFIX + ctx.channel.id + ':' + requestId(id); }
    async function locked(ctx, work) {
      if (!locks?.request) throw Error('このブラウザでは二重登録防止を利用できません。最新のSafariまたはChromeで開いてください');
      return locks.request('live-scheduler-create:' + ctx.channel.id, { mode: 'exclusive' }, async () => { assertSession(ctx); return work(); });
    }
    function uncertainRecords(ctx) {
      const prefix = RECORD_PREFIX + ctx.channel.id + ':';
      const records = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k?.startsWith(prefix)) { const r = read(k, null); if (r?.state === 'pending') records.push(r); }
      }
      return records;
    }
    async function finishThumbnail(ctx, k, record, image) {
      if (image && record.result.thumbnailState !== 'ok') {
        try { await thumbnail(ctx, record.result.id, image); record.result.thumbnailState = 'ok'; record.result.thumbnailError = ''; }
        catch (e) { record.result.thumbnailState = 'error'; record.result.thumbnailError = e.message; }
        write(k, record);
      }
      return { ...record.result };
    }
    async function create(ctx, input) {
      const body = validate(input), fingerprint = JSON.stringify(body), k = key(ctx, input.requestId);
      if (input.thumbnail) thumbnailBytes(input.thumbnail);
      return locked(ctx, async () => {
        let record = read(k, null);
        if (record?.state === 'pending') throw Error('前回の登録結果が不明です。画面上部の「登録結果の確認」で確認してください');
        if (record?.state === 'deleted') throw Error('この試合の予約は削除済みです。作り直す場合は新しい試合を追加してください');
        if (record && record.fingerprint !== fingerprint) throw Error('この試合は既に登録されています。予約管理から編集してください');
        if (!record) {
          // Block further creates while any ambiguous write exists, including after reload.
          if (uncertainRecords(ctx).length) throw Error('登録結果が不明な予約があります。画面上部の「登録結果の確認」を先に行ってください');
          record = { state: 'pending', requestId: input.requestId, fingerprint, title: body.snippet.title,
            scheduledStartTime: body.snippet.scheduledStartTime, savedAt: new Date(now()).toISOString() };
          write(k, record); // Must succeed BEFORE issuing a non-idempotent POST.
          let b;
          try {
            b = await request(ctx, 'liveBroadcasts?part=snippet,status,contentDetails', { method: 'POST', body });
            if (!/^[\w-]{11}$/.test(b.id || '')) { const e = Error('予約IDを取得できませんでした。登録結果を確認してください'); e.uncertain = true; throw e; }
          } catch (e) {
            if (e.unsent || e.uncertain === false) storage.removeItem(k);
            throw e;
          }
          record.state = 'created';
          record.result = { id: b.id, title: b.snippet?.title || body.snippet.title,
            url: 'https://www.youtube.com/watch?v=' + b.id, thumbnailState: 'none' };
          write(k, record); // If storage fails after POST, pending record prevents a duplicate.
        }
        return finishThumbnail(ctx, k, record, input.thumbnail);
      });
    }
    function validateTemplate(t) {
      if (!t || typeof t !== 'object') throw Error('テンプレートの形式が不正です');
      const result = { id: String(t.id || root.crypto.randomUUID()), name: String(t.name || '').trim(),
        event: String(t.event || ''), team: String(t.team || ''), pattern: String(t.pattern || ''),
        description: String(t.description || ''), privacy: String(t.privacy || 'public'), interval: Number(t.interval || 30) };
      if (!result.name || result.name.length > 60 || result.id.length > 100 || result.event.length > 200 || result.team.length > 100 ||
        result.pattern.length > 300 || result.description.length > 4900 || !['public', 'unlisted', 'private'].includes(result.privacy) ||
        ![20,25,30,40,60].includes(result.interval)) throw Error('テンプレートの入力を確認してください');
      return result;
    }
    function templates() {
      const list = read(TEMPLATE_KEY, []);
      if (!Array.isArray(list)) throw Error('テンプレートの保存形式が不正です');
      return list.map(validateTemplate);
    }
    const localMethods = {
      getTemplates: templates,
      saveTemplate(input) {
        const t = validateTemplate(input), list = templates().filter(x => x.id !== t.id);
        if (list.length >= 10) throw Error('テンプレートは最大10件です');
        list.push(t); write(TEMPLATE_KEY, list); return list;
      },
      deleteTemplate(id) { const list = templates().filter(x => x.id !== id); write(TEMPLATE_KEY, list); return list; }
    };
    const methods = {
      createBatchRow: create,
      async retryThumbnail(ctx, input) {
        const k = key(ctx, input.requestId);
        return locked(ctx, async () => {
          const record = read(k, null);
          if (record?.state !== 'created') throw Error('作成済みの予約記録がありません');
          return finishThumbnail(ctx, k, record, input.thumbnail);
        });
      },
      async listMyBroadcasts(ctx) {
        const items = []; let pageToken = '';
        for (let i = 0; i < 10; i++) {
          const page = await request(ctx, 'liveBroadcasts?part=id,snippet,status&mine=true&broadcastType=all&maxResults=50' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
          items.push(...(page.items || []).map(format));
          pageToken = page.nextPageToken || ''; if (!pageToken) break;
        }
        return { items, hasMore: !!pageToken };
      },
      async updateBroadcast(ctx, input) {
        const body = validate(input), b = await get(ctx, input.id); waiting(b);
        const snippet = { ...body.snippet };
        if (b.snippet.scheduledEndTime) snippet.scheduledEndTime = b.snippet.scheduledEndTime;
        if (b.snippet.categoryId) snippet.categoryId = b.snippet.categoryId;
        const status = { privacyStatus: input.privacy, selfDeclaredMadeForKids: !!b.status.selfDeclaredMadeForKids };
        return format(await request(ctx, 'liveBroadcasts?part=snippet,status', { method: 'PUT', body: { id: b.id, snippet, status } }));
      },
      async deleteBroadcast(ctx, id) {
        const b = await get(ctx, id); waiting(b);
        await request(ctx, 'liveBroadcasts?id=' + videoId(id), { method: 'DELETE' });
        // Tombstones prevent old saved drafts from recreating explicitly deleted entries.
        const keys = [];
        for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k?.startsWith(RECORD_PREFIX + ctx.channel.id + ':')) keys.push(k); }
        keys.forEach(k => { const r = read(k, null); if (r?.result?.id === id) write(k, { ...r, state: 'deleted' }); });
        return { deleted: true, id };
      },
      async replaceBroadcastThumbnail(ctx, input) { const b = await get(ctx, input.id); waiting(b); await thumbnail(ctx, b.id, input.thumbnail); return { ok: true }; },
      getUncertainRecords: ctx => uncertainRecords(ctx),
      async resolveUncertain(ctx, input) {
        return locked(ctx, async () => {
          const k = key(ctx, input.requestId), r = read(k, null);
          if (r?.state !== 'pending') throw Error('確認待ちの記録がありません');
          const b = await get(ctx, input.id);
          if (b.snippet.title !== r.title || b.snippet.scheduledStartTime !== r.scheduledStartTime) throw Error('タイトル・開始時刻が一致しません。対象の予約を確認してください');
          r.state = 'created'; r.result = { ...format(b), thumbnailState: 'none' }; write(k, r); return r.result;
        });
      },
      async clearUncertain(ctx, input) {
        if (input.confirmedAbsent !== true) throw Error('YouTube Studioで未登録を確認してください');
        return locked(ctx, async () => { const k = key(ctx, input.requestId); if (read(k, null)?.state !== 'pending') throw Error('確認待ちの記録がありません'); storage.removeItem(k); return { cleared: true }; });
      }
    };
    async function call(method, input) {
      if (Object.hasOwn(localMethods, method)) return localMethods[method](input);
      if (!Object.hasOwn(methods, method)) throw Error('未対応の操作です');
      const ctx = context();
      if (!ctx.channel) throw Error('チャンネルを確認中です');
      active++; changed();
      try { return await methods[method](ctx, input); }
      finally { active--; changed(); }
    }
    function importBackup(data) {
      if (active || authorizing) throw Error('処理が終わってから読み込んでください');
      if (data?.format !== 'live-scheduler-backup' || data.version !== 1 || !Array.isArray(data.templates) || data.templates.length > 10) throw Error('Live Schedulerの書き出しファイルを指定してください');
      const list = data.templates.map(validateTemplate), d = data.draft;
      if (new Set(list.map(t => t.id)).size !== list.length) throw Error('テンプレートIDが重複しています');
      if (!d || d.v !== 6 || !Array.isArray(d.rows) || d.rows.length > 50) throw Error('下書きの形式が不正です');
      const textLimits = { date: 10, event: 200, team: 100, pattern: 300, description: 4900 };
      const clean = { v:6 };
      if (d.inputText !== undefined) {
        if (typeof d.inputText !== 'string' || d.inputText.length > 100000) throw Error('貼り付けテキストが不正です');
        clean.inputText = d.inputText;
      }
      for (const [k, max] of Object.entries(textLimits)) { if (typeof d[k] !== 'string' || d[k].length > max) throw Error('下書きの入力形式が不正です'); clean[k] = d[k]; }
      if (clean.date && !/^\d{4}-\d{2}-\d{2}$/.test(clean.date)) throw Error('予約日の形式が不正です');
      if (!['public','unlisted','private'].includes(d.privacy) || ![20,25,30,40,60].includes(Number(d.interval)) || !['time','manual'].includes(d.sort)) throw Error('下書きの設定が不正です');
      Object.assign(clean, { privacy:d.privacy, interval:String(d.interval), sort:d.sort });
      clean.rows = d.rows.map((r, i) => {
        requestId(r.id);
        if (!['pending','ok'].includes(r.state)) throw Error('登録失敗の試合があります。移行元のYouTube Studioで登録結果を確認し、解決してから書き出してください');
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time || '')) throw Error('下書きの時刻が不正です');
        const row = { id:r.id, time:r.time, order:i, state:r.state, thumb:null, thumbMode:['inherit','custom'].includes(r.thumbMode) ? r.thumbMode : 'none', expanded:false, edited:!!r.edited, thumbnailState:'none', thumbnailError:'', error:'', url:'', overrides:{} };
        if (r.overrides !== undefined) {
          if (!r.overrides || typeof r.overrides !== 'object' || Array.isArray(r.overrides)) throw Error('個別設定が不正です');
          for (const [k,max] of Object.entries({date:10,privacy:10,description:4900})) {
            if (r.overrides[k] !== undefined) {
              if (typeof r.overrides[k] !== 'string' || r.overrides[k].length > max) throw Error('個別設定が不正です');
              row.overrides[k] = r.overrides[k];
            }
          }
          if (row.overrides.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(row.overrides.date)) throw Error('個別設定の予約日が不正です');
          if (row.overrides.privacy !== undefined && !['public','unlisted','private'].includes(row.overrides.privacy)) throw Error('個別設定の公開設定が不正です');
        }
        for (const k of ['title','round','format','opponent']) { if (typeof r[k] !== 'string' || r[k].length > 300) throw Error('試合の入力形式が不正です'); row[k] = r[k]; }
        if (r.state === 'ok') {
          let u; try { u = new URL(r.url); } catch (_) { throw Error('登録済み動画のURLが不正です'); }
          if (u.origin !== 'https://www.youtube.com' || u.pathname !== '/watch') throw Error('動画URLが不正です');
          row.url = 'https://www.youtube.com/watch?v=' + videoId(u.searchParams.get('v'));
        }
        return row;
      });
      if (new Set(clean.rows.map(r => r.id)).size !== clean.rows.length) throw Error('試合IDが重複しています');
      const previousTemplates = storage.getItem(TEMPLATE_KEY), previousDraft = storage.getItem(DRAFT_KEY);
      try { write(TEMPLATE_KEY, list); write(DRAFT_KEY, clean); }
      catch (e) {
        try { previousTemplates === null ? storage.removeItem(TEMPLATE_KEY) : storage.setItem(TEMPLATE_KEY, previousTemplates); previousDraft === null ? storage.removeItem(DRAFT_KEY) : storage.setItem(DRAFT_KEY, previousDraft); }
        catch (_) { throw Error('保存に失敗しました。以前の保存内容も確認してください'); }
        throw e;
      }
      return { templateCount:list.length, rowCount:clean.rows.length };
    }
    function assertExportable(data) {
      const pendingIds = new Set(data.draft.rows.filter(r => r.state !== 'ok').map(r => r.id));
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k?.startsWith(RECORD_PREFIX)) continue;
        const r = read(k, null);
        if (pendingIds.has(r?.requestId)) throw Error('未登録扱いの試合に作成記録があります。登録結果を確認し、試合一覧の再試行で状態を取り込んでから書き出してください');
      }
    }
    return { connect, disconnect, state, call, importBackup, assertExportable };
  }
  root.LiveSchedulerPages = { createClient };
})(globalThis);
