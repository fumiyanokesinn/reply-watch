/**
 * reply-watch: Slack の未返信・対応未完了を仕分けて貯め、放置されたら通知する。
 *
 * AI は手元の Mac の Claude Code が担当し、GAS とはスプレッドシートだけでつながる。
 *   GAS    scan()                        Slack を読み、変化のあったスレッドを「判定待ち」として threads シートに積む
 *   Mac    scripts/local-ai.mjs judge    判定待ちを読んで仕分け、judgments シートに書く（セッション 1）
 *   Mac    scripts/local-ai.mjs notice   仕分け結果だけを読んで通知の一文を作り、notices シートに書く（セッション 2）
 *   GAS    notifyStale() / morningDigest()  判定結果を取り込み、優先度を付けて bot で投稿する
 *
 * 設定は下の CFG（リポジトリで管理）。秘密の値と公開したくない ID はスクリプトプロパティに置く:
 *   SLACK_USER_TOKEN   xoxp-…  読み取り用（search:read, *:history, usergroups:read, channels:read, groups:read。後ろ 2 つは全体宛の絞り込みで参加チャンネルを読む）
 *   SLACK_BOT_TOKEN    xoxb-…  通知投稿用（chat:write）。本人名義で投稿すると通知が鳴らないため bot で投稿する
 *   NOTIFY_CHANNEL_ID  通知先チャンネル ID（bot を招待しておく）
 *   IGNORE_CHANNEL_IDS 任意。監視対象外にするチャンネル ID（カンマ区切り）
 *   EXCLUDE_BOT_IDS    任意。この bot（bot ID の B… か、bot のユーザー ID の U…）が始めたスレッドは対象外（カンマ区切り）
 */

const CFG = {
  // 本人が PR のレビューを頼まれている件を対象外にする（別のアラートで扱う）。本人が頼んだ側の件は対象のまま
  EXCLUDE_PR_REVIEW: true,
  // 判定の版。prompts/judge.md の基準を変えたら上げる（scripts/local-ai.mjs の JUDGE_VERSION と揃える）。
  // 版の違う判定は取り込まず、対応が残っている件は判定し直す
  JUDGE_VERSION: 6,
  REVERIFY_HOURS: 24, // 対応が残っている件は、判定からこの時間が経つと Slack を調べ直す（scripts/local-ai.mjs と揃える）
  INCLUDE_DM: false, // DM（グループ DM 含む）を対象にするか。false の間は拾わず、既にある DM の件も追跡・通知しない
  DONE_REACTIONS: ['done', 'white_check_mark'], // 本人が付けたら対応完了として扱うリアクション
  // 通知の各件に付ける番号。本人が通知にこのリアクションを付けたら、その件を閉じる（スレッドに新しい動きがあれば戻る）
  CLOSE_REACTIONS: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'keycap_ten'],
  POSTS_KEEP_DAYS: 3, // 通知へのリアクションを読む期間
  LOOKBACK_DAYS: 14, // 新規に拾う範囲（追跡を打ち切る GIVE_UP_DAYS と揃える）
  REMIND_AFTER_HOURS: 3, // 自分の対応待ち: 個別リマインドまでの放置時間（優先度「中」になる時間でもある）
  RENOTIFY_AFTER_HOURS: 4, // 個別通知（または朝のまとめ）から対応がないまま、この時間が経ったらもう一度知らせる
  MAX_RENOTIFY: 1, // その再通知の回数（翌朝のまとめで数え直す）
  NUDGE_AFTER_HOURS: 24, // 相手待ち: 催促候補として通知するまでの時間（同上）
  HIGH_AFTER_HOURS: { mine: 24, waiting: 72 }, // 優先度「高」になる放置時間
  DUE_SOON_HOURS: 24, // 期限までこの時間を切ったら優先度「高」にして、放置時間に関わらず通知する
  DUE_NEAR_HOURS: 72, // 期限までこの時間を切ったら優先度「中」以上
  GIVE_UP_DAYS: 14, // 動きがないままこの日数を過ぎた件は追跡と通知をやめる（シートには残る）
  MAX_NOTICE_ITEMS: 10, // 1 通に載せる件数の上限（優先度順）。番号のリアクションの数まで
  WORK_START_HOUR: 10, // 個別リマインドを出す時間帯（平日のみ）
  WORK_END_HOUR: 19,
  RECHECK_CLOSED_HOURS: 6, // 完了・対応不要のスレッドを読み直す間隔
  PRUNE_CLOSED_DAYS: 30, // 完了・対応不要の行をシートから消すまでの日数
  MAX_THREAD_MESSAGES: 40,
  MAX_MESSAGE_CHARS: 800,
  PENDING_TTL_HOURS: 72, // 判定待ちのまま Mac 側で判定されない本文は、この時間で消す（次の取得で積み直す）
  MAX_INPUT_CHARS: 40000, // 判定待ちとして 1 セルに積む JSON の上限（セルの上限は 5 万字）
  TIME_BUDGET_MS: 4.5 * 60 * 1000, // GAS の 6 分制限に対する打ち切り時間
  SLACK_INTERVAL_MS: 1200, // history 系 API の呼び出し間隔（Tier 3 = 50回/分）
  CHANNELS_CACHE_SECONDS: 6 * 3600, // 参加チャンネル一覧をキャッシュする時間（CacheService の上限は 6 時間）
  CHANNELS_CACHE_CHUNK: 3000, // キャッシュ 1 キーに入れる ID の数（1 キー 100KB の上限に余裕を持たせる）
  SHEET_NAME: 'threads',
  JUDGMENTS_SHEET: 'judgments', // Mac 側だけが追記する
  NOTICES_SHEET: 'notices', // Mac 側だけが追記する
  POSTS_SHEET: 'posts', // GAS だけが書く。投稿した通知と、その番号の件
  TZ: 'Asia/Tokyo',
};

const STATE = {
  UNREPLIED: '未返信',
  PROMISED: '返信済み・対応未完了',
  WAITING_OTHERS: '相手待ち',
  DONE: '対応完了',
  NO_ACTION: '対応不要',
};
const MINE_STATES = ['UNREPLIED', 'PROMISED']; // 自分が動く番
const OPEN_STATES = MINE_STATES.concat('WAITING_OTHERS'); // 追跡して通知する対象
const PRIORITY_RANK = { 高: 0, 中: 1, 低: 2 };
const GAVE_UP = '打切り';
const EXCLUDED = '対象外';
// pr_review 列の値。本人が PR のレビューを頼まれている件か、それ以外か（判定の版を兼ねる）
const PR_TO_ME = 'REVIEW_TO_ME';
const PR_OTHER = 'OTHER';
const PR_VALUES = [PR_TO_ME, PR_OTHER];
// 必要な対応の種類（scripts/local-ai.mjs の ACTION_TYPES と同じ）と、通知での表示
const ACTION_LABELS = {
  REPLY_ONLY: '返事だけ', NOT_STARTED: '未着手', IN_PROGRESS: '作業中', REPORT_ONLY: '完了報告だけ', NUDGE: '催促',
};

