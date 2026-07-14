# Claude Skill Scheduler

**Claude Code のスキルを「条件」で自動実行して、結果を報告してくれるスケジューラーアプリ**です。

- ✅ **Claude Code のサブスクプランで動く** — API キー不要。ログイン済みの `claude` CLI をそのまま使います
- ✅ **依存パッケージゼロ** — Node.js 18+ だけで動作（`npm install` 不要）
- ✅ **豊富なトリガー** — 時刻 / 毎日 / 毎週 / 毎月 / 一定間隔 / cron式 / ファイル作成・更新・削除 / フォルダに入った時 / コマンド条件 / Webhook / 起動時 / 手動
- ✅ **誰でも管理できる Web ダッシュボード** — ブラウザからタスクの追加・有効化・手動実行・レポート閲覧
- ✅ **結果を自動報告** — Markdown レポート保存 + 実行履歴 + 通知コマンド / Slack Webhook 連携

## 仕組み

条件が成立すると、`claude -p "/スキル名 引数"`（ヘッドレスモード）を起動してスキルを実行し、
結果を `reports/` に保存・通知します。Claude Code にログインしていれば**サブスクプランの認証がそのまま使われます**。

```
トリガー成立 ──▶ 実行キュー ──▶ claude -p "/skill ..." ──▶ レポート保存 ──▶ 通知
 (時間/ファイル/条件/Webhook)      (同時実行数を制御)          (Markdown + 履歴)   (コマンド/Slack)
```

## 必要なもの

- Node.js 18.17 以上
- Claude Code CLI（ログイン済み）— `claude -p "hello"` が動けば OK

## クイックスタート

```bash
git clone <このリポジトリ> && cd <リポジトリ>

# 1. 好きな作業フォルダで初期化（設定ファイルとフォルダを作成）
node bin/skill-scheduler.js init

# 2. タスクを追加（例: 毎朝9時に daily-report スキルを実行）
node bin/skill-scheduler.js add --name "毎朝レポート" --trigger daily --at 09:00 --skill daily-report

# 3. スケジューラーを起動
node bin/skill-scheduler.js start

# 4. ブラウザで管理画面を開く
open http://127.0.0.1:8787/
```

`npm link` すると `skill-scheduler` コマンドとして使えます。

## トリガー一覧（考えうる条件）

### 時間で実行する

| type | 説明 | 設定例 |
| --- | --- | --- |
| `once` | 指定日時に1回だけ | `{ "type": "once", "at": "2026-08-01 10:00" }` |
| `daily` | 毎日（複数時刻可） | `{ "type": "daily", "at": ["09:00", "17:00"] }` |
| `weekly` | 毎週の曜日と時刻 | `{ "type": "weekly", "days": ["月", "fri"], "at": "09:00" }` |
| `monthly` | 毎月の日にちと時刻（`"last"`=月末） | `{ "type": "monthly", "day": "last", "at": "09:00" }` |
| `interval` | 一定間隔ごと | `{ "type": "interval", "every": "30m" }` |
| `cron` | cron式（分 時 日 月 曜日） | `{ "type": "cron", "expression": "0 9-18 * * 1-5" }` |
| `startup` | スケジューラー起動時 | `{ "type": "startup" }` |

- 曜日は `mon`〜`sun` / `月`〜`日` / `0`〜`7`（0,7=日曜）が使えます
- `every` は `90s` `30m` `2h` `1d` `1h30m` などの表記に対応
- cron は `@hourly` `@daily` `@weekly` `@monthly` `@yearly` のエイリアスにも対応

### ファイル・フォルダの変化で実行する

| type | 説明 |
| --- | --- |
| `folder_entered` | **フォルダに何か（ファイル/フォルダ）が入った時** |
| `file_created` | ファイルが作成された時（コピー・移動での出現も含む） |
| `file_modified` | ファイルが更新された時 |
| `file_deleted` | ファイルが削除された時 |
| `folder_created` | フォルダが作成された時 |
| `folder_deleted` | フォルダが削除された時 |
| `folder_changed` | フォルダ内の何らかの変化すべて |
| `watch` | 上記を `events` 配列で自由に組み合わせ |

