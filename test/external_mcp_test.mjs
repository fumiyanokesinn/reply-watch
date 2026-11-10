// scripts/external-mcp.mjs を、gh と gclouda を差し替えて動かす。読める範囲の制限と、決まった読み取りコマンドだけを呼ぶことを確かめる。
import assert from 'node:assert';
import { checkProject, checkRepo, gcloud, gh, handle, searchQuery, TOOL_NAMES } from '../scripts/external-mcp.mjs';

process.env.REPLY_WATCH_GITHUB_ORGS = 'acme';
process.env.REPLY_WATCH_GCP_PROJECTS = JSON.stringify({ prod: 'acme-prod', dev: 'acme-dev-1', bad: 'BAD PROJECT' });

const ghCalls = [];
const gcCalls = [];
gh.get = (path, params) => {
  ghCalls.push({ path, params });
  if (path.endsWith('/reviews')) return [{ user: { login: 'rev' }, state: 'APPROVED', submitted_at: 't' }];
  if (path.includes('/check-runs')) return { check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress' }] };
  if (path.startsWith('search/')) return { items: [{ repository_url: 'https://api.github.com/repos/acme/app', number: 1, title: 't', state: 'open', pull_request: {}, user: { login: 'a' } }] };
  return { title: 'PR', state: 'closed', merged: true, head: { sha: 'abc' }, base: { ref: 'develop' }, user: { login: 'me' }, requested_reviewers: [] };
};
gcloud.list = (args) => {
  gcCalls.push(args);
  return [{ id: '1234567890', status: 'SUCCESS', substitutions: { TRIGGER_NAME: 'deploy', BRANCH_NAME: 'develop', SHORT_SHA: 'abc1234' } }];
};
const call = (name, args) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).result;

// 一覧に出るのは決まったツールだけ
const list = handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).result.tools.map((t) => t.name);
assert.deepStrictEqual(list, TOOL_NAMES);
assert.ok(list.every((n) => /^(github|gcp)_/.test(n)));

// GitHub: 許可した組織だけ。検索で範囲を広げる修飾子は拒否し、組織の修飾子をこちらで付ける
assert.strictEqual(checkRepo('acme/app'), 'acme/app');
assert.throws(() => checkRepo('other/app'), /読めない/);
assert.throws(() => checkRepo('acme/app/../../x'), /owner\/repo/);
assert.throws(() => searchQuery('bug repo:other/x'), /指定はできない/);
assert.throws(() => searchQuery('bug -org:acme'), /指定はできない/);
assert.strictEqual(searchQuery('is:pr author:me'), 'is:pr author:me org:acme');
assert.throws(() => searchQuery('(org:outside) OR is:issue'), /指定はできない/);
assert.throws(() => searchQuery('bug OR is:issue'), /OR/);
assert.throws(() => searchQuery('(bug)'), /括弧/);
assert.throws(() => checkRepo('acme/..'), /owner\/repo/);
assert.throws(() => checkRepo('acme/.hidden'), /owner\/repo/);
const pr = JSON.parse(call('github_pr', { repo: 'acme/app', number: 12 }).content[0].text);
assert.deepStrictEqual([pr.merged, pr.reviews[0].state, pr.checks.success, pr.checks.in_progress], [true, 'APPROVED', 1, 1]);
assert.ok(ghCalls.every((c) => !c.path.includes('..')));
assert.strictEqual(call('github_pr', { repo: 'other/app', number: 1 }).isError, true);
assert.strictEqual(call('github_pr', { repo: 'acme/app', number: -1 }).isError, true);

// 検索結果に許可外の組織のものが混ざっても返さない
const keepGet = gh.get;
gh.get = () => ({ items: [
  { repository_url: 'https://api.github.com/repos/acme/app', number: 1, title: 'ok', state: 'open', user: { login: 'a' } },
  { repository_url: 'https://api.github.com/repos/outside/app', number: 2, title: 'ng', state: 'open', user: { login: 'b' } },
] });
assert.deepStrictEqual(JSON.parse(call('github_search', { query: 'bug' }).content[0].text).map((i) => i.repo), ['acme/app']);
gh.get = keepGet;

// GCP: 許可したプロジェクトだけ（環境名かプロジェクト ID）。不正な ID の設定は無視する。フィルタ等は決まった形だけ
assert.strictEqual(checkProject('prod'), 'acme-prod');
assert.strictEqual(checkProject('acme-dev-1'), 'acme-dev-1');
assert.throws(() => checkProject('bad'), /読めない/);
assert.throws(() => checkProject('someone-else'), /読めない/);
assert.throws(() => checkProject('toString'), /読めない/);
assert.throws(() => checkProject('__proto__'), /読めない/);
const builds = JSON.parse(call('gcp_builds', { project: 'prod', trigger: 'deploy', limit: 3 }).content[0].text);
assert.deepStrictEqual(builds[0], { id: '12345678', status: 'SUCCESS', trigger: 'deploy', branch: 'develop', commit: 'abc1234' });
assert.deepStrictEqual(gcCalls[0], ['builds', 'list', '--project', 'acme-prod', '--limit', '3', '--region', 'asia-northeast1',
  '--filter', 'substitutions.TRIGGER_NAME="deploy"']);
assert.strictEqual(call('gcp_builds', { project: 'prod', trigger: 'x" OR status="FAILURE' }).isError, true);
assert.strictEqual(call('gcp_run_revisions', { project: 'dev', service: 'svc; rm -rf /' }).isError, true);
assert.strictEqual(call('gcp_run_services', { project: 'prod', region: 'asia-northeast1 --impersonate' }).isError, true);
assert.ok(gcCalls.every((a) => ['builds', 'run', 'app'].includes(a[0]) && a.includes('list')));

// 想定外のエラーは中身を返さない
gh.get = () => { throw new Error("ENOENT: no such file '/Users/x/.config/gh/hosts.yml'"); };
assert.strictEqual(call('github_issue', { repo: 'acme/app', number: 1 }).content[0].text, 'エラー');

// 知らないメソッドとツール
assert.strictEqual(handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'shell', arguments: {} } }).error.code, -32602);
assert.strictEqual(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);

console.log('OK');
