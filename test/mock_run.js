// Code.gs を GAS のスタブ上で動かして、仕分け→保存→通知の流れを確かめる。
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const ME = 'UME';
// 土日の扱いで結果が変わらないよう、時刻を水曜 12:00 (JST) に固定する
const FIXED = Date.parse('2026-11-11T03:00:00Z');
const nowSec = Math.floor(FIXED / 1000);
const ts = (hoursAgo, n) => `${nowSec - hoursAgo * 3600}.00000${n}`;
const T = { ask: ts(5, 1), promiseRoot: ts(6, 2), promise: ts(4, 3), doneRoot: ts(8, 4), done: ts(7, 5), dm: ts(1, 6), waitRoot: ts(31, 7), wait: ts(30, 8), freshRoot: ts(2, 9), fresh: ts(1, 1), group: ts(2, 2), more: ts(0.5, 3) };

const threads = {
  [`C1:${T.ask}`]: [{ user: 'UA', text: `<@${ME}> これ見てもらえますか`, ts: T.ask }],
  [`C1:${T.promiseRoot}`]: [
    { user: 'UB', text: `<@${ME}> 設定直せますか`, ts: T.promiseRoot, reply_count: 1 },
    { user: ME, text: '確認します', ts: T.promise },
  ],
  [`C2:${T.doneRoot}`]: [
    { user: 'UC', text: `<@${ME}> URL ください`, ts: T.doneRoot, reply_count: 1 },
    { user: ME, text: 'こちらです https://example.com', ts: T.done },
  ],
  [`C3:${T.waitRoot}`]: [
    { user: 'UD', text: `<@${ME}> 仕様これで合ってますか`, ts: T.waitRoot, reply_count: 1 },
    { user: ME, text: '合ってます。ログを送ってもらえますか', ts: T.wait },
  ],
  [`C4:${T.group}`]: [{ user: 'UF', text: '<!subteam^SG1|@server> 障害の一次対応できる方いますか', ts: T.group }],
  [`C3:${T.freshRoot}`]: [
    { user: ME, text: '<@UE> レビューをお願いします', ts: T.freshRoot, reply_count: 1 },
    { user: 'UE', text: '後で見ます', ts: T.fresh },
  ],
};
const dmHistory = [{ bot_id: 'B1', username: 'github', text: 'PR merged', ts: T.dm }];

const props = {
  SLACK_USER_TOKEN: 'xoxp-test', SLACK_BOT_TOKEN: 'xoxb-test', ANTHROPIC_API_KEY: 'k',
};
let grid = [];
const posted = [];
const calls = { claude: 0, replies: 0 };
let judgeFails = false;
const extraMentions = [];

const response = (code, body, headers) => ({
  getResponseCode: () => code, getContentText: () => JSON.stringify(body), getHeaders: () => headers || {},
});
const claudeJson = (obj) => response(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });

function claude(req) {
  calls.claude++;
  const body = JSON.parse(req.payload);
  assert.strictEqual(req.headers['anthropic-version'], '2026-10-21');
  assert.strictEqual(body.output_config.format.type, 'json_schema');
  const text = body.messages[0].content;
  if (body.system.includes('リマインド文')) {
    const input = JSON.parse(text.slice(text.indexOf('\n') + 1));
    // わざと 1 件落として、コード側が補うことを確かめる
    return claudeJson({ items: input.slice(0, 1).map((i) => ({ key: i.key, line: `AI: ${i.summary}` })) });
  }
  if (judgeFails) return response(529, { error: 'overloaded' });
  let state = 'NO_ACTION';
  if (text.includes('これ見てもらえますか')) state = 'UNREPLIED';
  if (text.includes('一次対応できる方')) { assert.ok(body.system.includes('<!subteam^SG1> (@server)')); state = 'UNREPLIED'; }
  if (text.includes('確認します')) state = 'PROMISED';
  if (text.includes('こちらです')) state = 'DONE';
  if (text.includes('ログを送って') || text.includes('レビューをお願い')) state = 'WAITING_OTHERS';
  if (text.includes('再依頼')) state = 'UNREPLIED';
  // 「確認します」の件だけ 10 時間後の期限つき
  const due = new Date(FIXED + 10 * 36e5 + 9 * 36e5).toISOString().slice(0, 16).replace('T', ' ');
  const next = state === 'WAITING_OTHERS' ? '' : state === 'DONE' ? '' : '返信する';
  return claudeJson({ state, summary: `要約(${state})`, reason: '根拠', next_action: next, due_at: state === 'PROMISED' ? due : '' });
}