```json
{
  "type": "folder_entered",
  "path": "./inbox",
  "pattern": ["*.csv", "*.xlsx"],
  "recursive": true,
  "batch": false,
  "ignore": ["tmp"]
}
```

- `pattern`: glob（`*` `?` `**`）。`/` を含むと相対パス全体、含まないとファイル名に対して照合
- `batch: true` にすると同時に検出した複数ファイルを **1回の実行にまとめる**
- ポーリング方式（既定5秒間隔）なので Docker ボリュームやネットワークドライブでも動作
- コピー中の大きなファイルは**サイズが安定してから**発火（処理の途中読み込みを防止）
- 起動時に既に存在するファイルでは発火しません

### その他の条件

| type | 説明 |
| --- | --- |
| `condition` | 任意のシェルコマンドが**成功（終了コード0）した時**。`every` 間隔で判定。`mode: "edge"`（成立した瞬間のみ・既定）/ `"level"`（成立中は間隔ごと） |
| `webhook` | `POST /hooks/<タスクID>` を受信した時（`token` で保護可能）。外部サービスや GitHub Actions から起動できます |
| `manual` | 手動実行のみ（ダッシュボードのボタン / `run` コマンド） |

```json
{ "type": "condition", "command": "curl -sf https://example.com/health", "every": "5m", "mode": "edge" }
```

> `condition` は「考えうるあらゆる条件」への拡張ポイントです。
> ディスク残量、DBの件数、外部APIの状態など、コマンドで判定できるものは何でもトリガーにできます。

## アクション（何を実行するか）

```json
"action": {
  "skill": "daily-report",          // スキル名（"/daily-report" として実行）
  "args": "{path}",                 // スキルへの引数（プレースホルダ可）
  "prompt": null,                   // skill の代わりに直接プロンプトを実行
  "cwd": ".",                       // 実行ディレクトリ（スキルはここから探索される）
  "allowedTools": ["Read", "Bash(git *)"],  // 許可するツール
  "permissionMode": "default",      // default / acceptEdits / plan / bypassPermissions
  "model": null,                    // 例: "claude-sonnet-5"（省略時は既定モデル）
  "maxTurns": null,
  "timeoutMinutes": 15,
  "extraArgs": []                   // claude CLI へ渡す追加引数
}
```

### プレースホルダ（テンプレート変数）

`args` / `prompt` の中で使えます:

| 変数 | 内容 |
| --- | --- |
| `{path}` | イベント対象の絶対パス（batch時は改行区切り） |
| `{file}` | ファイル名 |
| `{dir}` | 親ディレクトリ |
| `{relpath}` | 監視フォルダからの相対パス |
| `{event}` | イベント種別（file_created など） |
| `{payload}` | Webhook の受信ボディ |
| `{output}` | condition コマンドの標準出力 |
| `{now}` `{taskId}` `{taskName}` `{count}` | 実行時刻・タスク情報 |

## 結果の報告

- **Markdown レポート**: `reports/<タスクID>/<日時>-<実行ID>.md`（ステータス・所要時間・実行プロンプト・結果本文）
- **実行履歴**: `reports/history.jsonl`（ダッシュボードと `history` コマンドで閲覧）
- **通知**: `settings.notify` で設定
  - `command`: 任意のコマンドを実行。`{summary}` `{status}` 等のプレースホルダと、環境変数 `SCHED_TASK_NAME` `SCHED_STATUS` `SCHED_RESULT` `SCHED_REPORT` などが使えます
  - `webhookUrl`: JSON を POST（`text` フィールド付きなので **Slack Incoming Webhook にそのまま対応**）
  - 例（macOS 通知）: `"command": "osascript -e 'display notification \"{summary}\" with title \"Scheduler\"'"`

## Web ダッシュボード（誰でも管理・実行）

`start` すると `http://127.0.0.1:8787/` で管理画面が開きます。

