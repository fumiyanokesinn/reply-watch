#!/usr/bin/env bash
# 手元の AI 処理（scripts/local-ai.mjs）を 5 分毎に動かす launchd エージェントを管理する。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LABEL=com.reply-watch.local-ai
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
# 処理のログは scripts/log.mjs が local-ai.log に書く。ここは起動失敗などの予期しない出力だけ
LOG_DIR=$HOME/Library/Logs/reply-watch
LOG=$LOG_DIR/launchd.log

die() {
  echo "$1" >&2
  exit 1
}

# そのファイルと / までの上位ディレクトリが、本人か root の持ち物で、他人が書き込めないこと
# （リンクはリンク自身を見る。リンク先は resolve_bin が別に確かめる）
trusted() {
  local f=$1 owner mode
  while :; do
    read -r owner mode < <(stat -f '%u %Lp' "$f") || return 1
    [ "$owner" = "$(id -u)" ] || [ "$owner" = 0 ] || return 1
    [ $((8#$mode & 8#022)) -eq 0 ] || return 1
    [ "$f" = / ] && return 0
    f=$(dirname "$f")
  done
}

# 実行ファイルを 1 つ決め、その絶対パスを返す。launchd からはこのパスで呼ぶ（PATH から探させない）。
resolve_bin() {
  local p real
  # リポジトリの mise.toml で版を決める（launchd からは mise の設定が見えないので、shim は使えない）
  p=$(cd "$ROOT" && mise which "$1" 2>/dev/null || command -v "$1") || die "$1 が見つからない"
  case "$p" in /*) ;; *) die "$1 の場所が絶対パスにならない" ;; esac
  real=$(realpath "$p") || die "$1 の実体を解決できない"
  [ "$(basename "$real")" != mise ] || die "$1 が mise の shim になる。リポジトリで mise install を実行する"
  [ -f "$real" ] && [ -x "$real" ] || die "$1 の実体が実行ファイルではない"
  # 呼び出すパス（リンクなら更新で付け替わる）とその実体の両方を確かめる
  trusted "$p" && trusted "$real" || die "$1 は本人か root 以外が差し替えられる場所にあるため使えない"
  printf '%s' "$p"
}

xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

plist() {
  # 使うコマンドは確かめた絶対パスで渡し、PATH からは探させない
  local node claude gog
  node=$(resolve_bin node)
  claude=$(resolve_bin claude)
  gog=$(resolve_bin gog)
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>"\$REPLY_WATCH_NODE" scripts/local-ai.mjs judge; "\$REPLY_WATCH_NODE" scripts/local-ai.mjs notice</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin</string>
    <key>REPLY_WATCH_NODE</key><string>$(xml "$node")</string>
    <key>REPLY_WATCH_CLAUDE</key><string>$(xml "$claude")</string>
    <key>REPLY_WATCH_GOG</key><string>$(xml "$gog")</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
PLIST
}

case "${1:-}" in
  print) plist ;;
  install)
    mkdir -p "$(dirname "$PLIST")"
    mkdir -p -m 700 "$LOG_DIR"
    # ログの置き場所は本人専用にする（リンクや他人の持ち物なら中断）
    if [ -L "$LOG_DIR" ] || [ ! -O "$LOG_DIR" ] || [ -L "$LOG" ] || { [ -e "$LOG" ] && [ ! -O "$LOG" ]; }; then
      echo "$LOG_DIR がリンクか、本人の持ち物ではないため使えない" >&2
      exit 1
    fi
    chmod 700 "$LOG_DIR"
    (umask 077 && touch "$LOG")
    chmod 600 "$LOG"
    plist >"$PLIST"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "登録完了: 5 分毎に実行。ログは $LOG_DIR/local-ai.log（make log で追える）"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "解除完了"
    ;;
  *)
    echo "usage: $0 print|install|uninstall" >&2
    exit 2
    ;;
esac