function slack(url, req) {
  const u = new URL(url);
  const method = u.pathname.split('/').pop();
  const q = Object.fromEntries(u.searchParams);
  if (method === 'auth.test') return response(200, { ok: true, user_id: ME, user: 'me' });
  if (method === 'usergroups.list') {
    return response(200, { ok: true, usergroups: [{ id: 'SG1', handle: 'server', users: [ME] }, { id: 'SG2', handle: 'other', users: ['UX'] }] });
  }
  if (method === 'search.messages') {
    let matches = [];
    const link = (c, t, root) => `https://x.slack.com/archives/${c}/p${t.replace('.', '')}${root ? `?thread_ts=${root}` : ''}`;
    if (q.query.startsWith(`<@${ME}>`)) {
      matches = [
        { channel: { id: 'C1' }, ts: T.ask, permalink: link('C1', T.ask) },
        { channel: { id: 'C1' }, ts: T.promiseRoot, permalink: link('C1', T.promiseRoot) },
        { channel: { id: 'C2' }, ts: T.doneRoot, permalink: link('C2', T.doneRoot) },
        { channel: { id: 'CNOTIFY' }, ts: ts(1, 9), permalink: link('CNOTIFY', ts(1, 9)) },
      ].concat(extraMentions);
    } else if (q.query.startsWith('<!subteam^SG1>')) {
      matches = [{ channel: { id: 'C4' }, ts: T.group, permalink: link('C4', T.group) }];
    } else if (q.query.startsWith('<!subteam')) {
      throw new Error('所属していないグループを検索した');
    } else if (q.query.startsWith('is:dm')) {
      matches = [{ channel: { id: 'D1', is_im: true }, ts: T.dm, permalink: link('D1', T.dm) }];
    } else {
      matches = [
        { channel: { id: 'C3' }, ts: T.wait, permalink: link('C3', T.wait, T.waitRoot) },
        { channel: { id: 'C3' }, ts: T.freshRoot, permalink: link('C3', T.freshRoot) },
        { channel: { id: 'C1' }, ts: T.promise, permalink: link('C1', T.promise, T.promiseRoot) },
        { channel: { id: 'C2' }, ts: T.done, permalink: link('C2', T.done, T.doneRoot) },
      ];
    }
    return response(200, { ok: true, messages: { matches, paging: { pages: 1 } } });
  }
  if (method === 'conversations.replies') {
    calls.replies++;
    return response(200, { ok: true, messages: threads[`${q.channel}:${q.ts}`] });
  }
  if (method === 'conversations.history') {
    return response(200, { ok: true, messages: q.channel === 'D1' ? dmHistory.slice().reverse() : [] });
  }
  if (method === 'chat.postMessage') {
    assert.ok(req.headers.Authorization.includes('xoxb-'));
    posted.push(JSON.parse(req.payload));
    return response(200, { ok: true });
  }
  throw new Error(`unexpected ${method}`);
}