- タスクの一覧・次回実行時刻・実行状態の確認
- フォームからのタスク追加（トリガー種別ごとの入力欄）・JSON編集・削除
- 有効/無効の切り替え、**「▶ 実行」ボタンで今すぐ実行**
- 実行履歴とレポート本文の閲覧（10秒ごと自動更新）

チームで共有する場合は `settings.web` を変更します:

```json
"web": { "enabled": true, "host": "0.0.0.0", "port": 8787, "token": "秘密のトークン" }
```

`token` を設定すると API 操作にトークンが必要になります（画面を開くと入力を促されます）。
**LAN に公開する場合は必ず token を設定してください。**

## CLI リファレンス

```
skill-scheduler init                 設定ファイルを作成
skill-scheduler start                スケジューラー起動（--no-web でWeb無効）
skill-scheduler list                 タスク一覧と次回実行時刻
skill-scheduler add [オプション]     タスク追加（skill-scheduler help 参照）
skill-scheduler remove <id>          タスク削除
skill-scheduler enable/disable <id>  有効/無効
skill-scheduler run <id>             今すぐ1回実行（デーモン不要・動作確認に便利）
skill-scheduler history [--limit N]  実行履歴
skill-scheduler skills               利用可能なスキル一覧（.claude/skills 等を走査）
skill-scheduler validate             設定ファイルの検証
skill-scheduler service              常駐化用の systemd / launchd 設定を出力
```

共通: `--config <path>`（既定 `./scheduler.config.json`）

デーモン起動中でも設定ファイルの変更（CLI での add/remove を含む）は**自動で再読み込み**されます。

## 常駐させる

`skill-scheduler service` が環境に合わせた設定を出力します。

- **Linux**: systemd ユーザーユニット（`systemctl --user enable --now skill-scheduler`）
- **macOS**: launchd（`launchctl load ~/Library/LaunchAgents/...`）
- **とりあえず**: `nohup skill-scheduler start > /dev/null 2>&1 &`

## 動作確認（サブスク枠を消費しないドライラン）

`tools/mock-claude.js` は claude CLI のモックです。設定で差し替えると、
実際に Claude を呼ばずにトリガー・レポート・通知の流れをテストできます。

```json
"settings": { "claudeCommand": "/path/to/repo/tools/mock-claude.js" }
```

## 注意点

- **レート制限**: サブスクプランには使用量上限があります。`maxConcurrentRuns`（既定2）と
  実行間隔は控えめに設定してください。`interval` を数分おきにするような設定は上限を消費します
- **権限**: 既定の `permissionMode: "default"` ではファイル編集等が許可されず失敗することがあります。
  自動化タスクには `allowedTools` で必要最小限のツールを許可するのが安全です。
  `bypassPermissions` は全ツールを許可するため、信頼できるタスクだけに使ってください
- **スキルの場所**: スキルは `action.cwd` から見た `.claude/skills/`（プロジェクト）または
  `~/.claude/skills/`（ユーザー共通）に置いてください。`skill-scheduler skills` で確認できます
- **タイムゾーン**: 実行マシンのローカルタイムで判定します
- **catchUp**: `options.catchUp: true` を付けると、スケジューラー停止中に過ぎた予定を起動時に1回だけ追い付き実行します

## 設定ファイルの全体像

`examples/scheduler.config.example.json` に**全トリガー種別のサンプル**があります。

## 開発

```bash
npm test   # ユニットテスト（node:test / 依存なし）
```

主なモジュール:

| ファイル | 役割 |
| --- | --- |
| `src/daemon.js` | 本体（tickループ・実行キュー・ホットリロード） |
| `src/triggers.js` | トリガー定義・検証・次回実行時刻の計算 |
| `src/cron.js` | cron式パーサー |
| `src/watcher.js` | ポーリング式ファイル監視 |
| `src/runner.js` | `claude -p` の起動と結果パース |
| `src/reporter.js` | レポート保存・履歴・通知 |
| `src/server.js` | REST API + Webhook + ダッシュボード配信 |
| `src/cli.js` | コマンドライン |

## ライセンス

MIT
