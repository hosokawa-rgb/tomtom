# Googleカレンダーの「（実測）」予定から日報を自動作成する

このリポジトリは、Googleカレンダーの予定タイトルに **`（実測）`** を含む予定だけを抽出し、
以下を自動生成するサンプルです。

- 日報（作業ログ）
- 本日の気づき（ルールベース）

> まずはローカルでMarkdownを生成し、必要に応じてSlack/Notion/メールに連携できます。

## セットアップ

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Google Calendar API の準備

1. Google Cloud でプロジェクトを作成
2. Google Calendar API を有効化
3. OAuth クライアントID（デスクトップアプリ）を作成
4. `credentials.json` をプロジェクトルートに保存

初回実行時にブラウザ認証が開き、`token.json` が生成されます。

## 使い方

### 1) Googleカレンダーから直接生成

```bash
python scripts/generate_daily_report.py \
  --date 2026-03-04 \
  --calendar-id primary \
  --timezone Asia/Tokyo \
  --output reports/2026-03-04.md
```

### 2) JSONファイルから生成（検証/テスト向け）

```bash
python scripts/generate_daily_report.py \
  --date 2026-03-04 \
  --from-file sample_events.json \
  --output reports/2026-03-04.md
```

## 生成内容

- 実測予定の一覧（開始・終了・時間・タイトル）
- 合計稼働時間
- カテゴリ別（会議 / 開発 / 調査 / その他）集計
- 「本日の気づき」
  - 会議比率が高い
  - 調査が多い
  - 深い作業時間（90分以上）がある

## 運用のコツ

- 予定タイトルは `（実測）` を先頭に付けると管理しやすい
  - 例: `（実測）API調査`, `（実測）定例MTG`
- 日次バッチ化したい場合は cron / GitHub Actions で毎日18:00実行
- 気づき文面をLLMに任せたい場合は、生成したMarkdownをプロンプト入力に使う
