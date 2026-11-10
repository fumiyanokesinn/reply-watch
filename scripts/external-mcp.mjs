#!/usr/bin/env node
// 確認ステップの claude に渡す、GitHub と GCP を読むだけの MCP サーバー（標準入出力）。
// GitHub は gh の読み取り API（GET）だけ、GCP は gclouda の list 系だけを、決まった形で呼ぶ。
// 任意のコマンド・パス・フィルタ式は受け付けない。
// 読める範囲は config.local.json で決める（scripts/local-ai.mjs が環境変数で渡す）:
//   REPLY_WATCH_GITHUB_ORGS  GitHub の組織（カンマ区切り）
//   REPLY_WATCH_GCP_PROJECTS GCP の環境名とプロジェクト ID（JSON。例 {"prod":"…","stg":"…","dev":"…"}）
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

/** 呼び出し側に文言を返してよいエラー（入力の検証と、取得失敗の決まった文言）。 */
class ToolError extends Error {}

const MAX_CHARS = 4000; // 1 回の結果の上限（Slack の本文と同じく、読んだ内容は判断の材料にだけ使う）
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export function allowedOrgs() {
  return (process.env.REPLY_WATCH_GITHUB_ORGS || '').split(',').map((s) => s.trim()).filter((s) => NAME.test(s));
}

/** 「owner/repo」を検証して返す。許可していない組織や、形の違う指定は拒否する。 */
export function checkRepo(repo, orgs = allowedOrgs()) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(repo || ''));
  const ok = (part) => NAME.test(part) && !part.startsWith('.');
  if (!m || !ok(m[1]) || !ok(m[2])) throw new ToolError('repo は owner/repo の形で指定する');
  if (!orgs.includes(m[1])) throw new ToolError('この組織のリポジトリは読めない');
  return `${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`;
}

function checkNumber(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 10_000_000) throw new ToolError('number は正の整数で指定する');
  return v;
}

/** 検索語。範囲を広げる修飾子は受け付けず、許可した組織に限る修飾子をこちらで付ける。 */
export function searchQuery(q, orgs = allowedOrgs()) {
  const text = String(q || '').trim();
  if (!text || text.length > 200) throw new ToolError('query は 1〜200 文字');
  if (/(org|repo|user|owner):/i.test(text)) throw new ToolError('org / repo / user の指定はできない（許可した組織だけを検索する）');
  // OR などで組織の条件を外されないよう、括弧と論理演算子は受け付けない（語はすべて AND になる）
  if (/[()]/.test(text) || /(^|\s)(OR|AND|NOT)(\s|$)/.test(text)) throw new ToolError('括弧と OR / AND / NOT は使えない');
  if (!orgs.length) throw new ToolError('読める組織が設定されていない');
  return `${text} ${orgs.map((o) => `org:${o}`).join(' ')}`;
}

