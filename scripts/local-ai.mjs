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

// エラーには終了コードなど決まった情報だけを載せる。コマンドの出力には Slack の本文が含まれうるので、ログへ流さない。
function exec(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
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
      return out.structured_output;
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

function prune(name) {
  const rows = io.readSheet(name).slice(1);
  if (rows.length > CFG.KEEP_ROWS * 4) io.replaceRows(name, rows.slice(-CFG.KEEP_ROWS));
}

// ───────── セッション 1: 仕分け ─────────

export function judge() {
  const judged = done('judgments');
  const pending = table(io.readSheet('threads'))
    .filter((r) => r.pending_fp && r.pending_input && !judged.has(`${r.key}|${r.pending_fp}`))
    .slice(0, CFG.MAX_PER_RUN);
  if (!pending.length) return 0;
  const system = readFileSync(join(ROOT, 'prompts/judge.md'), 'utf8');
  let count = 0;
  for (const batch of batches(pending, CFG.JUDGE_BATCH_ITEMS, CFG.JUDGE_BATCH_CHARS, (r) => r.pending_input.length)) {
    const threads = [];
    const fp = new Map();
    for (const r of batch) {
      try {
        threads.push({ key: r.key, ...JSON.parse(r.pending_input) });
        fp.set(r.key, r.pending_fp);
      } catch (e) {
        console.error(`入力を読めない: ${safe(r.key)}`);
      }
    }
    if (!threads.length) continue;
    try {
      const out = io.claude(CFG.JUDGE_MODEL, system, JUDGE_SCHEMA, `現在時刻: ${nowJst()} (JST)\n${JSON.stringify(threads)}`);
      const rows = pick(out.items, fp).filter((it) => STATES.includes(it.state)).map((it) =>
        [it.key, fp.get(it.key), it.state, it.summary, it.reason, it.next_action, it.due_at, nowJst()]);
      if (rows.length) io.appendRows('judgments', rows);
      count += rows.length;
    } catch (e) {
      // 失敗した分は判定待ちのまま残り、次の起動でやり直す
      console.error(`仕分け失敗（${threads.length} 件）: ${e.message}`);
    }
  }
  prune('judgments');
  return count;
}

// ───────── セッション 2: 通知の一文 ─────────

export function notice() {
  const written = done('notices');
  const open = table(io.readSheet('threads'))
    .filter((r) => OPEN_LABELS.includes(r.state) && r.fingerprint && !written.has(`${r.key}|${r.fingerprint}`))
    .slice(0, CFG.MAX_PER_RUN);
  if (!open.length) return 0;
  const system = readFileSync(join(ROOT, 'prompts/notice.md'), 'utf8');
  let count = 0;
  for (const batch of batches(open, CFG.NOTICE_BATCH_ITEMS, Infinity, () => 0)) {
    const fp = new Map(batch.map((r) => [r.key, r.fingerprint]));
    const input = batch.map((r) => ({
      key: r.key, state: r.state, summary: r.summary, reason: r.reason, next_action: r.next_action,
    }));
    try {
      const out = io.claude(CFG.NOTICE_MODEL, system, NOTICE_SCHEMA, JSON.stringify(input));
      const rows = pick(out.items, fp).filter((it) => it.line).map((it) => [it.key, fp.get(it.key), it.line, nowJst()]);
      if (rows.length) io.appendRows('notices', rows);
      count += rows.length;
    } catch (e) {
      console.error(`通知文の作成失敗（${batch.length} 件）: ${e.message}`);
    }
  }
  prune('notices');
  return count;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  // 5 分毎に動くので、何もしなかった回はログを出さない
  const report = (label, n) => { if (n) console.log(`${nowJst()} ${label}: ${n} 件`); };
  if (cmd === 'judge') report('仕分け', judge());
  else if (cmd === 'notice') report('通知文', notice());
  else {
    console.error('usage: local-ai.mjs judge|notice');
    process.exit(2);
  }
}
