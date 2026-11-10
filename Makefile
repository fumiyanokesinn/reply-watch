.PHONY: test push pull open logs gas-create slack-validate slack-push slack-pull

test:
	node test/mock_run.js

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

slack-validate:
	scripts/slack-manifest.sh validate

# ローカル → Slack アプリ設定
slack-push:
	scripts/slack-manifest.sh push

# Slack アプリ設定 → ローカル
slack-pull:
	scripts/slack-manifest.sh pull
