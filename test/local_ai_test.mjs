// scripts/local-ai.mjs を、シートと claude を差し替えて動かす。
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { batches, CFG, io, judge, notice } from '../scripts/local-ai.mjs';
import { appendFileSync, chmodSync, existsSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { errorText, logFile, parseLine, usage } from '../scripts/log.mjs';

// macOS の一時ディレクトリは /var → /private/var のリンクを含むので、実体の経路を使う
const tmpdir = () => realpathSync(osTmpdir());
const logDir = mkdtempSync(join(tmpdir(), 'reply-watch-log-'));
process.env.REPLY_WATCH_LOG_DIR = logDir;
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
  judgments: [['key', 'fingerprint', 'state'], ['C1:4', 'fp4b', 'WAITING_OTHERS', '', '', '', '', '', 'OTHER'], ['C1:1', 'fp1', 'DONE'],
    ['C1:1', 'fp1', 'DONE', '', '', '', '', '', true]],
  notices: [['key', 'fingerprint', 'line']],
};
const claudeCalls = [];
io.readSheet = (name) => sheets[name].map((r) => r.slice());
io.appendRows = (name, rows) => { sheets[name].push(...rows); };
io.replaceRows = (name, rows) => { sheets[name] = [sheets[name][0], ...rows]; };
io.claude = (model, system, schema, input) => {
  claudeCalls.push({ model, system, input });
  if (system.includes('仕分ける')) {
    // 頼んでいない key、重複、未知の state を混ぜる
    return { usage: usageOf(1), data: { items: [
      { key: 'C1:1', state: 'UNREPLIED', summary: '=HYPERLINK("x")', reason: 'r', next_action: 'n', due_at: '', is_review_request_to_me: false },
      { key: 'C1:1', state: 'DONE', summary: '重複', reason: 'r', next_action: '', due_at: '', is_review_request_to_me: false },
      { key: 'C9:9', state: 'DONE', summary: '頼んでいない', reason: 'r', next_action: '', due_at: '', is_review_request_to_me: false },
    ] } };
  }
  return { usage: usageOf(2), data: { items: JSON.parse(input).map((i) => ({ key: i.key, line: `${i.summary}を進める` })) } };
};

// 仕分け: 判定待ちのうち未判定の 1 件だけを AI に渡し、結果を 1 行だけ追記する。
assert.strictEqual(judge(), 1);
assert.strictEqual(claudeCalls.length, 1);
assert.strictEqual(claudeCalls[0].model, CFG.JUDGE_MODEL);
const sent = JSON.parse(claudeCalls[0].input.split('\n').slice(1).join('\n'));
assert.deepStrictEqual(sent.map((s) => s.key), ['C1:1']);
assert.deepStrictEqual(sheets.judgments.at(-1).slice(0, 4), ['C1:1', 'fp1', 'UNREPLIED', '=HYPERLINK("x")']);
assert.strictEqual(sheets.judgments.at(-1)[8], 'OTHER');
assert.strictEqual(sheets.judgments.length, 5);
// 同じ内容は二度判定しない
assert.strictEqual(judge(), 0);
assert.strictEqual(claudeCalls.length, 1);

// 通知文: 対応が残っている件だけを、仕分け結果（スレッド本文なし）から作る。
assert.strictEqual(notice(), 2);
assert.strictEqual(claudeCalls[1].model, CFG.NOTICE_MODEL);
assert.ok(!claudeCalls[1].input.includes('pending_input') && !claudeCalls[1].input.includes('messages'));
assert.deepStrictEqual(sheets.notices.slice(1).map((r) => r.slice(0, 3)), [
  ['C1:2', 'fp2', '設定の件を進める'], ['C1:4', 'fp4', 'ログ待ちを進める'],
]);
assert.strictEqual(notice(), 0);

// AI が失敗しても落ちず、何も書かない（次の起動でやり直す）。
sheets.threads.push(['C1:5', '', '', '', '', '', 'fp5', JSON.stringify({ messages: [] })]);
io.claude = () => { throw new Error('timeout'); };
assert.strictEqual(judge(), 0);
assert.strictEqual(sheets.judgments.length, 5);

// ログ: 1 行 1 イベントで、件数・トークン数は残し、Slack 由来の文字列（要約や本文）は残さない。
const lines = readFileSync(logFile(), 'utf8').trim().split('\n');
const events = lines.map(parseLine);
assert.ok(events.every(Boolean));
['judge.start', 'claude.call', 'judge.batch', 'judge.end', 'notice.start', 'notice.batch', 'notice.end', 'claude.error', 'judge.batch_failed']
  .forEach((ev) => assert.ok(events.some((e) => e.event === ev), ev));
const call = events.find((e) => e.event === 'claude.call' && e.fields.session === 'judge');
assert.deepStrictEqual([call.fields.items, call.fields.in, call.fields.out, call.fields.cache_create], ['1', '10', '5', '100']);
assert.strictEqual(events.find((e) => e.event === 'judge.batch').fields.states, 'UNREPLIED:1');
assert.strictEqual(events.find((e) => e.event === 'judge.batch_failed').fields.error, 'timeout');
const text = readFileSync(logFile(), 'utf8');
['HYPERLINK', '見てください', '設定の件', 'を進める', 'ログ待ち'].forEach((s) => assert.ok(!text.includes(s), s));

// 利用量の集計: 日ごと・用途ごとに、呼出・件数・トークン・失敗を合計する。
const u = usage(1);
const byS = Object.fromEntries(u.map((r) => [r.session, r]));
assert.deepStrictEqual([byS.judge.calls, byS.judge.errors, byS.judge.items, byS.judge.input, byS.judge.output], [1, 1, 1, 10, 5]);
assert.deepStrictEqual([byS.notice.calls, byS.notice.items, byS.notice.input, byS.notice.cache_create], [1, 2, 20, 100]);

// 細工された行や壊れた行があっても集計は止まらない。用途の名前は決まったものだけ。
appendFileSync(logFile(), [
  '2099-01-01 00:00:00 INFO claude.call session="\\q" items=1',
  'garbage line',
  `${new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 19).replace('T', ' ')} INFO claude.call session=__proto__ items=Infinity in=-5 out=abc`,
].join('\n') + '\n');
const u2 = usage('not-a-number');
assert.ok(u2.every((r) => ['judge', 'notice', '-'].includes(r.session)));
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

rmSync(logDir, { recursive: true, force: true });
[victimDir, linkDir].forEach((d) => rmSync(d, { recursive: true, force: true }));

// まとめ方: 件数と文字数の上限で分ける。
assert.deepStrictEqual(batches([1, 2, 3, 4, 5], 2, 100, () => 1).map((b) => b.length), [2, 2, 1]);
assert.deepStrictEqual(batches([60, 60, 10], 8, 100, (n) => n).map((b) => b.length), [1, 2]);

console.log('OK');
