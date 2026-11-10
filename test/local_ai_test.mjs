// scripts/local-ai.mjs を、シートと claude を差し替えて動かす。
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { batches, CFG, io, JUDGE_VERSION, judge, notice, runner, SLACK_READ_TOOLS, SLACK_WRITE_TOOLS, EXTERNAL_TOOLS } from '../scripts/local-ai.mjs';
import { appendFileSync, chmodSync, existsSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { errorText, logFile, parseLine, usage } from '../scripts/log.mjs';

// macOS の一時ディレクトリは /var → /private/var のリンクを含むので、実体の経路を使う
const tmpdir = () => realpathSync(osTmpdir());
const logDir = mkdtempSync(join(tmpdir(), 'reply-watch-log-'));
process.env.REPLY_WATCH_LOG_DIR = logDir;
const jst = (ms) => new Date(ms + 9 * 36e5).toISOString().slice(0, 19).replace('T', ' ');
const JNOW = jst(Date.now());
const JAGO = jst(Date.now() - 25 * 36e5);
const usageOf = (n) => ({ model: 'm', in: 10 * n, out: 5 * n, cache_create: 100, cache_read: 0, cost_usd: 0.001 * n });

const sheets = {
  threads: [
    ['key', 'state', 'summary', 'reason', 'next_action', 'fingerprint', 'pending_fp', 'pending_input', 'priority'],
    ['C1:1', '', '', '', '', '', 'fp1', JSON.stringify({ me: 'UME', groups: [], done_reactions: ['done'], kind: 'スレッド', messages: [{ at: 'x', speaker: '他者(UA)', text: '見てください' }] })],
    ['C1:2', '未返信', '設定の件', '根拠', '返信する', 'fp2', '', ''],
    ['C1:3', '対応完了', '済んだ件', '根拠', '', 'fp3', 'fp3b', '壊れた JSON'],
    ['C1:4', '相手待ち', 'ログ待ち', '根拠', '', 'fp4', 'fp4b', JSON.stringify({ me: 'UME', groups: [], done_reactions: [], kind: 'スレッド', messages: [] })],
    ['D1:dm', '未返信', 'DM の件', '根拠', '返信する', 'fp6', '', '', '対象外'],
    ['D2:dm', '', '', '', '', '', 'fp7', JSON.stringify({ messages: [{ text: 'DM の本文' }] }), '対象外'],
  ],
  // C1:4 は判定済み。C1:1 には古い版の判定（9 列目なし、9 列目が真偽値）だけがあるので、判定し直す
  // C1:1 は 25 時間前の判定なので、GAS が回してきた判定待ちは調べ直す
  judgments: [['key', 'fingerprint', 'state'], ['C1:4', 'fp4b', 'WAITING_OTHERS', '', '', '', '', JNOW, 'OTHER', JUDGE_VERSION], ['C1:1', 'fp1', 'DONE'],
    ['C1:1', 'fp1', 'DONE', '', '', '', '', JNOW, true], ['C1:1', 'fp1', 'DONE', '', '', '', '', JNOW, 'OTHER', 2],
    ['C1:1', 'fp1', 'DONE', '', '', '', '', JAGO, 'OTHER', JUDGE_VERSION]],
  notices: [['key', 'fingerprint', 'line']],
  meta: [['name', 'value'], ['judge_version', 'X']],
};
// claude に実際に渡す引数を、プロセス起動の境界で確かめる（io.claude は後で差し替えるので先に試す）
{
  const seen = [];
  const keepSpawn = runner.spawnSync;
  runner.spawnSync = (cmd, args, opts) => {
    const i = args.indexOf('--mcp-config');
    seen.push({ args, mcp: i >= 0 ? JSON.parse(readFileSync(args[i + 1], 'utf8')) : null, cwd: opts.cwd, input: opts.input });
    return { status: 0, stdout: JSON.stringify({ structured_output: { ok: true }, usage: {} }) };
  };
  io.claude('m', 'sys', { type: 'object' }, '本文');
  io.claude('m', 'sys', { type: 'object' }, '本文', { slack: true });
  runner.spawnSync = keepSpawn;
  const flag = (args, name) => args[args.indexOf(name) + 1];
  for (const s of seen) {
    assert.strictEqual(flag(s.args, '--tools'), '');
    assert.strictEqual(flag(s.args, '--setting-sources'), '');
    assert.strictEqual(flag(s.args, '--permission-mode'), 'dontAsk');
    assert.ok(s.args.includes('--strict-mcp-config') && s.args.includes('--disable-slash-commands'));
    assert.strictEqual(JSON.parse(flag(s.args, '--settings')).disableAllHooks, true);
    assert.strictEqual(s.input, '本文'); // 本文は標準入力で渡し、引数には載せない
    assert.ok(!s.args.includes('本文'));
  }
  assert.ok(!seen[0].args.includes('--mcp-config') && !seen[0].args.includes('--allowedTools'));
  const allowed = seen[1].args.slice(seen[1].args.indexOf('--allowedTools') + 1, seen[1].args.indexOf('--disallowedTools'));
  assert.ok(allowed.every((t) => SLACK_READ_TOOLS.includes(t) || EXTERNAL_TOOLS.includes(t)));
  assert.ok(SLACK_WRITE_TOOLS.every((t) => seen[1].args.includes(t)));
  assert.ok(Object.keys(seen[1].mcp.mcpServers).every((n) => ['plugin:slack:slack', 'external'].includes(n)));
  assert.ok(!existsSync(seen[1].cwd), '一時ディレクトリは消える');
}

const claudeCalls = [];
io.readSheet = (name) => sheets[name].map((r) => r.slice());
io.appendRows = (name, rows) => { sheets[name].push(...rows); };
io.replaceRows = (name, rows) => { sheets[name] = [sheets[name][0], ...rows]; };
io.claude = (model, system, schema, input, opts = {}) => {
  claudeCalls.push({ model, system, input, opts });
  // どの段階の呼び出しかは、出力の形（スキーマ）で見分ける
  if (JSON.stringify(schema).includes('still_needed')) {
    // 確認: C1:1 は別の場所で片付いていた。頼んでいない key と、矛盾した組み合わせを混ぜる
    return { usage: usageOf(3), data: { items: [
      { key: 'C1:1', still_needed: false, corrected_state: 'DONE', note: '11/09 に別スレで回答済み', ball: '', action_type: 'NONE' },
      { key: 'C9:9', still_needed: false, corrected_state: 'DONE', note: '頼んでいない' },
      { key: 'C1:1', still_needed: true, corrected_state: 'KEEP', note: '重複' },
    ] } };
  }
  if (JSON.stringify(schema).includes('is_review_request_to_me')) {
    // 頼んでいない key、重複、未知の state を混ぜる
    return { usage: usageOf(1), data: { items: [
      { key: 'C1:1', state: 'UNREPLIED', summary: '=HYPERLINK("x")', reason: 'r', next_action: 'n', due_at: '', is_review_request_to_me: false },
      { key: 'C1:1', state: 'DONE', summary: '重複', reason: 'r', next_action: '', due_at: '', is_review_request_to_me: false },
      { key: 'C9:9', state: 'DONE', summary: '頼んでいない', reason: 'r', next_action: '', due_at: '', is_review_request_to_me: false },
    ] } };
  }
  return { usage: usageOf(2), data: { items: JSON.parse(input).map((i) => ({ key: i.key, line: `${i.summary}を進める` })) } };
};

// 判定の版が GAS（meta シート）と違えば、判定しない
assert.throws(() => judge(), /判定の版が GAS と違う/);
assert.strictEqual(claudeCalls.length, 0);
sheets.meta[1][1] = JUDGE_VERSION;

// 仕分け: 判定待ちのうち未判定の 1 件だけを AI に渡し、結果を 1 行だけ追記する。
// 対応が残るとした件は、Slack の読み取りツール付きで確かめ、片付いていれば DONE に下げて根拠を残す。
assert.strictEqual(judge(), 1);
assert.strictEqual(claudeCalls.length, 2);
assert.strictEqual(claudeCalls[1].opts.slack, true);
assert.deepStrictEqual(JSON.parse(claudeCalls[1].input.split('\n').slice(1).join('\n')).map((i) => [i.key, i.me, i.state]),
  [['C1:1', 'UME', 'UNREPLIED']]);
assert.strictEqual(sheets.judgments.at(-1)[10], '11/09 に別スレで回答済み');
claudeCalls.splice(1, 1);
assert.strictEqual(claudeCalls[0].model, CFG.JUDGE_MODEL);
const sent = JSON.parse(claudeCalls[0].input.split('\n').slice(1).join('\n'));
assert.deepStrictEqual(sent.map((s) => s.key), ['C1:1']);
assert.deepStrictEqual(sheets.judgments.at(-1).slice(0, 4), ['C1:1', 'fp1', 'DONE', '=HYPERLINK("x")']);
assert.strictEqual(sheets.judgments.at(-1)[8], 'OTHER');
assert.strictEqual(sheets.judgments.at(-1)[9], JUDGE_VERSION);
assert.strictEqual(sheets.judgments.length, 7);
// 同じ内容は二度判定しない
assert.strictEqual(judge(), 0);
assert.strictEqual(claudeCalls.length, 1);

// 通知文: 対応が残っている件だけを、仕分け結果（スレッド本文なし）から作る。
assert.strictEqual(notice(), 2);
assert.strictEqual(claudeCalls[1].model, CFG.NOTICE_MODEL);
assert.ok(!claudeCalls[1].input.includes('pending_input') && !claudeCalls[1].input.includes('messages'));
assert.deepStrictEqual(sheets.notices.slice(1).map((r) => r.slice(0, 3)), [
  ['C1:2', 'fp2#未返信#', '設定の件を進める'], ['C1:4', 'fp4#相手待ち#', 'ログ待ちを進める'],
]);
assert.strictEqual(notice(), 0);
// 内容（指紋）が同じでも、判定し直して状態が変わったら通知文を作り直す
sheets.threads.find((r) => r[0] === 'C1:4')[1] = '返信済み・対応未完了';
assert.strictEqual(notice(), 1);

// AI が失敗しても落ちず、何も書かない（次の起動でやり直す）。
sheets.threads.push(['C1:5', '', '', '', '', '', 'fp5', JSON.stringify({ messages: [] })]);
io.claude = () => { throw new Error('timeout'); };
assert.strictEqual(judge(), 0);
assert.strictEqual(sheets.judgments.length, 7);

// ログ: 1 行 1 イベントで、件数・トークン数は残し、Slack 由来の文字列（要約や本文）は残さない。
const lines = readFileSync(logFile(), 'utf8').trim().split('\n');
const events = lines.map(parseLine);
assert.ok(events.every(Boolean));
['judge.start', 'claude.call', 'judge.batch', 'judge.end', 'notice.start', 'notice.batch', 'notice.end', 'claude.error', 'judge.batch_failed']
  .forEach((ev) => assert.ok(events.some((e) => e.event === ev), ev));
const call = events.find((e) => e.event === 'claude.call' && e.fields.session === 'judge');
assert.deepStrictEqual([call.fields.items, call.fields.in, call.fields.out, call.fields.cache_create], ['1', '10', '5', '100']);
assert.strictEqual(events.find((e) => e.event === 'judge.batch').fields.states, 'DONE:1');
assert.strictEqual(events.find((e) => e.event === 'judge.batch').fields.closed_by_verify, '1');
assert.ok(events.some((e) => e.event === 'claude.call' && e.fields.session === 'verify'));
assert.strictEqual(events.find((e) => e.event === 'judge.batch_failed').fields.error, 'timeout');
const text = readFileSync(logFile(), 'utf8');
['HYPERLINK', '見てください', '設定の件', 'を進める', 'ログ待ち'].forEach((s) => assert.ok(!text.includes(s), s));

// 利用量の集計: 日ごと・用途ごとに、呼出・件数・トークン・失敗を合計する。
const u = usage(1);
const byS = Object.fromEntries(u.map((r) => [r.session, r]));
assert.deepStrictEqual([byS.judge.calls, byS.judge.errors, byS.judge.items, byS.judge.input, byS.judge.output], [1, 1, 1, 10, 5]);
assert.deepStrictEqual([byS.notice.calls, byS.notice.items, byS.notice.input, byS.notice.cache_create], [2, 3, 40, 200]);

// 細工された行や壊れた行があっても集計は止まらない。用途の名前は決まったものだけ。
appendFileSync(logFile(), [
  '2099-01-01 00:00:00 INFO claude.call session="\\q" items=1',
  'garbage line',
  `${new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 19).replace('T', ' ')} INFO claude.call session=__proto__ items=Infinity in=-5 out=abc`,
].join('\n') + '\n');
const u2 = usage('not-a-number');
assert.ok(u2.every((r) => ['judge', 'verify', 'notice', '-'].includes(r.session)));
const other = u2.find((r) => r.session === '-');
assert.deepStrictEqual([other.calls, other.items, other.input, other.output], [1, 0, 0, 0]);
assert.strictEqual(({}).polluted, undefined);

// 保存先とファイルは本人専用。権限が緩ければ締め、リンクは辿らない。
assert.strictEqual(statSync(logDir).mode & 0o777, 0o700);
assert.strictEqual(statSync(logFile()).mode & 0o777, 0o600);
chmodSync(logDir, 0o755);
chmodSync(logFile(), 0o644);
judge();
assert.strictEqual(statSync(logDir).mode & 0o777, 0o700);
assert.strictEqual(statSync(logFile()).mode & 0o777, 0o600);
const victimDir = mkdtempSync(join(tmpdir(), 'reply-watch-victim-'));
const victim = join(victimDir, 'victim.txt');
writeFileSync(victim, 'original\n');
const linkDir = mkdtempSync(join(tmpdir(), 'reply-watch-link-'));
symlinkSync(victim, join(linkDir, 'local-ai.log'));
process.env.REPLY_WATCH_LOG_DIR = linkDir;
judge();
assert.strictEqual(readFileSync(victim, 'utf8'), 'original\n');
assert.deepStrictEqual(usage(1), []);
const linkedDir = join(mkdtempSync(join(tmpdir(), 'reply-watch-link2-')), 'logs');
symlinkSync(victimDir, linkedDir);
process.env.REPLY_WATCH_LOG_DIR = linkedDir;
judge();
assert.strictEqual(readFileSync(victim, 'utf8'), 'original\n');
// 他人が書き込める（sticky でない）ディレクトリの中は、確かめた後に差し替えられるので使わない
const loose = mkdtempSync(join(tmpdir(), 'reply-watch-loose-'));
chmodSync(loose, 0o777);
process.env.REPLY_WATCH_LOG_DIR = join(loose, 'logs');
judge();
assert.ok(!existsSync(join(loose, 'logs', 'local-ai.log')));
chmodSync(loose, 0o1777); // sticky なら他人は差し替えられないので可
judge();
assert.ok(existsSync(join(loose, 'logs', 'local-ai.log')));
rmSync(loose, { recursive: true, force: true });

// 途中にリンクを含む指定は、リンク先が本人専用の場所でも使わない（後で張り替えられるため）
const base = mkdtempSync(join(tmpdir(), 'reply-watch-base-'));
const target = mkdtempSync(join(tmpdir(), 'reply-watch-target-'));
symlinkSync(target, join(base, 'jump'));
process.env.REPLY_WATCH_LOG_DIR = join(base, 'jump', 'logs');
judge();
assert.ok(!existsSync(join(target, 'logs')));
assert.deepStrictEqual(usage(1), []);
[base, target].forEach((d) => rmSync(d, { recursive: true, force: true }));
process.env.REPLY_WATCH_LOG_DIR = logDir;

// エラー文言: 決まった文言はそのまま、パスなどを含む文言はコードだけにする。
assert.strictEqual(errorText(new Error('gog: exit 1')), 'gog: exit 1');
assert.strictEqual(errorText(new Error('claude: 出力を解析できない')), 'claude: 出力を解析できない');
const enoent = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/someone/x'"), { code: 'ENOENT' });
assert.strictEqual(errorText(enoent), 'ENOENT');
assert.strictEqual(errorText(new Error('see /tmp/x')), 'unexpected');

// GAS が判定待ちに積んだ時刻（pending_at）より前の判定しかなければ、24 時間以内でも判定し直す
// （内容が A→B→A と戻った時に、古い A の判定で済ませない）
const serial = (ms) => (ms + 9 * 36e5) / 864e5 + 25569;
sheets.threads.push(['C1:8', '', '', '', '', '', 'fp8', JSON.stringify({ me: 'UME', messages: [] }), '', '', serial(Date.now())]);
sheets.threads[0].push('extra', 'pending_at');
sheets.judgments.push(['C1:8', 'fp8', 'DONE', '', '', '', '', jst(Date.now() - 60 * 60 * 1000), 'OTHER', JUDGE_VERSION]);
const keepClaude = io.claude;
const asked8 = [];
io.claude = (model, system, schema, input) => {
  asked8.push(input.includes('"C1:8"'));
  return JSON.stringify(schema).includes('still_needed')
    ? { usage: usageOf(1), data: { items: [] } }
    : { usage: usageOf(1), data: { items: [{ key: 'C1:8', state: 'NO_ACTION', summary: 's', reason: 'r', next_action: '', due_at: '', is_review_request_to_me: false }] } };
};
judge();
assert.strictEqual(asked8.filter(Boolean).length, 1, 'pending_at より前の判定では済ませない');
judge();
assert.strictEqual(asked8.filter(Boolean).length, 1, 'pending_at 以降の判定があれば判定済み');
io.claude = keepClaude;

// 確認で「残す」としても、本人のボールを具体的に書けていなければ、本人のボールではないとみなして落とす。
// 書けていれば、そのボールがシートに残る（通知に載る）。
const realClaude = io.claude;
sheets.threads.push(['C1:6', '', '', '', '', '', 'fp6x', JSON.stringify({ me: 'UME', messages: [] }), ''],
  ['C1:7', '', '', '', '', '', 'fp7x', JSON.stringify({ me: 'UME', messages: [] }), '']);
io.claude = (model, system, schema) => (JSON.stringify(schema).includes('still_needed')
  ? { usage: usageOf(1), data: { items: [
    { key: 'C1:6', still_needed: true, corrected_state: 'KEEP', note: 'n', ball: '' },
    { key: 'C1:7', still_needed: true, corrected_state: 'KEEP', note: 'n', ball: 'UA に修正の時期を返す', action_type: 'REPLY_ONLY' },
  ] } }
  : { usage: usageOf(1), data: { items: ['C1:6', 'C1:7'].map((key) => ({
    key, state: 'UNREPLIED', summary: 's', reason: 'r', next_action: '返信する', due_at: '', is_review_request_to_me: false })) } });
judge();
const byKey = Object.fromEntries(sheets.judgments.slice(-2).map((r) => [r[0], r]));
assert.strictEqual(byKey['C1:6'][2], 'NO_ACTION');
assert.ok(byKey['C1:6'][10].startsWith('ボールを特定できない'));
assert.strictEqual(byKey['C1:7'][2], 'UNREPLIED');
assert.strictEqual(byKey['C1:7'][11], 'UA に修正の時期を返す');
assert.strictEqual(byKey['C1:7'][12], 'REPLY_ONLY');
io.claude = realClaude;

rmSync(logDir, { recursive: true, force: true });
[victimDir, linkDir].forEach((d) => rmSync(d, { recursive: true, force: true }));

// 確認に使う Slack のツールは読み取りだけ。書き込みのツールは許可せず、禁止の一覧に入っている
import('../scripts/local-ai.mjs').then(({ SLACK_READ_TOOLS, SLACK_WRITE_TOOLS }) => {
  assert.ok(SLACK_READ_TOOLS.every((t) => /slack_(read|search)_/.test(t)));
  assert.ok(SLACK_WRITE_TOOLS.some((t) => t.endsWith('slack_send_message')));
  assert.ok(!SLACK_READ_TOOLS.some((t) => SLACK_WRITE_TOOLS.includes(t)));
});

// 判定の版は GAS 側（src/Code.gs の CFG.JUDGE_VERSION）と揃っている
const gasVersion = /JUDGE_VERSION: (\d+)/.exec(readFileSync(new URL('../src/Code.gs', import.meta.url), 'utf8'))[1];
assert.strictEqual(String(JUDGE_VERSION), gasVersion);

// まとめ方: 件数と文字数の上限で分ける。
assert.deepStrictEqual(batches([1, 2, 3, 4, 5], 2, 100, () => 1).map((b) => b.length), [2, 2, 1]);
assert.deepStrictEqual(batches([60, 60, 10], 8, 100, (n) => n).map((b) => b.length), [1, 2]);

console.log('OK');