const COLS = [
  'key', 'kind', 'permalink', 'state', 'priority', 'summary', 'reason', 'next_action',
  'due_at', 'pending_since', 'latest_ts', 'fingerprint', 'judged_at', 'checked_at',
  'last_notified_at', 'notify_count', 'mute', 'pending_fp', 'pending_input', 'renotify_count', 'dm', 'pr_review', 'pending_at', 'judge_version', 'verify_note', 'ball', 'action_type', 'closed_fp',
];
const JUDGMENT_COLS = ['key', 'fingerprint', 'state', 'summary', 'reason', 'next_action', 'due_at', 'judged_at', 'pr_review', 'judge_version', 'verify_note', 'ball', 'action_type'];
const NOTICE_COLS = ['key', 'fingerprint', 'line', 'written_at'];
const POST_COLS = ['ts', 'posted_at', 'items']; // items は [{ key, fp }] の JSON（番号の順）
const META_SHEET = 'meta'; // GAS が書き、Mac 側が読む設定（判定の版など）
const META_COLS = ['name', 'value'];

// ───────────────────────── 収集（GAS） ─────────────────────────

function scan() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const started = Date.now();
  const timeUp = () => Date.now() - started > CFG.TIME_BUDGET_MS;
  const store = loadStore_();
  const stat = {
    候補: 0, 対象: 0, 取得: 0, 変化なし: 0, 判定待ちに追加: 0, 規則で完了: 0, 規則で対応不要: 0,
    判定取り込み: 0, 取得失敗: 0, 時間切れで次回: 0, 除外botのスレッド: 0, 閉じた: 0,
  };
  try {
    ensureSheet_(CFG.NOTICES_SHEET, NOTICE_COLS); // Mac 側が追記できるよう先に用意しておく
    writeMeta_();
    stat.判定取り込み = applyJudgments_(store);
    const me = myUserId_();
    stat.閉じた = applyCloseActions_(store, me);
    const groups = myGroups_(me);
    const dmFlags = new Map();
    const cands = collectCandidates_(me, groups, dmFlags, timeUp);
    // dm 列の無い古い行は、検索で見えた時に DM かどうかを記録する（DM を外していても判別のために見る）
    dmFlags.forEach((isDm, key) => {
      const row = store.get(key);
      if (row && row.dm !== true && row.dm !== false) row.dm = isDm;
    });
    const targets = pickTargets_(cands, store);
    stat.候補 = cands.size;
    stat.対象 = targets.length;
    for (let i = 0; i < targets.length; i++) {
      const row = targets[i];
      if (timeUp()) {
        stat.時間切れで次回 = targets.length - i;
        break;
      }
      let unit;
      try {
        unit = fetchUnit_(row, me);
      } catch (e) {
        console.warn(`取得失敗 ${e.message}`);
        stat.取得失敗++;
        continue;
      }
      row.checked_at = new Date();
      stat.取得++;
      // 除外 bot のスレッドは、内容が変わっていなくても対応不要にして判定待ちも消す（設定を後から足した場合も効くように）
      if (unit && unit.excludedBot) {
        if (row.state !== STATE.NO_ACTION || row.fingerprint !== unit.fingerprint || row.pending_fp) {
          stat.除外botのスレッド++;
          row.latest_ts = unit.latestDate;
          applyJudgment_(row, unit.fingerprint, {
            state: 'NO_ACTION', summary: '除外する bot の投稿', reason: 'EXCLUDE_BOT_IDS の bot が始めたスレッド', next_action: '', due_at: '', pr_review: PR_OTHER,
          });
        } else {
          stat.変化なし++;
        }
        continue;
      }
      const unchanged = unit && (unit.fingerprint === row.fingerprint || unit.fingerprint === row.pending_fp);
      if (!unit || (unchanged && !needsRejudge_(row))) {
        stat.変化なし++;
        continue;
      }
      // 相手待ちのまま新しい発言があった（催促した、相手が途中経過を返した）場合は、そこから数え直す
      if (isOpen_(row) && !isMine_(row) && unit.latestDate.getTime() > toMs_(row.latest_ts)) {
        row.pending_since = unit.latestDate;
        row.last_notified_at = '';
        row.renotify_count = 0;
      }
      row.latest_ts = unit.latestDate;
      if (unit.doneByReaction) {
        stat.規則で完了++;
        applyJudgment_(row, unit.fingerprint, {
          state: 'DONE', summary: row.summary || '（要約なし）', reason: '本人が完了のリアクションを付けた', next_action: '', due_at: '', pr_review: PR_OTHER,
        });
      } else if (!unit.needsAi) {
        stat.規則で対応不要++;
        applyJudgment_(row, unit.fingerprint, {
          state: 'NO_ACTION', summary: 'bot 投稿のみ', reason: '人の発言がないため AI 判定を省略', next_action: '', due_at: '', pr_review: PR_OTHER,
        });
      } else {
        // 判定は Mac 側に任せる。結果が judgments シートに書かれるまで、状態は前回のまま
        stat.判定待ちに追加++;
        if (row.pending_fp !== unit.fingerprint) row.pending_at = new Date();
        row.pending_fp = unit.fingerprint;
        row.pending_input = JSON.stringify({
          me: me, groups: groups, done_reactions: CFG.DONE_REACTIONS,
          kind: row.kind === 'dm' ? 'DM の直近のやり取り' : 'スレッド', messages: unit.messages,
        });
      }
    }
  } finally {
    saveStore_(store);
    lock.releaseLock();
    const rows = Array.from(store.values());
    stat.判定待ち合計 = rows.filter((r) => r.pending_fp).length;
    stat.対応待ち = rows.filter((r) => isActive_(r, Date.now())).length;
    stat.秒 = Math.round((Date.now() - started) / 1000);
    console.log(`scan ${logFields_(stat)}`);
  }
}

/** Mac 側が judgments シートに書いた判定のうち、いま判定待ちの内容に対するものを取り込む。 */
function applyJudgments_(store) {
  let applied = 0;
  readRows_(CFG.JUDGMENTS_SHEET, JUDGMENT_COLS).forEach((j) => {
    // pr_review の無い（または形式の違う）判定は古い版の結果。取り込むと判定し直しが終わらないので使わない
    if (PR_VALUES.indexOf(j.pr_review) < 0 || String(j.judge_version) !== String(CFG.JUDGE_VERSION)) return;
    const row = store.get(j.key);
    if (!row || !row.pending_fp || row.pending_fp !== j.fingerprint) return;
    // 判定し直しに回した後の判定だけを使う（同じ内容に対する前の判定を取り込まない）
    if (row.pending_at && jstMs_(j.judged_at) + 1000 < toMs_(row.pending_at)) return;
    try {
      applyJudgment_(row, j.fingerprint, j);
      applied++;
    } catch (e) {
      console.warn(`判定の取り込み失敗 ${e.message}`);
    }
  });
  return applied;
}

