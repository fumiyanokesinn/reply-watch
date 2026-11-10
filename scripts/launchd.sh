#!/usr/bin/env bash
# 手元の AI 処理（scripts/local-ai.mjs）を 5 分毎に動かす launchd エージェントを管理する。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LABEL=com.reply-watch.local-ai
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
# 処理のログは scripts/log.mjs が local-ai.log に書く。ここは起動失敗などの予期しない出力だけ
LOG_DIR=$HOME/Library/Logs/reply-watch
LOG=$LOG_DIR/launchd.log

bin_dir() {
  local p d writable
  p=$(mise which "$1" 2>/dev/null || command -v "$1") || { echo "$1 が見つからない" >&2; exit 1; }
  # シンボリックリンクを解決した実際のディレクトリで調べる（/tmp → /private/tmp のような場合に見逃さない）
  d=$(cd "$(dirname "$p")" && pwd -P) || { echo "$1 の場所を解決できない" >&2; exit 1; }
  # 他のユーザーが書き込める場所の実行ファイルは、差し替えられる恐れがあるので使わない
  writable=$(find "$d" -maxdepth 0 -perm +022) || { echo "$d の権限を確認できない" >&2; exit 1; }
  if [ -n "$writable" ]; then
    echo "$d は本人以外も書き込めるため使えない（$1）" >&2
    exit 1
  fi
  printf '%s' "$d"
}

xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

plist() {
  # launchd はログインシェルの PATH を引き継がないので、使うコマンドの場所を明示する
  local path node_dir claude_dir gog_dir
  node_dir=$(bin_dir node)
  claude_dir=$(bin_dir claude)
  gog_dir=$(bin_dir gog)
  path="$node_dir:$claude_dir:$gog_dir:/usr/bin:/bin"
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
    <string>node scripts/local-ai.mjs judge; node scripts/local-ai.mjs notice</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(xml "$path")</string></dict>
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
