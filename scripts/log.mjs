// 手元の AI 処理のログ。1 行 1 イベントの「日時 レベル イベント key=value …」形式で、
// 後から集計できるようにする。Slack の本文・要約・通知文は書かない（件数・トークン数・時間・決まった文言だけ）。
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024; // これを超えたら .1 に回す（.1 は 1 世代だけ残す）
const SESSIONS = ['judge', 'notice'];

export function logDir() {
  return resolve(process.env.REPLY_WATCH_LOG_DIR || join(homedir(), 'Library/Logs/reply-watch'));
}

export function logFile() {
  return join(logDir(), 'local-ai.log');
}

function stamp() {
  return new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 19).replace('T', ' ');
}

function fmt(v) {
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  const s = String(v);
  return /^[^\s="]+$/.test(s) ? s : JSON.stringify(s);
}

/**
 * 指定された経路の上位ディレクトリを、書かれたとおりに / まで確かめる。
 * 途中にリンクがある指定は使わない（確かめた経路と書き込む経路がずれないように）。
 * 他人が書き込めるディレクトリの中にあると、確かめた後に差し替えられるので使わない
 * （sticky ビット付きの /tmp のような場所は、他人が差し替えられないので可）。
 */
function checkParents(dir) {
  for (let p = dirname(dir); ; p = dirname(p)) {
    let a;
    try {
      a = lstatSync(p);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      continue; // まだ無い（この後、本人が 0700 で作る）
    }
    if (a.isSymbolicLink()) throw new Error('ログの置き場所の経路にリンクがある');
    if (a.uid !== process.getuid() && a.uid !== 0) throw new Error('ログの置き場所の上位が本人か root の持ち物ではない');
    if ((a.mode & 0o022) && !(a.mode & 0o1000)) throw new Error('ログの置き場所の上位に他人が書き込める');
    if (dirname(p) === p) break;
  }
}

/**
 * ログの置き場所が本人専用か確かめ、確かめた経路を返す。以降の読み書きはこの経路だけを使う。
 * 上位を確かめてから作る・締めるので、信用できない場所では何も作らない。
 */
function safeDir() {
  const dir = logDir();
  checkParents(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkParents(dir); // 作った後の経路も確かめる
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('ログの置き場所がディレクトリではない');
  if (st.uid !== process.getuid()) throw new Error('ログの置き場所が本人の持ち物ではない');
  if (st.mode & 0o077) chmodSync(dir, 0o700);
  return dir;
}

/** リンクを辿らずに開き、本人の通常ファイルであることを確かめる。 */
function openOwn(file, flags) {
  const fd = openSync(file, flags | constants.O_NOFOLLOW, 0o600);
  const st = fstatSync(fd);
  if (!st.isFile() || st.uid !== process.getuid()) {
    closeSync(fd);
    throw new Error('ログファイルが本人の通常ファイルではない');
  }
  return fd;
}

let rotated = false;
let warned = false;

function rotate(file) {
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    return; // まだ無い
  }
  if (st.isFile() && st.uid === process.getuid() && st.size > MAX_BYTES) renameSync(file, `${file}.1`);
}

/** level は INFO / WARN / ERROR。値が undefined や空文字の項目は書かない。 */
export function log(level, event, fields = {}) {
  const parts = [stamp(), level, event];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') parts.push(`${k}=${fmt(v)}`);
  }
  const line = parts.join(' ');
  try {
    const file = join(safeDir(), 'local-ai.log');
    if (!rotated) {
      rotated = true;
      rotate(file);
    }
    const fd = openOwn(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, `${line}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    // ログが書けなくても本来の処理は続ける。理由は一度だけ知らせる（パスは出さない）
    if (!warned) {
      warned = true;
      console.error(`ログを書けない: ${e.code || e.message}`);
    }
  }
  // 手で実行した時は画面にも出す（launchd から動く時は出さない）
  if (process.stdout.isTTY && !process.env.REPLY_WATCH_QUIET) console.log(line);
}

/** 1 行を読む。形の崩れた行は null（集計から外す）。 */
export function parseLine(line) {
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\S+) (\S+)(.*)$/.exec(line);
  if (!m) return null;
  const fields = Object.create(null);
  for (const f of m[4].matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
    try {
      fields[f[1]] = f[2].startsWith('"') ? JSON.parse(f[2]) : f[2];
    } catch (e) {
      return null;
    }
  }
  return { at: m[1], level: m[2], event: m[3], fields };
}

function readOwn(name) {
  let fd;
  try {
    fd = openOwn(join(safeDir(), name), constants.O_RDONLY);
  } catch (e) {
    return '';
  }
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** 直近 days 日（1〜366）のログから、日ごと・用途ごとの claude の利用量をまとめる。 */
export function usage(days = 7) {
  const d = Math.min(366, Math.max(1, Math.floor(Number(days)) || 7));
  const since = new Date(Date.now() + 9 * 36e5 - (d - 1) * 864e5).toISOString().slice(0, 10);
  const lines = ['local-ai.log.1', 'local-ai.log'].flatMap((f) => readOwn(f).split('\n'));
  const rows = new Map();
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  for (const line of lines) {
    const e = parseLine(line);
    if (!e || e.at.slice(0, 10) < since) continue;
    if (e.event !== 'claude.call' && e.event !== 'claude.error') continue;
    const session = SESSIONS.includes(e.fields.session) ? e.fields.session : '-';
    const key = `${e.at.slice(0, 10)} ${session}`;
    const r = rows.get(key) || {
      date: e.at.slice(0, 10), session, calls: 0, errors: 0, items: 0,
      input: 0, cache_create: 0, cache_read: 0, output: 0, cost_usd: 0, sec: 0,
    };
    if (e.event === 'claude.error') r.errors++;
    else {
      r.calls++;
      r.items += num(e.fields.items);
      r.input += num(e.fields.in);
      r.cache_create += num(e.fields.cache_create);
      r.cache_read += num(e.fields.cache_read);
      r.output += num(e.fields.out);
      r.cost_usd += num(e.fields.cost_usd);
    }
    r.sec += num(e.fields.ms) / 1000;
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => (a.date + a.session).localeCompare(b.date + b.session));
}

/** ログに載せるエラー文言。パスなどを含みうる想定外の文言は、エラーコードだけにする。 */
export function errorText(e) {
  const msg = String((e && e.message) || '');
  if (/^[\p{L}\p{N} :_.-]{1,80}$/u.test(msg)) return msg;
  return (e && typeof e.code === 'string' && /^[A-Z_]{1,40}$/.test(e.code)) ? e.code : 'unexpected';
}