/** 本人が所属するユーザーグループ。取得できなければグループメンションなしで続ける。 */
function myGroups_(me) {
  try {
    return slack_('usergroups.list', { include_users: true }).usergroups
      .filter((g) => (g.users || []).indexOf(me) >= 0)
      .map((g) => ({ id: g.id, handle: g.handle }));
  } catch (e) {
    console.warn(`ユーザーグループ取得失敗、グループメンションは拾わない: ${e.message}`);
    return [];
  }
}

/**
 * 本人が参加しているチャンネルの ID（public / private）。全体宛（@channel など）の絞り込みに使う。
 * CacheService に ID をカンマ区切りで、CFG.CHANNELS_CACHE_CHUNK 個ずつ分けて持つ（1 キー 100KB の上限対策）。
 * 取得できなければ null（スコープ不足の missing_scope を含む）。ページ送りの途中で時間切れになった時も null（途中までの一覧は使わず、キャッシュもしない）。
 * 呼び出し側は全体宛の経路だけを止める。
 */
function myChannelIds_(timeUp) {
  const cache = cacheService_();
  try {
    const n = cache && Number(cache.get('my_channels_n'));
    if (n > 0) {
      const parts = [];
      for (let i = 0; i < n; i++) {
        const part = cache.get(`my_channels_${i}`);
        if (part === null || part === undefined) { parts.length = 0; break; }
        parts.push(part);
      }
      if (parts.length === n) return new Set(parts.join(',').split(',').filter(String));
    }
  } catch (e) {
    console.warn(`参加チャンネルのキャッシュ読み取り失敗、取り直す: ${e.message}`);
  }
  const ids = [];
  try {
    let cursor = '';
    for (let page = 0; page < 50; page++) {
      if (page) {
        if (timeUp && timeUp()) {
          console.warn('参加チャンネル取得が時間切れ、全体宛は次回に回す');
          return null;
        }
        Utilities.sleep(CFG.SLACK_INTERVAL_MS);
      }
      const params = { types: 'public_channel,private_channel', exclude_archived: true, limit: 200 };
      if (cursor) params.cursor = cursor;
      const res = slack_('users.conversations', params);
      (res.channels || []).forEach((c) => c && c.id && ids.push(c.id));
      cursor = (res.response_metadata && res.response_metadata.next_cursor) || '';
      if (!cursor) break;
    }
  } catch (e) {
    console.warn(`参加チャンネル取得失敗、全体宛は拾わない: ${e.message}`);
    return null;
  }
  try {
    if (cache) {
      const chunks = [];
      for (let i = 0; i < ids.length; i += CFG.CHANNELS_CACHE_CHUNK) chunks.push(ids.slice(i, i + CFG.CHANNELS_CACHE_CHUNK).join(','));
      // 前回の個数を先に消し、本体、最後に個数の順に書く。途中で失敗しても個数が無ければ読まれず、古い個数で新旧の chunk が混ざらない
      cache.remove('my_channels_n');
      chunks.forEach((c, i) => cache.put(`my_channels_${i}`, c, CFG.CHANNELS_CACHE_SECONDS));
      cache.put('my_channels_n', String(chunks.length), CFG.CHANNELS_CACHE_SECONDS);
    }
  } catch (e) {
    console.warn(`参加チャンネルのキャッシュ書き込み失敗: ${e.message}`);
  }
  return new Set(ids);
}

function cacheService_() {
  try {
    return CacheService.getScriptCache();
  } catch (e) {
    return null;
  }
}

/** search.messages で「自分宛・所属グループ宛・全体宛メンション / DM / 自分の発言」を含むスレッドを集める。 */
function collectCandidates_(me, groups, dmFlags, timeUp) {
  const after = Utilities.formatDate(
    new Date(Date.now() - (CFG.LOOKBACK_DAYS + 1) * 864e5), CFG.TZ, 'yyyy-MM-dd');
  // ログには ID を含む検索語ではなく、経路の名前だけを出す
  const queries = [
    { label: '自分宛メンション', q: `<@${me}> after:${after}` },
  ].concat(CFG.INCLUDE_DM ? [{ label: 'DM', q: `is:dm after:${after}` }] : []).concat([
    { label: '自分の発言', q: `from:<@${me}> after:${after}` },
  ]).concat(groups.map((g, i) => ({ label: `グループ宛${i + 1}`, q: `<!subteam^${g.id}> after:${after}` })))
    // 全体宛は最後（時間切れの時は既存の経路を優先）。本人が参加しているチャンネルの投稿だけを拾う
    .concat(['channel', 'here', 'everyone'].map((w) => ({ label: `全体宛(${w})`, q: `<!${w}> after:${after}`, broadcast: true })));
  const ignored = ignoredChannels_();
  const cands = new Map();
  let joined; // undefined = まだ取っていない、null = 取得失敗（全体宛の経路は止める）
  for (const { label, q: query, broadcast } of queries) {
    if (broadcast) {
      if (timeUp && timeUp()) break;
      if (joined === undefined) joined = myChannelIds_(timeUp);
      if (!joined) break;
    }
    let count = 0;
    let kept = 0; // 全体宛: 参加チャンネルで絞った後に残った件数
    let capped = false; // 5 ページ読んでも続きがある
    for (let page = 1; page <= 5; page++) {
      if (timeUp && timeUp()) break; // 残りは次回（取得の時間を残す）
      const res = slack_('search.messages', {
        query: query, count: 100, page: page, sort: 'timestamp', sort_dir: 'desc',
      });
      const matches = (res.messages && res.messages.matches) || [];
      count += matches.length;
      for (const m of matches) {
        const ch = m.channel || {};
        if (!ch.id || ignored.has(ch.id)) continue;
        if (broadcast && !joined.has(ch.id)) continue;
        kept++;
        const threadTs = (/[?&]thread_ts=([\d.]+)/.exec(m.permalink || '') || [])[1];
        const isDm = Boolean(ch.is_im || ch.is_mpim || ch.id.charAt(0) === 'D');
        const key = isDm && !threadTs ? `${ch.id}:dm` : `${ch.id}:${threadTs || m.ts}`;
        if (dmFlags) dmFlags.set(key, isDm);
        if (isDm && !CFG.INCLUDE_DM) continue;
        const matchMs = tsToMs_(m.ts);
        const prev = cands.get(key);
        if (!prev || matchMs > prev.matchMs) {
          cands.set(key, { key: key, kind: isDm && !threadTs ? 'dm' : 'thread', dm: isDm, permalink: m.permalink, matchMs: matchMs });
        }
      }
      const paging = (res.messages && res.messages.paging) || {};
      if (!matches.length || page >= (paging.pages || 1)) break;
      if (page === 5) capped = true;
    }
    if (broadcast && capped) console.warn(`検索 経路=${label} 全体宛の検索が上限に達した、古い分は拾えていない`);
    console.log(`検索 経路=${label} 件数=${count}${broadcast ? ` 参加チャンネル分=${kept}` : ''}`); // 0 件の経路があれば、その検索は拾えていない
  }
  return cands;
}

