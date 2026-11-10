# reply-watch

Slack の未返信・対応未完了を AI が仕分けてスプレッドシートに貯め、放置されたら自分のチャンネルに bot が通知する。

AI は手元の Mac の Claude Code（`claude -p`、契約中のプランの範囲）が担当する。API キーは使わない。

## 仕組み

```
GAS  scan（15 分毎）            Slack を読み、変化のあったスレッドを「判定待ち」として threads シートに積む
Mac  local-ai.mjs judge（5 分毎） 判定待ちを読んで仕分け、judgments シートに書く
Mac  local-ai.mjs notice（同上）  仕分け結果だけを読んで通知の一文を作り、notices シートに書く
GAS  notifyStale（30 分毎）/ morningDigest（毎朝）  結果を取り込み、優先度を付けて bot で投稿する
```

- 仕分けと通知文の作成は別々の `claude` 呼び出し（別セッション）で、スプレッドシートだけでつながる
- Mac が止まっている間は判定待ちが溜まるだけで、起動すると 5 分以内に追いつく。通知文がまだ無い件は定型文で通知される
- `claude` はツールなし・MCP なし・設定ファイルなし・フックなしで、毎回新しく作る空の作業ディレクトリから起動する。Slack の本文を読ませるだけで、何も実行させない

## 仕分けと優先度

対象は、自分宛メンション・所属グループ宛メンション・DM・自分が発言したスレッド。

| 状態 | 意味 | 通知 |
|---|---|---|
| 未返信 | 自分宛の依頼・質問に何も返していない | 3 時間で通知 |
| 返信済み・対応未完了 | 「確認します」「対応します」のまま結果を返していない | 3 時間で通知 |
| 相手待ち | 自分は返した。次は相手の番 | 24 時間で催促候補として通知 |
| 対応完了 / 対応不要 | — | しない |

完了にする方法は 2 つ。相手の最後の発言（またはそれ以降）に `:done:` を付けるか、「対応完了しました」のように書く。前者は AI を待たずに完了になる。

優先度は期限までの残り時間と止まってからの経過時間で決まり、15 分毎に付け直してシートも優先度順に並ぶ。期限はやり取りから AI が読み取る（`due_at` 列）。

| 優先度 | 条件 |
|---|---|
| 高 | 期限まで 24 時間以内（超過含む）/ 自分の番で 24 時間以上 / 相手待ちで 72 時間以上 |
| 中 | 期限まで 72 時間以内 / 通知時間（3 時間・24 時間）を超えた |
| 低 | それ以外 |

経過時間は土日を除いて数える。期限まで 24 時間を切った件は、放置時間に達していなくても通知する。個別に通知した件は、対応がないまま 4 時間経つともう一度だけ通知する（平日 10〜19 時のみ）。以降は毎朝のまとめに載り、まとめから 4 時間経っても対応がなければ、その日もう一度だけ通知する。相手待ちの件は、催促するなど新しい発言があるとそこから数え直す。動きがないまま 14 日を過ぎた件は追跡と通知をやめる（優先度が「打切り」になる）。1 通に載せるのは優先度順に 15 件まで。時間や件数は `src/Code.gs` の `CFG` で変えられる。

## 何をどこで管理するか

| 対象 | 正本 | 同期 |
|---|---|---|
| GAS のコード・設定値（`CFG`）・トリガー定義 | `src/` | `make push` / `make pull`（clasp） |
| 仕分け・通知文のプロンプト | `prompts/` | 手元で直接使う（同期不要） |
| Slack アプリの設定（スコープ等） | `slack/manifest.json` | `make slack-push` / `make slack-pull` |
| トークン・チャンネル ID | GAS のスクリプトプロパティ | 手で登録（リポジトリには置かない） |
| GAS プロジェクトの ID | `.clasp.json`（git 管理外） | — |
| 判定待ち・判定結果・通知文 | スプレッドシート（`threads` / `judgments` / `notices`） | — |

