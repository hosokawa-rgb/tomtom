#!/usr/bin/env python3
"""Simple mobile-to-desktop command bridge for Codex CLI.

Run on the desktop machine:
  python3 mobile_bridge.py --host 0.0.0.0 --port 8765 --token <secret>

Open from smartphone:
  http://<desktop-ip>:8765/?token=<secret>

Submitted prompts are appended to a JSONL queue file.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HTML_PAGE = """<!doctype html>
<html lang=\"ja\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\" />
  <title>Codex Mobile Bridge</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 16px; background: #fafafa; }
    .card { background: white; border-radius: 12px; padding: 16px; box-shadow: 0 1px 5px rgba(0,0,0,.12); }
    textarea { width: 100%; min-height: 160px; font-size: 16px; }
    button { margin-top: 12px; width: 100%; height: 48px; font-size: 16px; border: 0; border-radius: 10px; background: #2563eb; color: white; }
    .ok { color: #065f46; font-weight: 700; }
    .err { color: #991b1b; font-weight: 700; }
    code { word-break: break-all; }
  </style>
</head>
<body>
  <div class=\"card\">
    <h2>Codex へ指示を送信</h2>
    <p>スマホから指示を送ると、デスクトップ側キューに追加されます。</p>
    {message}
    <form method=\"post\" action=\"/submit\">
      <input type=\"hidden\" name=\"token\" value=\"{token}\" />
      <textarea name=\"prompt\" placeholder=\"例: バグ#123の原因を調査して\"></textarea>
      <button type=\"submit\">送信</button>
    </form>
  </div>
</body>
</html>
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class QueueStore:
    def __init__(self, queue_path: Path) -> None:
        self.queue_path = queue_path
        self._lock = threading.Lock()
        self.queue_path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, prompt: str, source: str) -> str:
        record_id = secrets.token_hex(8)
        record = {
            "id": record_id,
            "prompt": prompt,
            "source": source,
            "created_at": utc_now(),
        }
        line = json.dumps(record, ensure_ascii=False)
        with self._lock:
            with self.queue_path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        return record_id


class BridgeHandler(BaseHTTPRequestHandler):
    queue: QueueStore
    token: str

    def _send_html(self, body: str, status: int = 200) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _parse_params(self) -> dict[str, str]:
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        return {k: v[0] for k, v in params.items() if v}

    def _auth_ok(self, token: str | None) -> bool:
        return bool(token) and secrets.compare_digest(token, self.token)

    def do_GET(self) -> None:
        params = self._parse_params()
        token = params.get("token")
        if not self._auth_ok(token):
            self._send_html("<h3>Unauthorized</h3><p>?token=... を指定してください。</p>", HTTPStatus.UNAUTHORIZED)
            return
        page = HTML_PAGE.format(token=token, message="")
        self._send_html(page)

    def do_POST(self) -> None:
        if self.path != "/submit":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(content_length).decode("utf-8")
        form = parse_qs(raw)
        token = form.get("token", [""])[0]
        prompt = form.get("prompt", [""])[0].strip()

        if not self._auth_ok(token):
            self._send_html("<h3>Unauthorized</h3>", HTTPStatus.UNAUTHORIZED)
            return

        if not prompt:
            msg = "<p class=\"err\">prompt が空です。</p>"
            self._send_html(HTML_PAGE.format(token=token, message=msg), HTTPStatus.BAD_REQUEST)
            return

        record_id = self.queue.append(prompt=prompt, source=self.client_address[0])
        msg = f"<p class=\"ok\">送信しました: <code>{record_id}</code></p>"
        self._send_html(HTML_PAGE.format(token=token, message=msg))

    def log_message(self, format: str, *args) -> None:
        return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Mobile bridge for Codex prompts")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token", default=os.environ.get("MOBILE_BRIDGE_TOKEN", ""))
    parser.add_argument("--queue", default="./var/mobile_prompts.jsonl")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    token = args.token or secrets.token_urlsafe(16)
    queue = QueueStore(Path(args.queue))

    BridgeHandler.queue = queue
    BridgeHandler.token = token

    server = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    print("[mobile-bridge] started")
    print(f"[mobile-bridge] open: http://{args.host}:{args.port}/?token={token}")
    print(f"[mobile-bridge] queue: {Path(args.queue).resolve()}")
    server.serve_forever()


if __name__ == "__main__":
    main()