/** 読み直す対象を決める。新着があるもの → 未完了のもの → しばらく見ていない完了済み、の順。 */
function pickTargets_(cands, store) {
  const fresh = [];
  for (const c of cands.values()) {
    let row = store.get(c.key);
    if (!row) {
      row = newRow_(c);
      store.set(c.key, row);
    }
    row.dm = c.dm;
    if (isMuted_(row) || isExcluded_(row)) continue;
    if ((!row.fingerprint && !row.pending_fp) || c.matchMs > toMs_(row.latest_ts)) {
      row.permalink = c.permalink;
      fresh.push(row);
    }
  }
  const picked = new Set(fresh);
  const open = [];
  const closed = [];
  const now = Date.now();
  for (const row of store.values()) {
    if (picked.has(row) || isMuted_(row) || isExcluded_(row)) continue;
    if (isActive_(row, now)) {
      open.push(row);
    } else if (!isOpen_(row) && now - toMs_(row.latest_ts) < CFG.LOOKBACK_DAYS * 864e5 &&
               now - toMs_(row.checked_at) > CFG.RECHECK_CLOSED_HOURS * 36e5) {
      closed.push(row);
    }
  }
  // 時間切れで毎回同じ件だけが後回しにならないよう、長く見ていない順に読む
  const byChecked = (a, b) => toMs_(a.checked_at) - toMs_(b.checked_at);
  return fresh.concat(open.sort(byChecked), closed.sort(byChecked));
}

/** スレッド（または DM の直近のやり取り）を取得し、判定用テキストと変化検知用の指紋を作る。 */
function fetchUnit_(row, me) {
  const sep = row.key.lastIndexOf(':');
  const channel = row.key.slice(0, sep);
  const rootTs = row.key.slice(sep + 1);
  let messages;
  let followUps = [];
  Utilities.sleep(CFG.SLACK_INTERVAL_MS);
  if (row.kind === 'dm') {
    // 追跡中の件は、きっかけの発言が取得範囲から外れないよう、止まった時刻を基準にさかのぼる
    const base = isOpen_(row) && row.pending_since ? Math.min(Date.now(), toMs_(row.pending_since)) : Date.now();
    const oldest = String(Math.floor(base / 1000) - CFG.LOOKBACK_DAYS * 86400);
    messages = slack_('conversations.history', { channel: channel, oldest: oldest, limit: 50 }).messages.reverse();
  } else {
    messages = slack_('conversations.replies', { channel: channel, ts: rootTs, limit: 200 }).messages;
    if (messages.length === 1 && !messages[0].reply_count) {
      // スレッド化されていない投稿は、直後 2 時間のチャンネル投稿も文脈として渡す（スレッド外で返信した場合のため）
      Utilities.sleep(CFG.SLACK_INTERVAL_MS);
      followUps = slack_('conversations.history', {
        channel: channel, oldest: rootTs, latest: String(parseFloat(rootTs) + 7200), limit: 15,
      }).messages.reverse();
    }
  }
  const all = messages.concat(followUps);
  if (!all.length) return null;

  const myReactions = [];
  all.forEach((m) => (m.reactions || []).forEach((r) => {
    if ((r.users || []).indexOf(me) >= 0) myReactions.push(`${m.ts}:${r.name}`);
  }));
  const latestTs = all[all.length - 1].ts;
  const isHuman = (m) => !m.bot_id && m.user;
  // 他の人の最後の発言、またはそれ以降に本人が完了リアクションを付けていれば、AI を通さず完了にする。
  // それより前の発言に付いている場合は、後から来た依頼が残っているかもしれないので AI に読ませる。
  const excludedBots = excludedBots_();
  const first = messages[0] || {};
  // U… の指定は bot の投稿（bot_id のある発言）にだけ当てる。人の ID を誤って入れても、その人のスレッドは除外しない
  const excludedBot = excludedBots.has(first.bot_id) || (Boolean(first.bot_id) && excludedBots.has(first.user));
  const lastOther = all.filter((m) => isHuman(m) && m.user !== me).pop();
  const doneByReaction = all.some((m) =>
    (!lastOther || tsToMs_(m.ts) >= tsToMs_(lastOther.ts)) &&
    (m.reactions || []).some((r) => CFG.DONE_REACTIONS.indexOf(r.name) >= 0 && (r.users || []).indexOf(me) >= 0));
  return {
    excludedBot: excludedBot,
    doneByReaction: doneByReaction,
    fingerprint: `${all.length}|${latestTs}|${myReactions.join(',')}`,
    latestDate: new Date(tsToMs_(latestTs)),
    needsAi: all.some(isHuman),
    messages: fitInput_(renderMessages_(messages, me, false).concat(renderMessages_(followUps, me, true))),
  };
}

/** 発言を「話者・時刻・本文」に分けた配列にする。本文の中で話者や区切りを偽装されても混ざらない。 */
function renderMessages_(messages, me, outsideThread) {
  let list = messages;
  let omitted = 0;
  if (list.length > CFG.MAX_THREAD_MESSAGES) {
    omitted = list.length - CFG.MAX_THREAD_MESSAGES;
    list = [list[0]].concat(list.slice(-(CFG.MAX_THREAD_MESSAGES - 1)));
  }
  const items = list.map((m) => {
    let text = m.text || '';
    if (text.length > CFG.MAX_MESSAGE_CHARS) text = text.slice(0, CFG.MAX_MESSAGE_CHARS) + '…（以下省略）';
    const item = {
      at: Utilities.formatDate(new Date(tsToMs_(m.ts)), CFG.TZ, 'MM/dd HH:mm'),
      speaker: m.user === me ? '本人' : m.bot_id ? `bot(${m.username || m.bot_id})` : `他者(${m.user})`,
      text: text,
    };
    if (m.files && m.files.length) item.has_files = true;
    const mine = (m.reactions || []).filter((r) => (r.users || []).indexOf(me) >= 0).map((r) => r.name);
    if (mine.length) item.reactions_by_me = mine;
    // 本人以外のリアクション（了承の返事として扱えるように、名前と人数だけ）
    const others = (m.reactions || []).map((r) => ({ name: r.name, count: (r.users || []).filter((u) => u !== me).length }))
      .filter((r) => r.count > 0);
    if (others.length) item.reactions_by_others = others;
    if (outsideThread) item.outside_thread = true;
    return item;
  });
  if (omitted) items.splice(1, 0, { omitted_messages: omitted });
  return items;
}

/** 1 セルに収まるよう、長すぎる場合は先頭（きっかけの発言）を残して古い順に間引く。 */
function fitInput_(items) {
  let omitted = 0;
  while (items.length > 3 && JSON.stringify(items).length > CFG.MAX_INPUT_CHARS) {
    items.splice(1, 1);
    omitted++;
  }
  if (omitted) items.splice(1, 0, { omitted_messages: omitted });
  return items;
}

