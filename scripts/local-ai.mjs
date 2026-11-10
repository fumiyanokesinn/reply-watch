#!/usr/bin/env node
// 手元の Claude Code（claude -p）で AI の仕事をする。GAS とはスプレッドシートだけでつながる。
//   judge   threads シートの判定待ちを仕分けて judgments シートに追記する
//   notice  仕分け結果だけを読み、通知の一文を作って notices シートに追記する
// 2 つは別々の claude 呼び出し（別セッション）で、互いの入力を見ない。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TOOL_NAMES as EXTERNAL_TOOL_NAMES } from './external-mcp.mjs';
import { errorText, log, logFile, usage } from './log.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CFG = {
  JUDGE_MODEL: process.env.REPLY_WATCH_JUDGE_MODEL || 'sonnet',
  NOTICE_MODEL: process.env.REPLY_WATCH_NOTICE_MODEL || 'haiku',
  JUDGE_BATCH_ITEMS: 4, // 1 回の claude 呼び出しにまとめる件数（多いと別の件の内容に引きずられる）
  JUDGE_BATCH_CHARS: 60000, // 同、入力の文字数上限
  NOTICE_BATCH_ITEMS: 20,
  MAX_PER_RUN: 40, // 1 回の起動で処理する件数（残りは次の起動で）
  VERIFY: process.env.REPLY_WATCH_VERIFY !== '0', // 一次判定で対応が残るとした件を、Slack を調べて確かめる
  VERIFY_MODEL: process.env.REPLY_WATCH_VERIFY_MODEL || 'sonnet',
  VERIFY_BATCH_ITEMS: 4,
  VERIFY_TIMEOUT_MS: 10 * 60 * 1000,
  REVERIFY_HOURS: 24, // GAS が判定し直しに回した件（同じ内容）は、この時間を過ぎた判定だけを古いとみなす
  KEEP_ROWS: 500, // judgments / notices がこの 4 倍を超えたら、新しい方からこの件数だけ残す
  CLAUDE_TIMEOUT_MS: 5 * 60 * 1000,
};

const STATES = ['UNREPLIED', 'PROMISED', 'WAITING_OTHERS', 'DONE', 'NO_ACTION'];
const OPEN_STATES = ['UNREPLIED', 'PROMISED', 'WAITING_OTHERS'];
// 必要な対応の種類。REPLY_ONLY 返事だけ / NOT_STARTED 未着手 / IN_PROGRESS 作業中 / REPORT_ONLY 完了報告だけ / NUDGE 催促 / NONE 対応不要
export const ACTION_TYPES = ['REPLY_ONLY', 'NOT_STARTED', 'IN_PROGRESS', 'REPORT_ONLY', 'NUDGE', 'NONE'];
// 確認していない件は、一次判定の状態から近いものを当てる
const DEFAULT_ACTION = { UNREPLIED: 'NOT_STARTED', PROMISED: 'IN_PROGRESS', WAITING_OTHERS: 'NUDGE' };
const OPEN_LABELS = ['未返信', '返信済み・対応未完了', '相手待ち'];

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          // 根拠と次にやることを先に書かせてから state を決めさせる（出力はこの順に生成される）
          key: { type: 'string' },
          summary: { type: 'string' },
          reason: { type: 'string' },
          next_action: { type: 'string' },
          due_at: { type: 'string' },
          is_review_request_to_me: { type: 'boolean' },
          state: { type: 'string', enum: STATES },
        },
        required: ['key', 'summary', 'reason', 'next_action', 'due_at', 'is_review_request_to_me', 'state'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          note: { type: 'string' },
          ball: { type: 'string' },
          action_type: { type: 'string', enum: ACTION_TYPES },
          still_needed: { type: 'boolean' },
          corrected_state: { type: 'string', enum: ['KEEP', 'DONE', 'NO_ACTION'] },
        },
        required: ['key', 'note', 'ball', 'action_type', 'still_needed', 'corrected_state'],
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

// 本人の Slack MCP。Claude Code の Slack プラグインと同じ名前・定義にして、接続済みの認証をそのまま使う
const SLACK_MCP_NAME = 'plugin:slack:slack';
const SLACK_MCP = {
  type: 'http', url: 'https://mcp.slack.com/mcp', oauth: { clientId: '1601185624273.8899143856786', callbackPort: 3118 },
};
const SLACK_TOOL = (name) => `mcp__plugin_slack_slack__${name}`;
export const SLACK_READ_TOOLS = ['slack_read_thread', 'slack_read_channel', 'slack_search_public_and_private'].map(SLACK_TOOL);
export const SLACK_WRITE_TOOLS = [
  'slack_send_message', 'slack_send_message_draft', 'slack_schedule_message', 'slack_add_reaction',
  'slack_create_canvas', 'slack_update_canvas', 'slack_create_conversation', 'slack_create_list', 'slack_update_list',
  'slack_add_list_record', 'slack_update_list_record', 'slack_get_file_upload_url', 'slack_complete_file_upload',
].map(SLACK_TOOL);

