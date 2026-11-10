// scripts/local-ai.mjs を、シートと claude を差し替えて動かす。
import assert from 'node:assert';
import { batches, CFG, io, judge, notice } from '../scripts/local-ai.mjs';

const sheets = {
  threads: [
    ['key', 'state', 'summary', 'reason', 'next_action', 'fingerprint', 'pending_fp', 'pending_input'],
    ['C1:1', '', '', '', '', '', 'fp1', JSON.stringify({ me: 'UME', groups: [], done_reactions: ['done'], kind: 'スレッド', messages: [{ at: 'x', speaker: '他者(UA)', text: '見てください' }] })],
    ['C1:2', '未返信', '設定の件', '根拠', '返信する', 'fp2', '', ''],
    ['C1:3', '対応完了', '済んだ件', '根拠', '', 'fp3', 'fp3b', '壊れた JSON'],
    ['C1:4', '相手待ち', 'ログ待ち', '根拠', '', 'fp4', 'fp4b', JSON.stringify({ me: 'UME', groups: [], done_reactions: [], kind: 'スレッド', messages: [] })],
  ],
  judgments: [['key', 'fingerprint', 'state'], ['C1:4', 'fp4b', 'WAITING_OTHERS']],
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
    return { items: [
      { key: 'C1:1', state: 'UNREPLIED', summary: '=HYPERLINK("x")', reason: 'r', next_action: 'n', due_at: '' },
      { key: 'C1:1', state: 'DONE', summary: '重複', reason: 'r', next_action: '', due_at: '' },
      { key: 'C9:9', state: 'DONE', summary: '頼んでいない', reason: 'r', next_action: '', due_at: '' },
    ] };
  }
  return { items: JSON.parse(input).map((i) => ({ key: i.key, line: `${i.summary}を進める` })) };
};

// 仕分け: 判定待ちのうち未判定の 1 件だけを AI に渡し、結果を 1 行だけ追記する。
assert.strictEqual(judge(), 1);
assert.strictEqual(claudeCalls.length, 1);
assert.strictEqual(claudeCalls[0].model, CFG.JUDGE_MODEL);
const sent = JSON.parse(claudeCalls[0].input.split('\n').slice(1).join('\n'));
assert.deepStrictEqual(sent.map((s) => s.key), ['C1:1']);
assert.deepStrictEqual(sheets.judgments.at(-1).slice(0, 4), ['C1:1', 'fp1', 'UNREPLIED', '=HYPERLINK("x")']);
assert.strictEqual(sheets.judgments.length, 3);
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
assert.strictEqual(sheets.judgments.length, 3);

// まとめ方: 件数と文字数の上限で分ける。
assert.deepStrictEqual(batches([1, 2, 3, 4, 5], 2, 100, () => 1).map((b) => b.length), [2, 2, 1]);
assert.deepStrictEqual(batches([60, 60, 10], 8, 100, (n) => n).map((b) => b.length), [1, 2]);

console.log('OK');