/** 判定（Mac 側の AI、または GAS 内の決まった規則）を行に反映する。 */
function applyJudgment_(row, fingerprint, j) {
  const state = String(j.state).toUpperCase();
  if (!STATE[state]) throw new Error('未知の state');
  const changed = STATE[state] !== row.state;
  row.state = STATE[state];
  row.summary = String(j.summary || '').slice(0, 200);
  row.reason = String(j.reason || '').slice(0, 300);
  row.next_action = String(j.next_action || '').slice(0, 200);
  row.fingerprint = fingerprint;
  row.pending_fp = '';
  row.pending_input = '';
  row.pending_at = '';
  row.judged_at = new Date();
  if (!isOpen_(row)) {
    row.pending_since = '';
  } else if (changed) {
    // 未返信なら最後の発言時刻、対応未完了なら本人が「やります」と言った時刻、
    // 相手待ちなら本人が最後に返した時刻から経過時間を数える
    row.pending_since = row.latest_ts;
    row.last_notified_at = '';
    row.renotify_count = 0;
    row.notify_count = 0;
  }
  row.due_at = parseDue_(j.due_at);
  row.pr_review = j.pr_review;
  row.judge_version = j.judge_version || CFG.JUDGE_VERSION;
  row.verify_note = String(j.verify_note || '').slice(0, 300);
  row.ball = isOpen_(row) ? String(j.ball || j.next_action || '').slice(0, 200) : '';
  row.action_type = isOpen_(row) && ACTION_LABELS[j.action_type] ? j.action_type : '';
  row.priority = priority_(row, Date.now());
}

/** 「yyyy-MM-dd HH:mm」（日本時間）を Date にする。形式が違う・実在しない日時は期限なしとして扱う。 */
function parseDue_(text) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(String(text || '').trim());
  if (!m) return '';
  const date = new Date(`${m[1]}T${m[2]}:00+09:00`);
  if (isNaN(date.getTime())) return '';
  // 2026-02-31 のような日付が別の日に繰り上がっていないことを確かめる
  const back = new Date(date.getTime() + 9 * 36e5).toISOString();
  return back.slice(0, 10) === m[1] && back.slice(11, 16) === m[2] ? date : '';
}

/** 期限までの残り時間と、止まってからの経過時間で優先度を決める。 */
function priority_(row, nowMs) {
  if (isExcluded_(row)) return EXCLUDED;
  if (!isOpen_(row)) return '';
  if (!isActive_(row, nowMs)) return GAVE_UP;
  const kind = isMine_(row) ? 'mine' : 'waiting';
  const elapsed = elapsedHours_(toMs_(row.pending_since), nowMs);
  const untilDue = row.due_at ? (toMs_(row.due_at) - nowMs) / 36e5 : Infinity;
  if (untilDue <= CFG.DUE_SOON_HOURS || elapsed >= CFG.HIGH_AFTER_HOURS[kind]) return '高';
  if (untilDue <= CFG.DUE_NEAR_HOURS || elapsed >= notifyAfterHours_(row)) return '中';
  return '低';
}

/** 追跡・通知の対象か。動きがないまま GIVE_UP_DAYS を過ぎた件は外す。 */
function isActive_(row, nowMs) {
  return isOpen_(row) && !isExcluded_(row) && nowMs - toMs_(row.pending_since) < CFG.GIVE_UP_DAYS * 864e5;
}

/** 対象外の件（DM を外している間の DM、PR のレビュー依頼系）。取得・追跡・通知しない。 */
function isExcluded_(row) {
  return isExcludedDm_(row) || (CFG.EXCLUDE_PR_REVIEW && row.pr_review === PR_TO_ME);
}

/** 対応が残っていて、まだ「本人への PR レビュー依頼か」を今の基準で判定していない件。 */
function needsRejudge_(row) {
  return isOpen_(row) && !isExcluded_(row) &&
    (PR_VALUES.indexOf(row.pr_review) < 0 || String(row.judge_version) !== String(CFG.JUDGE_VERSION) ||
     Date.now() - toMs_(row.judged_at) > CFG.REVERIFY_HOURS * 36e5);
}

/** judgments の judged_at（「yyyy-MM-dd HH:mm[:ss]」日本時間の文字列、または Date）をミリ秒にする。 */
function jstMs_(v) {
  if (v instanceof Date) return v.getTime();
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/.exec(String(v || ''));
  return m ? new Date(`${m[1]}T${m[2]}${m[3] || ':00'}+09:00`).getTime() : 0;
}

/**
 * DM を対象外にしている間の DM の件。
 * dm 列が空の古い行は、チャンネル ID（D…）と種別で分かる分を除き DM かどうか分からない。
 * グループ DM の可能性があるので、検索で見えて判別できるまでは対象外として扱う。
 */
function isExcludedDm_(row) {
  if (CFG.INCLUDE_DM) return false;
  if (row.kind === 'dm' || /^D/.test(String(row.key))) return true;
  const dm = String(row.dm).toUpperCase();
  return dm !== 'FALSE';
}

/** 土日（日本時間）を除いた経過時間。金曜夕方の件が月曜朝に「高」へ跳ね上がらないようにする。 */
function elapsedHours_(fromMs, nowMs) {
  const JST = 9 * 36e5;
  const DAY = 864e5;
  let weekend = 0;
  for (let d = Math.floor((fromMs + JST) / DAY); d <= Math.floor((nowMs + JST) / DAY); d++) {
    const dow = (d + 4) % 7; // 1970-01-01 は木曜。0 = 日曜
    if (dow !== 0 && dow !== 6) continue;
    const start = d * DAY - JST;
    weekend += Math.max(0, Math.min(start + DAY, nowMs) - Math.max(start, fromMs));
  }
  return (nowMs - fromMs - weekend) / 36e5;
}

function notifyAfterHours_(row) {
  return isMine_(row) ? CFG.REMIND_AFTER_HOURS : CFG.NUDGE_AFTER_HOURS;
}

/** 通知する時期に達したか（放置時間を超えた、または期限が迫っている）。 */
function isRipe_(row, nowMs) {
  return elapsedHours_(toMs_(row.pending_since), nowMs) >= notifyAfterHours_(row) ||
    (row.due_at && (toMs_(row.due_at) - nowMs) / 36e5 <= CFG.DUE_SOON_HOURS);
}

// ───────────────────────── 通知（GAS） ─────────────────────────

/** 通知時期に達した件を個別に知らせる。同じ件は 1 回だけ（以降は朝のまとめに載る）。 */
function notifyStale() {
  const now = new Date();
  const hour = Number(Utilities.formatDate(now, CFG.TZ, 'H'));
  if (!isWeekday_(now) || hour < CFG.WORK_START_HOUR || hour >= CFG.WORK_END_HOUR) {
    console.log('notify mode=stale 時間外のため送らない');
    return;
  }
  notify_('stale', isDueForStale_);
}

/** 個別に知らせる件か。初回は通知時期に達した時点、その後は対応がないまま RENOTIFY_AFTER_HOURS 経った時点。 */
function isDueForStale_(row, nowMs) {
  if (!isRipe_(row, nowMs)) return false;
  if (!row.last_notified_at) return true;
  return Number(row.renotify_count || 0) < CFG.MAX_RENOTIFY &&
    nowMs - toMs_(row.last_notified_at) >= CFG.RENOTIFY_AFTER_HOURS * 36e5;
}

