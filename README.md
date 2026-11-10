# reply-watch

Slack の未返信・対応未完了を AI が仕分けてスプレッドシートに貯め、放置されたら自分のチャンネルに通知する。

- 仕分け `scanAndJudge`（15 分毎）: Slack を読む → AI が判定 → シートに保存
- 通知 `notifyStale`（30 分毎）/ `morningDigest`（毎朝）: シートだけ読む → 別の AI 呼び出しで文面を作る → bot が投稿

## 仕分けと優先度

対象は、自分宛メンション・所属グループ宛メンション・DM・自分が発言したスレッド。

| 状態 | 意味 | 通知 |
|---|---|---|
| 未返信 | 自分宛の依頼・質問に何も返していない | 3 時間で通知 |
| 返信済み・対応未完了 | 「確認します」「対応します」のまま結果を返していない | 3 時間で通知 |
| 相手待ち | 自分は返した。次は相手の番 | 24 時間で催促候補として通知 |
| 対応完了 / 対応不要 | — | しない |

完了にする方法は 2 つ。相手の最後の発言（またはそれ以降）に `:done:` を付けるか、「対応完了しました」のように書く。前者は AI を通さず完了になる。

優先度は期限までの残り時間と止まってからの経過時間で決まり、15 分毎に付け直してシートも優先度順に並ぶ。期限はやり取りから AI が読み取る（`due_at` 列。違っていればシートで直せるが、スレッドが動くと読み取り直す）。

| 優先度 | 条件 |
|---|---|
| 高 | 期限まで 24 時間以内（超過含む）/ 自分の番で 24 時間以上 / 相手待ちで 72 時間以上 |
| 中 | 期限まで 72 時間以内 / 通知時間（3 時間・24 時間）を超えた |
| 低 | それ以外 |

期限まで 24 時間を切った件は、放置時間に達していなくても通知する。個別の通知は 1 件につき 1 回で、以降は毎朝のまとめに載る。時間はすべて `src/Code.gs` の `CFG` で変えられる。

## 何をどこで管理するか

| 対象 | 正本 | 同期 |
|---|---|---|
| GAS のコード・設定値（`CFG`）・トリガー定義 | `src/` | `make push` / `make pull`（clasp） |
| Slack アプリの設定（スコープ等） | `slack/manifest.json` | `make slack-push` / `make slack-pull` |
| トークン・API キー | GAS のスクリプトプロパティ | 手で登録（リポジトリには置かない） |
| 判定結果 | スプレッドシート | — |

## 初回セットアップ

1. Slack アプリを作る: https://api.slack.com/apps → Create New App → From a manifest に `slack/manifest.json` を貼る → ワークスペースにインストール
2. 通知先チャンネルに bot を招待し、チャンネル ID を `src/Code.gs` の `CFG.NOTIFY_CHANNEL_ID` に書く
3. `clasp show-authorized-user` で Google アカウントを確かめてから `make gas-create`（スプレッドシートと GAS プロジェクトができ、`.clasp.json` が作られる）
4. `make push` → `make open`
5. GAS エディタの「プロジェクトの設定 → スクリプト プロパティ」に登録
   - `SLACK_USER_TOKEN`（xoxp-…）
   - `SLACK_BOT_TOKEN`（xoxb-…）
   - `ANTHROPIC_API_KEY`
6. エディタで `checkSetup` → `scanAndJudge` を手動実行し、実行ログの検索件数とシートの判定を確かめる
7. 問題なければ `installTriggers` を実行

## Slack 設定の同期

Slack の App Configuration Token（12 時間で失効）を使う。使う時だけ発行して Keychain に入れる。

1. https://api.slack.com/apps の「Your App Configuration Tokens」で Generate Token
2. `setup-keychain slack-reply-watch`（username = App ID、password = 発行した Access Token）
3. `make slack-validate` → `make slack-push`

スコープを変えた時は Slack 側でアプリの再インストールが要る。

## 運用

- 通知を止めたい件はシートの `mute` 列を TRUE にする
- トリガーの間隔を変えたら `make push` のあと `installTriggers` を実行し直す
- 通知チャンネルには DM や非公開スレッドの要約が流れるので、自分だけのチャンネルにする
- スプレッドシートは共有しない（トークンと要約が載る）

## テスト

`make test` は GAS と Slack / Claude API をスタブに置き換えて、仕分け → 保存 → 通知の流れだけを確かめる。判定の精度は実データで見る。