// GitHub と GCP を読むだけの MCP（scripts/external-mcp.mjs）。読める範囲は config.local.json（git 管理外）で決める
const EXTERNAL_MCP_NAME = 'external';
export const EXTERNAL_TOOLS = EXTERNAL_TOOL_NAMES.map((n) => `mcp__${EXTERNAL_MCP_NAME}__${n}`);

function localConfig() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'config.local.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

/** external MCP の起動定義。設定が無ければ使わない。 */
function externalMcp() {
  const c = localConfig();
  const orgs = (c.github_orgs || []).join(',');
  const projects = JSON.stringify(c.gcp_projects || {});
  if (!orgs && projects === '{}') return null;
  return {
    type: 'stdio', command: process.execPath, args: [join(ROOT, 'scripts/external-mcp.mjs')],
    env: {
      REPLY_WATCH_GITHUB_ORGS: orgs, REPLY_WATCH_GCP_PROJECTS: projects,
      REPLY_WATCH_GH: process.env.REPLY_WATCH_GH || 'gh', REPLY_WATCH_GCLOUDA: process.env.REPLY_WATCH_GCLOUDA || 'gclouda',
      PATH: process.env.REPLY_WATCH_TOOL_PATH || process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '',
    },
  };
}

// launchd から動く時は、scripts/launchd.sh が確かめた実行ファイルの絶対パスを環境変数で渡す
const BIN = { claude: process.env.REPLY_WATCH_CLAUDE || 'claude', gog: process.env.REPLY_WATCH_GOG || 'gog' };

// エラーには終了コードなど決まった情報だけを載せる。コマンドの出力には Slack の本文が含まれうるので、ログへ流さない。
export const runner = { spawnSync }; // テストで差し替えて、実際に渡す引数を確かめる

