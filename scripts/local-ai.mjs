#!/usr/bin/env node
// 手元の Claude Code（claude -p）で AI の仕事をする。GAS とはスプレッドシートだけでつながる。
//   judge   threads シートの判定待ちを仕分けて judgments シートに追記する
//   notice  仕分け結果だけを読み、通知の一文を作って notices シートに追記する
// 2 つは別々の claude 呼び出し（別セッション）で、互いの入力を見ない。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { errorText, log, logFile, usage } from './log.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CFG = {
  JUDGE_MODEL: process.env.REPLY_WATCH_JUDGE_MODEL || 'sonnet',
  NOTICE_MODEL: process.env.REPLY_WATCH_NOTICE_MODEL || 'haiku',
  JUDGE_BATCH_ITEMS: 8, // 1 回の claude 呼び出しにまとめる件数
  JUDGE_BATCH_CHARS: 60000, // 同、入力の文字数上限
  NOTICE_BATCH_ITEMS: 20,
  MAX_PER_RUN: 40, // 1 回の起動で処理する件数（残りは次の起動で）
  KEEP_ROWS: 500, // judgments / notices がこの 4 倍を超えたら、新しい方からこの件数だけ残す
  CLAUDE_TIMEOUT_MS: 5 * 60 * 1000,
};

