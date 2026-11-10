.PHONY: test eval push pull open logs gas-create local-run local-install local-uninstall slack-validate slack-push slack-pull

test:
	node test/mock_run.js
	node test/local_ai_test.mjs

# 仕分けプロンプトを合成データで実際の Claude Code に判定させる（プランの利用枠を使う）
eval:
	node test/judge_eval.mjs

# ローカル → GAS（テストが通った時だけ）
push: test
	clasp push --force

# GAS → ローカル（エディタで直接直した時）
pull:
	clasp pull

open:
	clasp open-container

logs:
	clasp tail-logs

# 初回のみ: スプレッドシートと紐づいた GAS プロジェクトを作る
gas-create:
	clasp create-script --type sheets --title reply-watch --rootDir src

# 手元の AI 処理を 1 回だけ動かす（仕分け → 通知文）
local-run:
	node scripts/local-ai.mjs judge
	node scripts/local-ai.mjs notice

# 手元の AI 処理を 5 分毎に動かす（launchd）
local-install:
	scripts/launchd.sh install

local-uninstall:
	scripts/launchd.sh uninstall

slack-validate:
	scripts/slack-manifest.sh validate

# ローカル → Slack アプリ設定
slack-push:
	scripts/slack-manifest.sh push

# Slack アプリ設定 → ローカル
slack-pull:
	scripts/slack-manifest.sh pull
