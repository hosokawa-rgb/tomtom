# Codex Desktop Mobile Bridge

スマホから Codex デスクトップ運用PCへ指示を送れる、最小構成のローカルブリッジです。

## できること

- スマホのブラウザから指示文を送信
- デスクトップ側のキューファイルへ追記
- 監視スクリプトがキューを読み、`codex` CLI を順番に実行

## 使い方

### 1) デスクトップで Web 受付を起動

```bash
python3 mobile_bridge.py --host 0.0.0.0 --port 8765 --token 'YOUR_SECRET_TOKEN'
```

### 2) スマホでアクセス

同じネットワークなら次のURLを開いてください。

```text
http://<デスクトップIP>:8765/?token=YOUR_SECRET_TOKEN
```

### 3) デスクトップで実行ワーカーを起動

```bash
python3 desktop_runner.py --queue ./var/mobile_prompts.jsonl --archive ./var/mobile_prompts.done.jsonl
```

## セキュリティ注意

- `--token` は必ず推測困難な値にしてください
- 外部公開する場合は Tailscale / Cloudflare Tunnel / HTTPS リバースプロキシを併用してください
- 共有PCでの利用は推奨しません

## 動作確認（ローカル）

```bash
python3 -m py_compile mobile_bridge.py desktop_runner.py
python3 desktop_runner.py --dry-run
```