function exec(cmd, args, opts = {}) {
  const res = runner.spawnSync(BIN[cmd], args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
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
  // raw: 日時を書式なしの値（日数のシリアル値）で読む
  readSheet(name, opts = {}) {
    const args = ['sheets', 'get', io.spreadsheetId(), `${name}!A1:AZ`, '--json'];
    if (opts.raw) args.push('--render', 'UNFORMATTED_VALUE');
    return parseJson(exec('gog', args), 'gog').values || [];
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
  //
  // slack: true の時だけ、本人の Slack MCP（Claude Code に接続済みのもの）の読み取りツールを使える。
  // 書き込みのツールは許可せず、明示的に禁止もする。出力はシートにだけ書き、通知の文面には使わない。
  claude(model, systemPrompt, schema, input, opts = {}) {
    const cwd = mkdtempSync(join(tmpdir(), 'reply-watch-'));
    try {
      const args = [
        // dontAsk: 事前に許可したツール以外は、確認を求めずに拒否する
        '-p', '--model', model, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--permission-mode', 'dontAsk',
        '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-session-persistence',
        '--output-format', 'json', '--system-prompt', systemPrompt, '--json-schema', JSON.stringify(schema),
      ];
      if (opts.slack) {
        const servers = { [SLACK_MCP_NAME]: SLACK_MCP };
        const allowed = [...SLACK_READ_TOOLS];
        const external = externalMcp();
        if (external) {
          servers[EXTERNAL_MCP_NAME] = external;
          allowed.push(...EXTERNAL_TOOLS);
        }
        const config = join(cwd, 'mcp.json');
        writeFileSync(config, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
        args.push('--mcp-config', config, '--allowedTools', ...allowed, '--disallowedTools', ...SLACK_WRITE_TOOLS);
      }
      const out = parseJson(exec('claude', args,
        { input, cwd, timeout: opts.timeout || CFG.CLAUDE_TIMEOUT_MS }), 'claude');
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

/** judgments の判定時刻。GAS が判定し直しに回した時刻と比べるので秒まで持つ。 */
function nowJstSec() {
  return new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 19).replace('T', ' ');
}

function nowJst() {
  return new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 16).replace('T', ' ');
}

function done(name) {
  return new Set(table(io.readSheet(name)).map((r) => `${r.key}|${r.fingerprint}`));
}

// judgments の 9 列目。本人が PR のレビューを頼まれている件か（GAS の PR_VALUES と同じ値）
const PR_TO_ME = 'REVIEW_TO_ME';
const PR_OTHER = 'OTHER';
// judgments の 10 列目。判定の版（GAS の CFG.JUDGE_VERSION と揃える。prompts/judge.md の基準を変えたら上げる）
export const JUDGE_VERSION = 5;

/**
 * 今の版の判定の「key|fingerprint」ごとの判定時刻（ミリ秒）の一覧。9 列目が今の版の値でない判定（古い版）は数えない
 * （見出しが付く前でも読めるよう、列の位置で見る）。
 */
function judgedTimes() {
  const times = new Map();
  io.readSheet('judgments').slice(1)
    .filter((r) => r[0] && (r[8] === PR_TO_ME || r[8] === PR_OTHER) && String(r[9]) === String(JUDGE_VERSION))
    .forEach((r) => {
      const k = `${r[0]}|${r[1]}`;
      times.set(k, Math.max(times.get(k) || 0, jstMs(r[7])));
    });
  return times;
}

/**
 * GAS が判定待ちに積んだ時刻（pending_at）以降の判定があれば判定済み。GAS も同じ条件で取り込む。
 * pending_at が読めなければ、REVERIFY_HOURS 以内の判定があれば判定済みとする。
 */
function isJudged(times, r) {
  const at = times.get(`${r.key}|${r.pending_fp}`) || 0;
  const pendingAt = serialMs(r.pending_at);
  return pendingAt ? at + 1000 >= pendingAt : at > Date.now() - CFG.REVERIFY_HOURS * 36e5;
}

/** スプレッドシートの日時のシリアル値（日本時間）をミリ秒にする。 */
function serialMs(v) {
  return typeof v === 'number' && v > 0 ? Math.round((v - 25569) * 864e5 - 9 * 36e5) : 0;
}

function jstMs(text) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/.exec(String(text || ''));
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3] || ':00'}+09:00`) : 0;
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
function callClaude(session, model, system, schema, input, items, opts) {
  const started = Date.now();
  try {
    const { data, usage: u } = io.claude(model, system, schema, input, opts);
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

/**
 * 通知文を作った時の判定を表す識別子（notices の fingerprint 列）。内容が同じでも、
 * 判定し直して状態やボールが変わったら作り直す。GAS の noticeId_ と同じ形。
 */
export function noticeId(r) {
  return `${r.fingerprint}#${r.state}#${r.ball || ''}`;
}

function prune(name) {
  const rows = io.readSheet(name).slice(1);
  if (rows.length > CFG.KEEP_ROWS * 4) {
    io.replaceRows(name, rows.slice(-CFG.KEEP_ROWS));
    log('INFO', 'sheet.pruned', { sheet: name, before: rows.length, kept: CFG.KEEP_ROWS });
  }
}

// ───────── セッション 1: 仕分け ─────────

/** GAS が meta シートに出した判定の版と、この Mac 側の版が同じか確かめる。違えば判定しない（取り込まれず無駄になる）。 */
function checkVersion() {
  const row = io.readSheet('meta').find((r) => r[0] === 'judge_version');
  if (!row) return; // まだ GAS が一度も動いていない
  if (String(row[1]) !== String(JUDGE_VERSION)) {
    throw new Error(`判定の版が GAS と違う GAS ${safe(row[1])} Mac ${JUDGE_VERSION}`);
  }
}

export function judge() {
  const started = Date.now();
  checkVersion();
  const judged = judgedTimes();
  // 対象外（DM を外している間の DM）は、判定待ちが残っていても AI に渡さない
  const waiting = table(io.readSheet('threads', { raw: true }))
    .filter((r) => r.pending_fp && r.pending_input && r.priority !== '対象外');
  const fresh = waiting.filter((r) => !isJudged(judged, r));
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
      const judged = pick(out.items, fp).filter((it) => STATES.includes(it.state));
      const notes = verify(judged, threads);
      const rows = judged.map((it) => {
        const v = notes.get(it.key);
        const state = v && v.corrected_state !== 'KEEP' ? v.corrected_state : it.state;
        return [it.key, fp.get(it.key), state, it.summary, it.reason, it.next_action, it.due_at, nowJstSec(),
          it.is_review_request_to_me === true ? PR_TO_ME : PR_OTHER, JUDGE_VERSION, v ? v.note : '',
          // ボール: 確認できた件はその内容。確認していない（確認を止めている・失敗した）件は一次判定の次にやること
          OPEN_STATES.includes(state) ? (v && v.ball) || it.next_action : '',
          OPEN_STATES.includes(state) ? (v && v.action) || DEFAULT_ACTION[state] : ''];
      });
      stage = 'sheet';
      if (rows.length) io.appendRows('judgments', rows);
      count += rows.length;
      log('INFO', 'judge.batch', {
        asked: threads.length, judged: rows.length, missing: threads.length - rows.length,
        states: countBy(rows, 2), with_due: rows.filter((r) => r[6]).length, review_to_me: rows.filter((r) => r[8] === PR_TO_ME).length,
        verified: notes.size, closed_by_verify: rows.filter((r, i) => r[2] !== judged[i].state).length,
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

/**
 * 一次判定で対応が残る（かつ本人への PR レビュー依頼ではない）とした件を、Slack を調べて確かめる。
 * 結果は state を DONE / NO_ACTION に下げることと、シートに残す根拠（note）だけに使う。
 * 失敗しても一次判定のまま進める（通知を落とさない）。
 */
function verify(judged, threads) {
  const notes = new Map();
  if (!CFG.VERIFY) return notes;
  const me = new Map(threads.map((t) => [t.key, t.me]));
  const targets = judged.filter((it) => OPEN_STATES.includes(it.state) && it.is_review_request_to_me !== true);
  if (!targets.length) return notes;
  const system = readFileSync(join(ROOT, 'prompts/verify.md'), 'utf8');
  for (const batch of batches(targets, CFG.VERIFY_BATCH_ITEMS, Infinity, () => 0)) {
    const wanted = new Set(batch.map((it) => it.key));
    const input = batch.map((it) => ({
      key: it.key, me: me.get(it.key), state: it.state, summary: it.summary, reason: it.reason, next_action: it.next_action,
    }));
    try {
      const out = callClaude('verify', CFG.VERIFY_MODEL, system, VERIFY_SCHEMA,
        `現在時刻: ${nowJst()} (JST)\n${JSON.stringify(input)}`, batch.length, { slack: true, timeout: CFG.VERIFY_TIMEOUT_MS });
      pick(out.items, wanted).forEach((v) => {
        const ok = v.still_needed ? v.corrected_state === 'KEEP' : ['DONE', 'NO_ACTION'].includes(v.corrected_state);
        // 残す件はボールを具体的に書けていること（書けないなら、本人のボールではないとみなして落とす）
        const ball = String(v.ball || '').trim().slice(0, 120);
        if (ok && v.still_needed && !ball) {
          notes.set(v.key, { corrected_state: 'NO_ACTION', note: `ボールを特定できない: ${String(v.note || '').slice(0, 160)}`, ball: '' });
        } else if (ok) {
          const action = ACTION_TYPES.includes(v.action_type) && v.action_type !== 'NONE' ? v.action_type : '';
          notes.set(v.key, { corrected_state: v.corrected_state, note: String(v.note || '').slice(0, 200), ball, action });
        }
      });
      log('INFO', 'verify.batch', {
        asked: batch.length, answered: [...wanted].filter((k) => notes.has(k)).length,
        closed: [...wanted].filter((k) => notes.has(k) && notes.get(k).corrected_state !== 'KEEP').length,
      });
    } catch (e) {
      log('ERROR', 'verify.batch_failed', { items: batch.length, error: errorText(e) });
    }
  }
  return notes;
}

// ───────── セッション 2: 通知の一文 ─────────

export function notice() {
  const started = Date.now();
  const written = done('notices');
  // 対象外（DM を外している間の DM）や打切りの件は通知されないので、一文も作らない
  const all = table(io.readSheet('threads'))
    .filter((r) => OPEN_LABELS.includes(r.state) && r.fingerprint && !['対象外', '打切り'].includes(r.priority));
  const fresh = all.filter((r) => !written.has(`${r.key}|${noticeId(r)}`));
  const open = fresh.slice(0, CFG.MAX_PER_RUN);
  log('INFO', 'notice.start', {
    open: all.length, run: open.length, backlog: fresh.length - open.length, model: CFG.NOTICE_MODEL,
  });
  if (!open.length) return 0;
  const system = readFileSync(join(ROOT, 'prompts/notice.md'), 'utf8');
  let count = 0;
  let failed = 0;
  for (const batch of batches(open, CFG.NOTICE_BATCH_ITEMS, Infinity, () => 0)) {
    const fp = new Map(batch.map((r) => [r.key, noticeId(r)]));
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