/** 毎朝、自分の対応待ち全件と、催促時期に達した相手待ちをまとめて 1 通投稿する。 */
function morningDigest() {
  if (!isWeekday_(new Date())) {
    console.log('notify mode=digest 休日のため送らない');
    return;
  }
  notify_('digest', (row, nowMs) => isMine_(row) || isRipe_(row, nowMs));
}

function notify_(mode, filter) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5 * 60 * 1000); // 仕分けの実行（最長 4.5 分）が終わるまで待つ
  const store = loadStore_();
  try {
    applyJudgments_(store);
    const me = myUserId_();
    const closed = applyCloseActions_(store, me);
    const nowMs = Date.now();
    const rows = Array.from(store.values())
      .filter((r) => isActive_(r, nowMs) && !isMuted_(r) && !isClosed_(r) && filter(r, nowMs));
    if (!rows.length) {
      console.log(`notify mode=${mode} 投稿=0 閉じた=${closed}`);
      return;
    }
    // 1 通に載るのは優先度順の上位だけ。通知済みの記録も、実際に載せた件にだけ付ける
    const notice = composeNotice_(rows, nowMs);
    const shown = notice.items;
    const renotified = mode === 'stale' ? shown.filter((r) => r.last_notified_at).length : 0;
    const res = slack_('chat.postMessage', {
      channel: notifyChannel_(),
      text: `<@${me}> ${notice.text}`,
      unfurl_links: false,
      unfurl_media: false,
    }, { bot: true, json: true });
    recordPost_(res.ts, shown, nowMs);
    console.log(`notify ${logFields_({
      mode: mode, 対象: rows.length, 掲載: shown.length, 再通知: renotified, 閉じた: closed,
      自分の番: shown.filter(isMine_).length, 相手待ち: shown.filter((r) => !isMine_(r)).length,
    })}`);
    shown.forEach((r) => {
      r.notify_count = Number(r.notify_count || 0) + 1;
      // 朝のまとめに載っただけの新しい件は、通知時期に達した時点で個別にも知らせる
      if (!isRipe_(r, nowMs)) return;
      // 個別通知の後の再通知を数える。朝のまとめに載ったら、その日の再通知は数え直す
      r.renotify_count = mode === 'stale' && r.last_notified_at ? Number(r.renotify_count || 0) + 1 : 0;
      r.last_notified_at = new Date(nowMs);
    });
  } finally {
    saveStore_(store);
    lock.releaseLock();
  }
}

/**
 * 各件の一文は Mac 側の AI が notices シートに書いたものを使う。まだ無い件は定型文で出す。
 * 返すのは本文と、載せた件（番号の順）。
 */
function composeNotice_(allRows, nowMs) {
  const sorted = sortByPriority_(allRows, nowMs);
  const rows = sorted.slice(0, CFG.MAX_NOTICE_ITEMS);
  const hours = (r) => Math.floor(elapsedHours_(toMs_(r.pending_since), nowMs));
  const due = (r) => (r.due_at ? Utilities.formatDate(new Date(toMs_(r.due_at)), CFG.TZ, 'MM/dd HH:mm') : '');
  const written = new Map();
  readRows_(CFG.NOTICES_SHEET, NOTICE_COLS).forEach((n) => written.set(`${n.key}|${n.fingerprint}`, n.line));
  const line = (r) => written.get(`${r.key}|${noticeId_(r)}`) ||
    `${r.summary} → ${r.next_action || (isMine_(r) ? '対応する' : '催促する')}`;
  const render = (r, i) => {
    const h = hours(r);
    const meta = [r.state, h >= 48 ? `${Math.floor(h / 24)}営業日経過` : `${h}時間経過`];
    if (due(r)) meta.push(`期限 ${due(r)}`);
    // 確認ステップの ball は他のチャンネルや DM を読んで書かれうるので、公開の通知には出さない（シートにだけ残す）。
    // 通知には、元のスレッドだけを読んだ一次判定の next_action と、決まった値の対応の種類だけを出す
    const ball = r.next_action;
    return `:${CFG.CLOSE_REACTIONS[i]}: [${priority_(r, nowMs)}] ${cleanLine_(line(r))}（${meta.join('・')}）${link_(r.permalink)}` +
      (ball ? `\n　　ボール: ${ACTION_LABELS[r.action_type] ? `【${ACTION_LABELS[r.action_type]}】` : ''}${cleanLine_(ball)}` : '');
  };
  const mine = rows.filter(isMine_);
  const waiting = rows.filter((r) => !isMine_(r));
  const parts = [];
  if (mine.length) parts.push(`*自分の対応待ち ${mine.length} 件*`, ...mine.map((r, i) => render(r, i)));
  if (waiting.length) parts.push(`*相手待ち（催促候補） ${waiting.length} 件*`, ...waiting.map((r, i) => render(r, mine.length + i)));
  if (sorted.length > rows.length) parts.push(`他 ${sorted.length - rows.length} 件はシートを参照`);
  parts.push('_返事が要らない件は、このスレッドに番号を書く（例: 2 不要）か、番号のリアクションを付けると閉じる。元のスレッドに新しい発言があれば戻る_');
  return { text: parts.join('\n'), items: mine.concat(waiting) };
}

/** 投稿した通知と、その番号の件を posts シートに残す（古いものは消す）。 */
function recordPost_(ts, items, nowMs) {
  if (!ts) return;
  const sheet = ensureSheet_(CFG.POSTS_SHEET, POST_COLS);
  const cutoff = nowMs - CFG.POSTS_KEEP_DAYS * 864e5;
  const kept = readRows_(CFG.POSTS_SHEET, POST_COLS).filter((p) => toMs_(p.posted_at) > cutoff)
    .map((p) => POST_COLS.map((c) => p[c]));
  kept.push([String(ts), new Date(nowMs), JSON.stringify(items.map((r) => ({ key: r.key, fp: String(r.fingerprint) })))]);
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, POST_COLS.length).clearContent();
  sheet.getRange(2, 1, kept.length, POST_COLS.length).setValues(kept.map((v) => v.map(cell_)));
}

/**
 * 直近の通知に本人が付けた番号のリアクションと、通知のスレッドへの本人の返信（例: 「2 不要」）を読み、その番号の件を閉じる。
 * 閉じるのは通知した時の内容（fingerprint）に対してだけ。スレッドに新しい動きがあれば通知に戻る。
 * 新しく閉じた件は、通知のスレッドに bot が返信して知らせる（元のスレッドには何もしないので、相手には届かない）。
 * 読めなくても仕分けや通知は止めない。返り値は新しく閉じた件数。
 */
