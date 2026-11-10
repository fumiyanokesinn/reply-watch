#!/usr/bin/env bash
# slack/manifest.json と Slack アプリの設定を同期する。
# 認証は Keychain の slack-reply-watch（username = App ID、password = App Configuration Token）。
set -euo pipefail
cd "$(dirname "$0")/.."

eval "$(get-credentials slack-reply-watch)"
APP_ID=$ADMIN_USER

# トークンをコマンド引数に出さないよう、ヘッダは標準入力の設定として渡す
call() {
  local method=$1
  shift
  printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_PASSWORD" |
    curl -sS -K - -X POST "https://slack.com/api/$method" "$@"
}

check() {
  local res
  res=$(cat)
  if [ "$(jq -r '.ok' <<<"$res")" != "true" ]; then
    jq '{error, errors}' <<<"$res" >&2
    exit 1
  fi
  printf '%s' "$res"
}

case "${1:-}" in
  validate)
    call apps.manifest.validate --data-urlencode "app_id=$APP_ID" --data-urlencode manifest@slack/manifest.json | check >/dev/null
    echo "manifest OK"
    ;;
  push)
    # update は設定全体を置き換える
    call apps.manifest.update --data-urlencode "app_id=$APP_ID" --data-urlencode manifest@slack/manifest.json | check |
      jq -r 'if .permissions_updated then "更新完了。スコープが変わったのでアプリの再インストールが必要" else "更新完了" end'
    ;;
  pull)
    call apps.manifest.export --data-urlencode "app_id=$APP_ID" | check | jq 'del(.manifest._metadata) | .manifest' >slack/manifest.json.tmp
    mv slack/manifest.json.tmp slack/manifest.json
    echo "slack/manifest.json を Slack 側の内容で更新"
    ;;
  *)
    echo "usage: $0 validate|push|pull" >&2
    exit 2
    ;;
esac