const fetchOne = (url, req) => (url.includes('anthropic.com') ? claude(req) : slack(url, req));
const range = (r, c, nr, nc) => ({
  setValues: (v) => { v.forEach((row, i) => { grid[r - 1 + i] = row.slice(); }); },
  clearContent: () => { grid.length = r - 1; },
  setNumberFormat: () => {},
});
const sheet = {
  getRange: range, setFrozenRows: () => {}, getMaxRows: () => 1000,
  getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
  getLastRow: () => grid.length,
};
let sheetCreated = false;
const sandbox = {
  console, URL,
  UrlFetchApp: { fetch: fetchOne, fetchAll: (reqs) => reqs.map((r) => fetchOne(r.url, r)) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({
    getSheetByName: () => (sheetCreated ? sheet : null), insertSheet: () => { sheetCreated = true; return sheet; },
  }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
  Utilities: {
    sleep: () => {},
    formatDate: (d, tz, f) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
      }).formatToParts(d).map((x) => [x.type, x.value]));
      if (f === 'H') return String(Number(p.hour));
      if (f === 'u') return String(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1);
      if (f === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
      return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
    },
  },
  ScriptApp: {},
};
vm.createContext(sandbox);
vm.runInContext(`const RealDate = Date; Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(${FIXED}); }
  static now() { return ${FIXED}; }
};`, sandbox);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '../src/Code.gs'), 'utf8') + '\nthis.__api = { scanAndJudge, notify_, COLS, STATE, CFG, isRipe_, isMine_, elapsedHours_, priority_ };', sandbox);
const api = sandbox.__api;
const { scanAndJudge, notify_, COLS, STATE, CFG } = api;
CFG.NOTIFY_CHANNEL_ID = 'CNOTIFY';
const table = () => Object.fromEntries(grid.slice(1).map((r) => [r[0], Object.fromEntries(COLS.map((c, i) => [c, r[i]]))]));

// 1) 初回: 4 件を仕分ける。通知チャンネルの投稿は拾わない。bot だけの DM は AI を呼ばない。
scanAndJudge();
let t = table();
assert.strictEqual(Object.keys(t).length, 7);
assert.strictEqual(t[`C4:${T.group}`].state, STATE.UNREPLIED);
assert.strictEqual(t[`C3:${T.waitRoot}`].state, STATE.WAITING_OTHERS);
assert.strictEqual(t[`C3:${T.freshRoot}`].priority, '低');
assert.strictEqual(t[`C1:${T.ask}`].state, STATE.UNREPLIED);
assert.strictEqual(t[`C1:${T.promiseRoot}`].state, STATE.PROMISED);
assert.strictEqual(t[`C2:${T.doneRoot}`].state, STATE.DONE);
assert.strictEqual(t['D1:dm'].state, STATE.NO_ACTION);
assert.strictEqual(calls.claude, 6);
assert.strictEqual(typeof t[`C1:${T.promiseRoot}`].pending_since.getTime, "function");
assert.strictEqual(t[`C2:${T.doneRoot}`].pending_since, '');

// 2) 変化なしの再実行: 追跡中の 5 件だけ読み直し、AI は呼ばない。
calls.claude = 0; calls.replies = 0;
scanAndJudge();
assert.strictEqual(calls.claude, 0);
assert.strictEqual(calls.replies, 5);

// 3) 通知: 自分の対応待ち 2 件と、24 時間超の相手待ち 1 件を 1 通で。期限が近い件が先頭。2 回目は投稿しない。
const stale = (row, nowMs) => !row.last_notified_at && api.isRipe_(row, nowMs);
notify_('stale', stale);
assert.strictEqual(posted.length, 1);
assert.strictEqual(posted[0].channel, 'CNOTIFY');
let out = posted[0].text.split('\n');
// 2 時間前のグループメンションは放置時間に達していないので載らない
const heads = [`<@${ME}> *自分の対応待ち 2 件*`, '• [高] 要約(PROMISED)', '• [中] AI: 要約(UNREPLIED)', '*相手待ち（催促候補） 1 件*', '• [中] 要約(WAITING_OTHERS)'];
assert.strictEqual(out.length, heads.length);
// AI は 1 件分しか返さない（どの件かは入力順しだい）。残りは定型文で補われる
heads.forEach((h, i) => assert.ok(out[i].replace('AI: ', '').startsWith(h.replace('AI: ', '')), `${i}: ${out[i]}`));
assert.strictEqual(out.filter((l) => l.includes('AI: ')).length, 1);
assert.ok(out[1].includes('期限 ') && out[4].includes('催促する'));
notify_('stale', stale);
assert.strictEqual(posted.length, 1);
assert.strictEqual(table()[`C1:${T.ask}`].notify_count, 1);
// シートは優先度順に並ぶ
assert.deepStrictEqual(grid.slice(1, 4).map((r) => r[COLS.indexOf('priority')]), ['高', '中', '中']);