function applyCloseActions_(store, me) {
  try {
    const cutoff = Date.now() - CFG.POSTS_KEEP_DAYS * 864e5;
    const posts = new Map();
    readRows_(CFG.POSTS_SHEET, POST_COLS).forEach((p) => {
      if (toMs_(p.posted_at) <= cutoff) return;
      try {
        posts.set(String(p.ts), JSON.parse(p.items));
      } catch (e) {
        // 壊れた行は読まない
      }
    });
    if (!posts.size) return 0;
    const channel = notifyChannel_();
    let closed = 0;
    const close = (items, n, done) => {
      const item = items[n - 1];
      if (!item) return;
      const row = store.get(item.key);
      if (!row || String(row.fingerprint) !== item.fp || isClosed_(row)) return;
      row.closed_fp = row.fingerprint;
      done.push(n);
      closed++;
    };
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const params = { channel: channel, oldest: String(Math.floor(cutoff / 1000)), limit: 200 };
      if (cursor) params.cursor = cursor;
      const res = slack_('conversations.history', params);
      (res.messages || []).forEach((m) => {
        const items = posts.get(String(m.ts));
        if (!items) return;
        const done = [];
        (m.reactions || []).forEach((r) => {
          if ((r.users || []).indexOf(me) >= 0) close(items, CFG.CLOSE_REACTIONS.indexOf(r.name) + 1, done);
        });
        if (Number(m.reply_count || 0) > 0) {
          Utilities.sleep(CFG.SLACK_INTERVAL_MS);
          const replies = slack_('conversations.replies', { channel: channel, ts: m.ts, limit: 200 }).messages || [];
          replies.filter((x) => x.ts !== m.ts && x.user === me && !x.bot_id)
            .forEach((x) => closeNumbers_(x.text, items.length).forEach((n) => close(items, n, done)));
        }
        if (!done.length) return;
        try {
          slack_('chat.postMessage', {
            channel: channel, thread_ts: m.ts, unfurl_links: false, unfurl_media: false,
            text: `閉じた: ${done.map((n) => `:${CFG.CLOSE_REACTIONS[n - 1]}:`).join(' ')}（スレッドに新しい発言があれば通知に戻る）`,
          }, { bot: true, json: true });
        } catch (e) {
          console.warn(`閉じた知らせを送れない ${e.message}`);
        }
      });
      cursor = res.response_metadata && res.response_metadata.next_cursor;
      if (!cursor) break;
    }
    return closed;
  } catch (e) {
    console.warn(`閉じる操作を読めない ${e.message}`);
    return 0;
  }
}

/**
 * 通知のスレッドへの本人の返信から、閉じる番号を読む。
 * 先頭に並べた番号（「2 不要」「1,3 済」「①②」「:two: 不要」）か、先頭の「全部」「全て」「すべて」だけを読む
 * （本文の途中の数字、例えば日付は読まない）。count を超える番号は無視する。
 */
function closeNumbers_(text, count) {
  let s = String(text || '')
    .replace(/[\u2460-\u2469]/g, (c) => ` ${c.charCodeAt(0) - 0x245f} `)
    .replace(/:([a-z_]+):/g, (all, name) => {
      const i = CFG.CLOSE_REACTIONS.indexOf(name);
      return i >= 0 ? ` ${i + 1} ` : all;
    })
    .normalize('NFKC').trim();
  if (/^(全部|全て|すべて)/.test(s)) return Array.from({ length: count }, (_, i) => i + 1);
  const m = /^\d{1,2}(?:[\s,、・]*\d{1,2}(?!\d|\/|:|月|日|時))*/.exec(s);
  if (!m) return [];
  if (/^\d{1,2}(?:\/|:|月|日|時)/.test(s)) return []; // 日付や時刻で始まる返信は番号として読まない
  return Array.from(new Set(m[0].split(/[^\d]+/).filter(String).map(Number))).filter((n) => n >= 1 && n <= count);
}

/** 通知文を作った時の判定を表す識別子。scripts/local-ai.mjs の noticeId と同じ形。 */
function noticeId_(r) {
  return `${r.fingerprint}#${r.state}#${r.ball || ''}`;
}

/** 優先度の高い順、同じなら長く止まっている順。 */
function sortByPriority_(rows, nowMs) {
  const rank = (r) => {
    const p = PRIORITY_RANK[priority_(r, nowMs)];
    return p === undefined ? 9 : p;
  };
  return rows.slice().sort((a, b) => rank(a) - rank(b) || toMs_(a.pending_since) - toMs_(b.pending_since));
}

// ───────────────────────── 外部 API ─────────────────────────

function slack_(method, params, opt) {
  opt = opt || {};
  const request = {
    headers: { Authorization: 'Bearer ' + prop_(opt.bot ? 'SLACK_BOT_TOKEN' : 'SLACK_USER_TOKEN') },
    muteHttpExceptions: true,
  };
  let url = 'https://slack.com/api/' + method;
  if (opt.json) {
    request.method = 'post';
    request.contentType = 'application/json; charset=utf-8';
    request.payload = JSON.stringify(params);
  } else {
    request.method = 'get';
    url += '?' + Object.keys(params || {})
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = UrlFetchApp.fetch(url, request);
    if (res.getResponseCode() === 429) {
      const headers = res.getHeaders();
      // 待ち時間は 60 秒まで（GAS の実行時間を使い切らない。待ちきれなければ失敗として次回に回す）
      const wait = Number(headers['Retry-After'] || headers['retry-after'] || 30) + 1;
      if (wait > 60) throw new Error(`Slack ${method}: rate limited`);
      Utilities.sleep(wait * 1000);
      continue;
    }
    const body = JSON.parse(res.getContentText());
    if (!body.ok) throw new Error(`Slack ${method}: ${body.error}`);
    return body;
  }
  throw new Error(`Slack ${method}: rate limited`);
}

// ───────────────────────── シート ─────────────────────────

function sheet_() {
  return ensureSheet_(CFG.SHEET_NAME, COLS);
}

function ensureSheet_(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
    sheet.setFrozenRows(1);
    // ts を含む列が数値に化けないよう、全列を文字列扱いにしておく（日付は書き込み時に Date で入る）
    ['key', 'fingerprint', 'pending_fp', 'closed_fp', 'ts'].filter((c) => cols.indexOf(c) >= 0).forEach((c) =>
      sheet.getRange(1, cols.indexOf(c) + 1, sheet.getMaxRows(), 1).setNumberFormat('@'));
  } else {
    // 列を足した時に見出しを追随させる（Mac 側が先に列を書いていても、見出しの中身で比べる）
    const header = sheet.getRange(1, 1, 1, cols.length).getValues()[0];
    if (cols.some((c, i) => header[i] !== c)) sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
  }
  return sheet;
}

/** Mac 側に合わせてほしい設定を meta シートに出す（版がずれた Mac 側は判定せずにエラーを出す）。 */
function writeMeta_() {
  ensureSheet_(META_SHEET, META_COLS).getRange(2, 1, 1, 2).setValues([['judge_version', CFG.JUDGE_VERSION]]);
}

/** Mac 側が追記するシートを読む（GAS からは書かない）。 */
function readRows_(name, cols) {
  return ensureSheet_(name, cols).getDataRange().getValues().slice(1).filter((v) => v[0]).map((v) => {
    const row = {};
    cols.forEach((c, i) => { row[c] = v[i]; });
    return row;
  });
}