## 初回セットアップ

前提: `clasp`、`gog`（スプレッドシートを作ったのと同じ Google アカウントでログイン済み）、`claude`（ログイン済み）、`node`。

1. Slack アプリを作る: https://api.slack.com/apps → Create New App → From a manifest に `slack/manifest.json` を貼る → ワークスペースにインストール
2. 通知先チャンネルを用意して bot を招待する
3. `clasp show-authorized-user` で Google アカウントを確かめてから `make gas-create`（スプレッドシートと GAS プロジェクトができ、`.clasp.json` が作られる）
4. `make push` → `make open`
5. GAS エディタの「プロジェクトの設定 → スクリプト プロパティ」に登録
   - `SLACK_USER_TOKEN`（xoxp-…）
   - `SLACK_BOT_TOKEN`（xoxb-…）
   - `NOTIFY_CHANNEL_ID`（通知先チャンネル ID）
   - `IGNORE_CHANNEL_IDS`（任意。監視対象外にするチャンネル ID をカンマ区切りで）
6. エディタで `checkSetup` → `scan` を手動実行し、実行ログの検索件数と `threads` シートの判定待ち（`pending_fp` 列）を確かめる
7. 手元で `make local-run` を実行し、もう一度 `scan` を実行して、シートの `state` / `priority` / `reason` を確かめる
8. 問題なければ、エディタで `installTriggers` を実行し、手元で `make local-install` を実行する

## 手元の AI 処理

- `make local-install` で launchd に登録され、5 分毎に動く（`make local-uninstall` で解除）
- ログは `~/Library/Logs/reply-watch/local-ai.log`（`make log` で追える）。1 行 1 イベントで、判定待ちの件数・判定結果の内訳・claude の呼び出しごとのトークン数と所要時間・失敗を記録する。Slack の本文や要約は書かない。5MB を超えたら `.1` に回す
- `make usage`（`DAYS=30` で期間指定）で、claude の利用量を日ごと・用途ごとに集計できる。換算 $ は API 料金に換算した参考値で、プランでは請求されない
- GAS 側の実行ログ（エディタの「実行数」）には、scan ごとに候補・取得・判定待ちへの追加・取り込み・失敗の件数、通知ごとに件数と再通知の件数を出す
- 判定待ちが無い回は `claude` を起動しない
- モデルは環境変数で変えられる（既定は仕分け `sonnet`、通知文 `haiku`）: `REPLY_WATCH_JUDGE_MODEL` / `REPLY_WATCH_NOTICE_MODEL`
- プロンプトは `prompts/judge.md` と `prompts/notice.md`。直したら `make eval` で、合成したやり取りに対する判定を確かめられる（プランの利用枠を使う）

## Slack 設定の同期

Slack の App Configuration Token（12 時間で失効）を使う。使う時だけ発行して Keychain に入れる。

1. https://api.slack.com/apps の「Your App Configuration Tokens」で Generate Token
2. `setup-keychain slack-reply-watch`（username = App ID、password = 発行した Access Token）
3. アプリを作った直後に一度 `make slack-pull`（Slack が補った項目を取り込む。`slack-push` は設定全体を置き換えるため）
4. 以降は `slack/manifest.json` を直して `make slack-validate` → `make slack-push`

スコープを変えた時は Slack 側でアプリの再インストールが要る。

## 運用

- 通知を止めたい件は `threads` シートの `mute` 列を TRUE にする
- トリガーの間隔を変えたら `make push` のあと `installTriggers` を実行し直す
- 通知チャンネルには DM や非公開スレッドの要約が流れるので、自分だけのチャンネルにする
- スプレッドシートは共有しない。判定待ちの間は Slack の本文が、判定後は要約が載る

## テスト

- `make test`: GAS と Slack をスタブに置き換えた流れの確認と、手元スクリプトの確認（シートと `claude` を差し替え）
- `make eval`: 仕分けプロンプトを実際の Claude Code で確かめる