// 4) AI 判定が失敗したら状態を変えず、次回に再判定する。
threads[`C1:${T.ask}`].push({ user: 'UA', text: '追加でこれ見てもらえますか', ts: T.more });
judgeFails = true;
const before = table()[`C1:${T.ask}`].fingerprint;
scanAndJudge();
assert.strictEqual(table()[`C1:${T.ask}`].state, STATE.UNREPLIED);
assert.strictEqual(table()[`C1:${T.ask}`].fingerprint, before);
judgeFails = false;

// 5) 相手の最後の発言に本人が :done: を付けたら、AI を呼ばずに完了になり、通知対象から外れる。
threads[`C1:${T.ask}`][1].reactions = [{ name: 'done', users: [ME] }];
calls.claude = 0;
scanAndJudge();
t = table();
assert.strictEqual(calls.claude, 0);
assert.strictEqual(t[`C1:${T.ask}`].state, STATE.DONE);
assert.strictEqual(t[`C1:${T.ask}`].pending_since, '');
assert.strictEqual(t[`C1:${T.ask}`].summary, '要約(UNREPLIED)');
// 6) 相手待ちの件で催促すると、そこから数え直して通知済みも解除される。
assert.ok(table()[`C3:${T.waitRoot}`].last_notified_at);
threads[`C3:${T.waitRoot}`].push({ user: ME, text: 'ログを送ってもらえますか（再送）', ts: T.more });
scanAndJudge();
t = table();
assert.strictEqual(t[`C3:${T.waitRoot}`].state, STATE.WAITING_OTHERS);
assert.strictEqual(t[`C3:${T.waitRoot}`].last_notified_at, '');
assert.strictEqual(t[`C3:${T.waitRoot}`].priority, '低');

// 7) 完了済みスレッドに新しい依頼が来て判定に失敗しても、次回の実行で再判定される。
threads[`C2:${T.doneRoot}`].push({ user: 'UC', text: '再依頼: 別の URL もください', ts: T.more });
const reask = { channel: { id: 'C2' }, ts: T.more, permalink: `https://x.slack.com/archives/C2/p1?thread_ts=${T.doneRoot}` };
extraMentions.push(reask);
judgeFails = true;
scanAndJudge();
assert.strictEqual(table()[`C2:${T.doneRoot}`].state, STATE.DONE);
judgeFails = false;
scanAndJudge();
assert.strictEqual(table()[`C2:${T.doneRoot}`].state, STATE.UNREPLIED);

// 8) 土日は経過時間に数えない（金 18:00 → 月 10:00 は 16 時間）。動きがないまま 14 日を過ぎたら打切り。
assert.strictEqual(api.elapsedHours_(Date.parse('2026-11-06T09:00:00Z'), Date.parse('2026-11-09T01:00:00Z')), 16);
const old = { state: STATE.WAITING_OTHERS, pending_since: new Date(FIXED - 15 * 864e5), due_at: '' };
assert.strictEqual(api.priority_(old, FIXED), '打切り');

// 朝のまとめ: 自分の対応待ち 3 件。催促し直した相手待ちは載らない。
notify_('digest', (row, nowMs) => api.isMine_(row) || api.isRipe_(row, nowMs));
assert.strictEqual(posted.length, 2);
assert.strictEqual(posted[1].text.split('\n').length, 4);

console.log('OK');
console.log(posted.map((p) => p.text).join('\n---\n'));