// gh の呼び出し（テストでは差し替える）。GET だけ。値はすべて引数で渡し、シェルは通さない。
export const gh = {
  get(path, params = {}) {
    const args = ['api', '--method', 'GET', path];
    for (const [k, v] of Object.entries(params)) args.push('-f', `${k}=${v}`);
    const res = spawnSync(process.env.REPLY_WATCH_GH || 'gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
    if (res.status !== 0) throw new ToolError(`GitHub API の取得に失敗（${res.status === null ? 'timeout' : `exit ${res.status}`}）`);
    return JSON.parse(res.stdout);
  },
};

// gclouda の呼び出し（テストでは差し替える）。list 系の読み取りだけ。
export const gcloud = {
  list(args) {
    const res = spawnSync(process.env.REPLY_WATCH_GCLOUDA || 'gclouda', [...args, '--format', 'json', '--quiet'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
    if (res.status !== 0) throw new ToolError(`GCP の取得に失敗（${res.status === null ? 'timeout' : `exit ${res.status}`}）`);
    return JSON.parse(res.stdout || '[]');
  },
};

export function gcpProjects() {
  try {
    const v = JSON.parse(process.env.REPLY_WATCH_GCP_PROJECTS || '{}');
    return Object.fromEntries(Object.entries(v).filter(([k, id]) => NAME.test(k) && /^[a-z][a-z0-9-]{4,29}$/.test(String(id))));
  } catch (e) {
    return {};
  }
}

/** 環境名（prod / stg / dev など）かプロジェクト ID を受け取り、許可したプロジェクト ID を返す。 */
export function checkProject(p, projects = gcpProjects()) {
  const v = String(p || '');
  if (Object.hasOwn(projects, v) && typeof projects[v] === 'string') return projects[v];
  if (Object.values(projects).includes(v)) return v;
  throw new ToolError(`このプロジェクトは読めない（使える環境: ${Object.keys(projects).join(' ') || 'なし'}）`);
}

function checkRegion(r) {
  const v = String(r || 'asia-northeast1');
  if (!/^[a-z]+-[a-z]+[0-9]$/.test(v)) throw new ToolError('region の形が不正');
  return v;
}

function checkResource(name, what) {
  const v = String(name || '');
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(v)) throw new ToolError(`${what} の形が不正`);
  return v;
}

const cond = (obj, type) => ((obj && obj.status && obj.status.conditions) || []).find((c) => c.type === type) || {};

const login = (u) => (u && u.login) || null;

const TOOLS = {
  github_pr: {
    description: 'PR の状態（open / merged / closed、draft、レビュー依頼先、レビュー結果、CI の結果、更新日時）を読む',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'owner/repo' }, number: { type: 'integer' } },
      required: ['repo', 'number'],
    },
    run({ repo, number }) {
      const r = checkRepo(repo);
      const n = checkNumber(number);
      const pr = gh.get(`repos/${r}/pulls/${n}`);
      const reviews = gh.get(`repos/${r}/pulls/${n}/reviews`, { per_page: '50' });
      let checks = null;
      try {
        const runs = gh.get(`repos/${r}/commits/${pr.head.sha}/check-runs`, { per_page: '100' }).check_runs || [];
        checks = runs.reduce((acc, c) => {
          const k = c.status === 'completed' ? c.conclusion : c.status;
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {});
      } catch (e) {
        checks = 'unavailable';
      }
      return {
        repo: r, number: n, title: pr.title, state: pr.state, merged: pr.merged, merged_at: pr.merged_at, draft: pr.draft,
        author: login(pr.user), base: pr.base && pr.base.ref, updated_at: pr.updated_at, closed_at: pr.closed_at,
        requested_reviewers: (pr.requested_reviewers || []).map(login),
        reviews: reviews.map((v) => ({ by: login(v.user), state: v.state, at: v.submitted_at })).slice(-20),
        checks,
      };
    },
  },
  github_issue: {
    description: 'Issue の状態（open / closed、担当者、ラベル、コメント数、更新日時）を読む',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'owner/repo' }, number: { type: 'integer' } },
      required: ['repo', 'number'],
    },
    run({ repo, number }) {
      const r = checkRepo(repo);
      const n = checkNumber(number);
      const is = gh.get(`repos/${r}/issues/${n}`);
      return {
        repo: r, number: n, title: is.title, state: is.state, state_reason: is.state_reason, is_pr: Boolean(is.pull_request),
        author: login(is.user), assignees: (is.assignees || []).map(login), labels: (is.labels || []).map((l) => l.name),
        comments: is.comments, updated_at: is.updated_at, closed_at: is.closed_at,
      };
    },
  },
  github_search: {
    description: '許可した組織の PR / Issue を検索する（GitHub の検索構文。is:pr、is:open、author:、involves:、タイトルの語など。org / repo / user は指定できない）。最大 10 件',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    run({ query }) {
      const res = gh.get('search/issues', { q: searchQuery(query), per_page: '10', sort: 'updated' });
      // 念のため、許可した組織のものだけを返す
      const orgs = allowedOrgs();
      return (res.items || []).filter((it) => orgs.includes(String(it.repository_url || '').split('/repos/')[1]?.split('/')[0]))
        .slice(0, 10).map((it) => ({
        repo: (it.repository_url || '').split('/repos/')[1], number: it.number, title: it.title, state: it.state,
        is_pr: Boolean(it.pull_request), merged_at: it.pull_request ? it.pull_request.merged_at : undefined,
        author: login(it.user), updated_at: it.updated_at,
      }));
    },
  },
  github_commits: {
    description: 'リポジトリの最近のコミット（ブランチ、期間、作者で絞れる）の見出しを読む。最大 20 件',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/repo' },
        branch: { type: 'string' },
        since: { type: 'string', description: 'ISO 8601 の日時' },
        author: { type: 'string', description: 'GitHub のユーザー名' },
      },
      required: ['repo'],
    },
    run({ repo, branch, since, author }) {
      const r = checkRepo(repo);
      const params = { per_page: '20' };
      if (branch) {
        if (!/^[A-Za-z0-9_./-]{1,100}$/.test(branch)) throw new ToolError('branch の形が不正');
        params.sha = branch;
      }
      if (since) {
        if (Number.isNaN(Date.parse(since))) throw new ToolError('since は ISO 8601 の日時');
        params.since = new Date(since).toISOString();
      }
      if (author) {
        if (!NAME.test(author)) throw new ToolError('author の形が不正');
        params.author = author;
      }
      return gh.get(`repos/${r}/commits`, params).slice(0, 20).map((c) => ({
        sha: c.sha.slice(0, 7), title: String(c.commit.message || '').split('\n')[0].slice(0, 120),
        author: login(c.author) || (c.commit.author && c.commit.author.name), at: c.commit.author && c.commit.author.date,
      }));
    },
  },
  gcp_builds: {
    description: 'Cloud Build の最近のビルド（状態、開始・終了時刻、トリガー名、ブランチ、コミット）を読む。project は環境名（prod / stg / dev など）かプロジェクト ID。最大 10 件',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' }, region: { type: 'string', description: '既定は asia-northeast1。global のビルドは "global"' },
        trigger: { type: 'string', description: 'トリガー名で絞る（任意）' }, limit: { type: 'integer' },
      },
      required: ['project'],
    },
    run({ project, region, trigger, limit }) {
      const p = checkProject(project);
      const n = Math.min(10, Math.max(1, Number(limit) || 10));
      const args = ['builds', 'list', '--project', p, '--limit', String(n)];
      if (region !== 'global') args.push('--region', checkRegion(region));
      if (trigger) args.push('--filter', `substitutions.TRIGGER_NAME="${checkResource(trigger, 'trigger')}"`);
      return gcloud.list(args).slice(0, n).map((b) => {
        const sub = b.substitutions || {};
        return {
          id: String(b.id || '').slice(0, 8), status: b.status, created: b.createTime, finished: b.finishTime,
          trigger: sub.TRIGGER_NAME, branch: sub.BRANCH_NAME || sub.REF_NAME || sub.TAG_NAME, commit: sub.SHORT_SHA || String(sub.COMMIT_SHA || '').slice(0, 7),
        };
      });
    },
  },
  gcp_run_services: {
    description: 'Cloud Run のサービス一覧（最新の稼働リビジョン、準備状態、最終更新、イメージ）を読む',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, region: { type: 'string' } },
      required: ['project'],
    },
    run({ project, region }) {
      const p = checkProject(project);
      return gcloud.list(['run', 'services', 'list', '--project', p, '--region', checkRegion(region)]).slice(0, 40).map((s) => {
        const ready = cond(s, 'Ready');
        const c = (((s.spec || {}).template || {}).spec || {}).containers || [];
        return {
          name: s.metadata && s.metadata.name, ready: ready.status, since: ready.lastTransitionTime,
          revision: s.status && s.status.latestReadyRevisionName, image: c[0] && String(c[0].image).split('/').pop(),
        };
      });
    },
  },
  gcp_run_revisions: {
    description: 'Cloud Run の指定サービスの最近のリビジョン（作成時刻、イメージ、準備状態）を読む。最大 5 件',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, service: { type: 'string' }, region: { type: 'string' } },
      required: ['project', 'service'],
    },
    run({ project, service, region }) {
      const p = checkProject(project);
      return gcloud.list(['run', 'revisions', 'list', '--project', p, '--region', checkRegion(region),
        '--service', checkResource(service, 'service'), '--limit', '5']).slice(0, 5).map((r) => {
        const c = ((r.spec || {}).containers || [])[0];
        return {
          name: r.metadata && r.metadata.name, created: r.metadata && r.metadata.creationTimestamp,
          ready: cond(r, 'Ready').status, image: c && String(c.image).split('/').pop(),
        };
      });
    },
  },
  gcp_run_jobs: {
    description: 'Cloud Run ジョブの一覧（最新の実行とその状態、最終更新、イメージ）を読む',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, region: { type: 'string' } },
      required: ['project'],
    },
    run({ project, region }) {
      const p = checkProject(project);
      return gcloud.list(['run', 'jobs', 'list', '--project', p, '--region', checkRegion(region)]).slice(0, 40).map((j) => {
        const latest = (j.status && j.status.latestCreatedExecution) || {};
        const c = ((((j.spec || {}).template || {}).spec || {}).template || {}).spec || {};
        return {
          name: j.metadata && j.metadata.name, ready: cond(j, 'Ready').status,
          latest_execution: latest.name, latest_execution_at: latest.creationTimestamp, latest_execution_done: latest.completionTimestamp,
          image: c.containers && c.containers[0] && String(c.containers[0].image).split('/').pop(),
        };
      });
    },
  },
  gcp_app_versions: {
    description: 'App Engine のバージョン一覧（サービス、バージョン、配信状態、トラフィック、最終デプロイ時刻）を読む。最大 10 件',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, service: { type: 'string' } },
      required: ['project'],
    },
    run({ project, service }) {
      const p = checkProject(project);
      const args = ['app', 'versions', 'list', '--project', p, '--sort-by', '~version.createTime', '--limit', '10'];
      if (service) args.push('--service', checkResource(service, 'service'));
      return gcloud.list(args).slice(0, 10).map((v) => ({
        service: v.service, id: v.id, traffic: v.traffic_split, serving: v.version && v.version.servingStatus,
        deployed: v.last_deployed_time && (v.last_deployed_time.datetime || v.last_deployed_time),
      }));
    },
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

/** JSON-RPC の 1 メッセージを処理し、返すメッセージ（通知なら null）を返す。 */
export function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null; // 形の違うメッセージは無視する（サーバーを落とさない）
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'reply-watch-external', version: '1.0.0' },
      });
    case 'tools/list':
      return reply({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      const tool = typeof name === 'string' && Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
      if (!tool) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } };
      try {
        let text = JSON.stringify(tool.run(msg.params.arguments || {}));
        if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}…（以下省略）`;
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        // 文言を返すのは決まったエラーだけ。想定外のエラー（パスなどを含みうる）は中身を返さない
        return reply({ content: [{ type: 'text', text: e instanceof ToolError ? e.message : 'エラー' }], isError: true });
      }
    }
    case 'ping':
      return reply({});
    default:
      return msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      return;
    }
    const out = handle(msg);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