function loadStore_() {
  const values = sheet_().getDataRange().getValues();
  const store = new Map();
  values.slice(1).forEach((v) => {
    if (!v[0]) return;
    const row = {};
    COLS.forEach((c, i) => { row[c] = v[i]; });
    // pending_at を記録する前に積まれた判定待ちは、その時点の checked_at を起点に固定する
    // （checked_at は取得のたびに新しくなるので、起点に使い続けると本文がいつまでも消えない）
    if (row.pending_fp && !row.pending_at) row.pending_at = row.checked_at || new Date();
    store.set(row.key, row);
  });
  return store;
}

function saveStore_(store) {
  const nowMs = Date.now();
  // 対象外の DM の判定待ちは消す（Slack の本文をシートに残さず、Mac 側の AI にも渡さない）
  store.forEach((r) => {
    // 対象外の DM と、長く判定されない判定待ちは本文を消す
    const stale = r.pending_fp && nowMs - toMs_(r.pending_at) > CFG.PENDING_TTL_HOURS * 36e5;
    if (isExcludedDm_(r) || stale) {
      r.pending_fp = '';
      r.pending_input = '';
      r.pending_at = '';
    }
  });
  const cutoff = nowMs - CFG.PRUNE_CLOSED_DAYS * 864e5;
  const kept = Array.from(store.values())
    .filter((r) => isActive_(r, nowMs) || isMuted_(r) || !r.latest_ts || toMs_(r.latest_ts) > cutoff);
  // 優先度は時間で変わるので保存のたびに付け直し、シートも優先度順に並べる
  kept.forEach((r) => { r.priority = priority_(r, nowMs); });
  const rows = sortByPriority_(kept, nowMs);
  const sheet = sheet_();
  // 実行中にシートで付けられた mute を上書きしないよう、書く直前の値を採用する
  const muteCol = COLS.indexOf('mute');
  const current = new Map(sheet.getDataRange().getValues().slice(1).map((v) => [v[0], v[muteCol]]));
  rows.forEach((r) => { if (current.has(r.key)) r.mute = current.get(r.key); });
  sheet.getRange(1, 1, 1, COLS.length).setValues([COLS]); // 列を足した時に見出しも追随させる
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, COLS.length).clearContent();
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, COLS.length)
      .setValues(rows.map((r) => COLS.map((c) => cell_(r[c]))));
  }
}

/**
 * シートに書く値。AI が書いた要約などが = や + で始まると数式として評価されるので、
 * 先頭にアポストロフィを付けて文字列として保存する（読み出す時には付いてこない）。
 */
function cell_(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' && /^[=+\-@\t\r\n]/.test(v) ? "'" + v : v;
}

function newRow_(c) {
  const row = {};
  COLS.forEach((col) => { row[col] = ''; });
  row.key = c.key;
  row.kind = c.kind;
  row.permalink = c.permalink;
  row.notify_count = 0;
  row.renotify_count = 0;
  row.dm = Boolean(c.dm);
  row.mute = false;
  return row;
}

// ───────────────────────── 小物 ─────────────────────────

function prop_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (v) return v;
  throw new Error(`スクリプトプロパティ ${name} が未設定`);
}

function myUserId_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('MY_USER_ID');
  if (!id) {
    id = slack_('auth.test', {}).user_id;
    props.setProperty('MY_USER_ID', id);
  }
  return id;
}

function ignoredChannels_() {
  // 通知文のメンションを拾って自己ループしないよう、通知先も除外する
  const extra = PropertiesService.getScriptProperties().getProperty('IGNORE_CHANNEL_IDS') || '';
  const ids = extra.split(',').map((s) => s.trim()).filter(String);
  return new Set(ids.concat(notifyChannel_()));
}

/** 対象外にする bot の ID（B… / U…）。スクリプトプロパティ EXCLUDE_BOT_IDS（任意）。 */
function excludedBots_() {
  const v = PropertiesService.getScriptProperties().getProperty('EXCLUDE_BOT_IDS') || '';
  const ids = new Set(v.split(',').map((s) => s.trim()).filter(String));
  ids.delete(myUserId_()); // 本人の ID は除外の対象にしない
  return ids;
}

function notifyChannel_() {
  return prop_('NOTIFY_CHANNEL_ID');
}

function isOpen_(row) {
  return OPEN_STATES.some((s) => STATE[s] === row.state);
}

/** ログ用に「名前=値」を並べる（件数や秒数だけ。Slack の本文や要約は渡さない）。 */
function logFields_(fields) {
  return Object.keys(fields).map((k) => `${k}=${fields[k]}`).join(' ');
}

function isMine_(row) {
  return MINE_STATES.some((s) => STATE[s] === row.state);
}

function isMuted_(row) {
  return row.mute === true || String(row.mute).toUpperCase() === 'TRUE';
}

/** 通知への番号のリアクションで閉じた件。閉じた後にスレッドの内容が変わったら閉じていない扱いに戻る。 */
function isClosed_(row) {
  return Boolean(row.closed_fp) && String(row.closed_fp) === String(row.fingerprint);
}

function isWeekday_(date) {
  return Number(Utilities.formatDate(date, CFG.TZ, 'u')) <= 5;
}

/**
 * AI が書いた一文を通知に載せる前に無害化する。元は Slack の本文なので、
 * メンション・リンク・改行による見出しの偽装が紛れ込まないようにする。
 */
function cleanLine_(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/[*~`]/g, '') // URL の除去より先に消す（ht*tps:// のような分断で除去をすり抜けさせない）
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .slice(0, 120)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** リンクにするのは Slack の permalink 形式だけ（シートを書き換えられても任意の記法を投稿させない）。 */
function link_(permalink) {
  return /^https:\/\/[a-z0-9.-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+(\?[\w=.&%-]*)?$/.test(String(permalink))
    ? ` <${permalink}|開く>` : '';
}

function tsToMs_(ts) {
  return Math.floor(parseFloat(ts) * 1000);
}

function toMs_(v) {
  if (!v) return 0;
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

// ───────────────────────── セットアップ ─────────────────────────

/** トークンと設定の疎通確認。投稿はしない。 */
function checkSetup() {
  const user = slack_('auth.test', {});
  const bot = slack_('auth.test', {}, { bot: true });
  notifyChannel_();
  sheet_();
  ensureSheet_(CFG.JUDGMENTS_SHEET, JUDGMENT_COLS);
  ensureSheet_(CFG.NOTICES_SHEET, NOTICE_COLS);
  console.log(`読み取りトークン=${user.ok ? 'OK' : 'NG'} 投稿トークン=${bot.ok ? 'OK' : 'NG'} 通知先=設定済み`);
}

/** 手動実行で判定結果を確かめてから実行する。 */
function installTriggers() {
  const handlers = ['scan', 'scanAndJudge', 'notifyStale', 'morningDigest'];
  ScriptApp.getProjectTriggers()
    .filter((t) => handlers.indexOf(t.getHandlerFunction()) >= 0)
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scan').timeBased().everyMinutes(15).create();
  // スプレッドシートを開いた時にも最新にする
  ScriptApp.newTrigger('scan').forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onOpen().create();
  ScriptApp.newTrigger('notifyStale').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('morningDigest').timeBased().atHour(9).nearMinute(30).everyDays(1)
    .inTimezone(CFG.TZ).create();
}