const STATES = ['UNREPLIED', 'PROMISED', 'WAITING_OTHERS', 'DONE', 'NO_ACTION'];
const OPEN_LABELS = ['未返信', '返信済み・対応未完了', '相手待ち'];

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          state: { type: 'string', enum: STATES },
          summary: { type: 'string' },
          reason: { type: 'string' },
          next_action: { type: 'string' },
          due_at: { type: 'string' },
        },
        required: ['key', 'state', 'summary', 'reason', 'next_action', 'due_at'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const NOTICE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, line: { type: 'string' } },
        required: ['key', 'line'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

// ───────── 外部コマンド（テストでは差し替える） ─────────

// launchd から動く時は、scripts/launchd.sh が確かめた実行ファイルの絶対パスを環境変数で渡す
const BIN = { claude: process.env.REPLY_WATCH_CLAUDE || 'claude', gog: process.env.REPLY_WATCH_GOG || 'gog' };

// エラーには終了コードなど決まった情報だけを載せる。コマンドの出力には Slack の本文が含まれうるので、ログへ流さない。
function exec(cmd, args, opts = {}) {
  const res = spawnSync(BIN[cmd], args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (res.error) throw new Error(`${cmd}: ${res.error.code || '起動失敗'}`);
  if (res.status !== 0) throw new Error(`${cmd}: exit ${res.status}`);
  return res.stdout;
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what}: 出力を解析できない`);
  }
}

/** ログに出す識別子。シート由来なので、文字種と長さを絞る。 */
function safe(text) {
  return String(text).replace(/[^A-Za-z0-9:._-]/g, '?').slice(0, 60);
}

export const io = {
  spreadsheetId() {
    const id = JSON.parse(readFileSync(join(ROOT, '.clasp.json'), 'utf8')).parentId;
    return Array.isArray(id) ? id[0] : id;
  },
  readSheet(name) {
    return parseJson(exec('gog', ['sheets', 'get', io.spreadsheetId(), `${name}!A1:Z`, '--json']), 'gog').values || [];
  },
  // RAW で書くので、= で始まる文字列も数式として評価されない。
  // 値は標準入力で渡す（引数に載せると、要約などがプロセス一覧から見えてしまう）
  appendRows(name, rows) {
    exec('gog', ['sheets', 'append', io.spreadsheetId(), `${name}!A:A`, '--input', 'RAW', '--insert', 'INSERT_ROWS',
      '--values-json', '-'], { input: JSON.stringify(rows) });
  },
  replaceRows(name, rows) {
    exec('gog', ['sheets', 'clear', io.spreadsheetId(), `${name}!A2:Z`, '--force']);
    exec('gog', ['sheets', 'update', io.spreadsheetId(), `${name}!A2`, '--input', 'RAW', '--values-json', '-'],
      { input: JSON.stringify(rows) });
  },
  // Slack の本文は信頼できない入力なので、何かを実行できる状態では読ませない。
  // ツールなし・MCP なし・設定ファイルなし（利用者・プロジェクトとも読まない）・フックなしで起動し、
  // 作業ディレクトリは毎回新しく作る本人専用の空ディレクトリにする（置かれた設定や CLAUDE.md を拾わない）。
  claude(model, systemPrompt, schema, input) {
    const cwd = mkdtempSync(join(tmpdir(), 'reply-watch-'));
    try {
      const out = parseJson(exec('claude', [
        '-p', '--model', model, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
        '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-session-persistence',
        '--output-format', 'json', '--system-prompt', systemPrompt, '--json-schema', JSON.stringify(schema),
      ], { input, cwd, timeout: CFG.CLAUDE_TIMEOUT_MS }), 'claude');
      if (out.is_error || !out.structured_output) {
        throw new Error(`claude: ${/^[a-z_]{1,40}$/.test(out.subtype || '') ? out.subtype : '出力なし'}`);
      }
      const u = out.usage || {};
      return {
        data: out.structured_output,
        usage: {
          model: Object.keys(out.modelUsage || {}).join(',') || model,
          in: u.input_tokens, out: u.output_tokens,
          cache_create: u.cache_creation_input_tokens, cache_read: u.cache_read_input_tokens,
          cost_usd: out.total_cost_usd, api_ms: out.duration_api_ms, turns: out.num_turns,
        },
      };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
};

// ───────── 共通 ─────────

function table(values) {
  const [header = [], ...rows] = values;
  return rows.filter((r) => r[0]).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function nowJst() {
  return new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 16).replace('T', ' ');
}

function done(name) {
  return new Set(table(io.readSheet(name)).map((r) => `${r.key}|${r.fingerprint}`));
}

/** 件数と文字数の上限でまとめる。 */
export function batches(items, maxItems, maxChars, size) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    const n = size(it);
    if (cur.length && (cur.length >= maxItems || chars + n > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** AI の出力から、頼んだ key に対する最初の結果だけを採用する。 */
function pick(items, wanted) {
  const seen = new Set();
  return (items || []).filter((it) => wanted.has(it.key) && !seen.has(it.key) && seen.add(it.key));
}

/** claude を呼び、利用量と所要時間をログに残す。失敗した時も件数と時間は残す。 */
function callClaude(session, model, system, schema, input, items) {
  const started = Date.now();
  try {
    const { data, usage: u } = io.claude(model, system, schema, input);
    log('INFO', 'claude.call', { session, items, input_chars: input.length, ms: Date.now() - started, ...u });
    return data;
  } catch (e) {
    log('ERROR', 'claude.error', { session, model, items, input_chars: input.length, ms: Date.now() - started, error: errorText(e) });
    throw e;
  }
}

function countBy(rows, i) {
  const n = {};
  rows.forEach((r) => { n[r[i]] = (n[r[i]] || 0) + 1; });
  return Object.entries(n).map(([k, v]) => `${k}:${v}`).join(',');
}

function prune(name) {
  const rows = io.readSheet(name).slice(1);
  if (rows.length > CFG.KEEP_ROWS * 4) {
    io.replaceRows(name, rows.slice(-CFG.KEEP_ROWS));
    log('INFO', 'sheet.pruned', { sheet: name, before: rows.length, kept: CFG.KEEP_ROWS });
  }
}

// ───────── セッション 1: 仕分け ─────────

export function judge() {
  const started = Date.now();
  const judged = done('judgments');
  // 対象外（DM を外している間の DM）は、判定待ちが残っていても AI に渡さない
  const waiting = table(io.readSheet('threads'))
    .filter((r) => r.pending_fp && r.pending_input && r.priority !== '対象外');
  const fresh = waiting.filter((r) => !judged.has(`${r.key}|${r.pending_fp}`));
  const pending = fresh.slice(0, CFG.MAX_PER_RUN);
  // 判定済みで GAS の取り込み待ちの件（waiting - fresh）は、次の scan で反映される
  log('INFO', 'judge.start', {
    waiting: waiting.length, awaiting_import: waiting.length - fresh.length, run: pending.length,
    backlog: fresh.length - pending.length, model: CFG.JUDGE_MODEL,
  });
  if (!pending.length) return 0;
  const system = readFileSync(join(ROOT, 'prompts/judge.md'), 'utf8');
  let count = 0;
  let failed = 0;
  for (const batch of batches(pending, CFG.JUDGE_BATCH_ITEMS, CFG.JUDGE_BATCH_CHARS, (r) => r.pending_input.length)) {
    const threads = [];
    const fp = new Map();
    for (const r of batch) {
      try {
        threads.push({ key: r.key, ...JSON.parse(r.pending_input) });
        fp.set(r.key, r.pending_fp);
      } catch (e) {
        log('WARN', 'judge.bad_input', { key: safe(r.key) });
      }
    }
    if (!threads.length) continue;
    let stage = 'claude';
    try {
      const out = callClaude('judge', CFG.JUDGE_MODEL, system, JUDGE_SCHEMA,
        `現在時刻: ${nowJst()} (JST)\n${JSON.stringify(threads)}`, threads.length);
      const rows = pick(out.items, fp).filter((it) => STATES.includes(it.state)).map((it) =>
        [it.key, fp.get(it.key), it.state, it.summary, it.reason, it.next_action, it.due_at, nowJst()]);
      stage = 'sheet';
      if (rows.length) io.appendRows('judgments', rows);
      count += rows.length;
      log('INFO', 'judge.batch', {
        asked: threads.length, judged: rows.length, missing: threads.length - rows.length,
        states: countBy(rows, 2), with_due: rows.filter((r) => r[6]).length,
      });
    } catch (e) {
      // 失敗した分は判定待ちのまま残り、次の起動でやり直す
      failed++;
      log('ERROR', 'judge.batch_failed', { stage, items: threads.length, error: errorText(e) });
    }
  }
  prune('judgments');
  log('INFO', 'judge.end', { judged: count, failed_batches: failed, ms: Date.now() - started });
  return count;
}

// ───────── セッション 2: 通知の一文 ─────────

export function notice() {
  const started = Date.now();
  const written = done('notices');
  // 対象外（DM を外している間の DM）や打切りの件は通知されないので、一文も作らない
  const all = table(io.readSheet('threads'))
    .filter((r) => OPEN_LABELS.includes(r.state) && r.fingerprint && !['対象外', '打切り'].includes(r.priority));
  const fresh = all.filter((r) => !written.has(`${r.key}|${r.fingerprint}`));
  const open = fresh.slice(0, CFG.MAX_PER_RUN);
  log('INFO', 'notice.start', {
    open: all.length, run: open.length, backlog: fresh.length - open.length, model: CFG.NOTICE_MODEL,
  });
  if (!open.length) return 0;
  const system = readFileSync(join(ROOT, 'prompts/notice.md'), 'utf8');
  let count = 0;
  let failed = 0;
  for (const batch of batches(open, CFG.NOTICE_BATCH_ITEMS, Infinity, () => 0)) {
    const fp = new Map(batch.map((r) => [r.key, r.fingerprint]));
    const input = batch.map((r) => ({
      key: r.key, state: r.state, summary: r.summary, reason: r.reason, next_action: r.next_action,
    }));
    let stage = 'claude';
    try {
      const out = callClaude('notice', CFG.NOTICE_MODEL, system, NOTICE_SCHEMA, JSON.stringify(input), batch.length);
      const rows = pick(out.items, fp).filter((it) => it.line).map((it) => [it.key, fp.get(it.key), it.line, nowJst()]);
      stage = 'sheet';
      if (rows.length) io.appendRows('notices', rows);
      count += rows.length;
      log('INFO', 'notice.batch', { asked: batch.length, written: rows.length, missing: batch.length - rows.length });
    } catch (e) {
      failed++;
      log('ERROR', 'notice.batch_failed', { stage, items: batch.length, error: errorText(e) });
    }
  }
  prune('notices');
  log('INFO', 'notice.end', { written: count, failed_batches: failed, ms: Date.now() - started });
  return count;
}

function printUsage(days) {
  const rows = usage(days);
  if (!rows.length) {
    console.log(`直近 ${days} 日の記録なし（${logFile()}）`);
    return;
  }
  const head = ['日付', '用途', '呼出', '失敗', '件数', '入力', 'cache作成', 'cache読込', '出力', '換算$', '秒'];
  const body = rows.map((r) => [r.date, r.session, r.calls, r.errors, r.items, r.input, r.cache_create, r.cache_read,
    r.output, r.cost_usd.toFixed(4), Math.round(r.sec)]);
  const total = ['合計', '', ...[2, 3, 4, 5, 6, 7, 8].map((i) => body.reduce((s, r) => s + r[i], 0)),
    body.reduce((s, r) => s + Number(r[9]), 0).toFixed(4), body.reduce((s, r) => s + r[10], 0)];
  const all = [head, ...body, total];
  const width = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  all.forEach((r) => console.log(r.map((c, i) => String(c).padStart(width[i])).join('  ')));
  console.log('換算$ は API 料金に換算した参考値（プランでは請求されない）。入力・cache・出力はトークン数');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd === 'usage') {
    printUsage(Number(process.argv[3]) || 7);
  } else if (cmd === 'judge' || cmd === 'notice') {
    const started = Date.now();
    log('INFO', 'run.start', { cmd, pid: process.pid });
    try {
      const n = cmd === 'judge' ? judge() : notice();
      log('INFO', 'run.end', { cmd, done: n, ms: Date.now() - started });
    } catch (e) {
      // シートが読めない等。メッセージは exec / parseJson が決まった文言にしている
      log('ERROR', 'run.failed', { cmd, error: errorText(e), ms: Date.now() - started });
      process.exitCode = 1;
    }
  } else {
    console.error('usage: local-ai.mjs judge|notice|usage [days]');
    process.exit(2);
  }
}
