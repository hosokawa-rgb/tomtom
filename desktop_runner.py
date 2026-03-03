#!/usr/bin/env python3
"""Consume queued mobile prompts and run codex CLI.

Example:
  python3 desktop_runner.py --queue ./var/mobile_prompts.jsonl --archive ./var/mobile_prompts.done.jsonl
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Desktop queue runner for mobile bridge")
    parser.add_argument("--queue", default="./var/mobile_prompts.jsonl")
    parser.add_argument("--archive", default="./var/mobile_prompts.done.jsonl")
    parser.add_argument("--poll-seconds", type=float, default=1.5)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def read_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8").splitlines()


def write_lines(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def run_codex(prompt: str, dry_run: bool) -> int:
    if dry_run:
        print(f"[dry-run] {prompt}")
        return 0
    proc = subprocess.run(["codex", prompt])
    return proc.returncode


def main() -> None:
    args = parse_args()
    queue_path = Path(args.queue)
    archive_path = Path(args.archive)

    print(f"[desktop-runner] watching: {queue_path.resolve()}")
    while True:
        lines = read_lines(queue_path)
        if not lines:
            time.sleep(args.poll_seconds)
            continue

        current = lines[0]
        rest = lines[1:]

        try:
            item = json.loads(current)
        except json.JSONDecodeError:
            print("[desktop-runner] invalid JSON line skipped")
            write_lines(queue_path, rest)
            continue

        prompt = str(item.get("prompt", "")).strip()
        if not prompt:
            print("[desktop-runner] empty prompt skipped")
            write_lines(queue_path, rest)
            continue

        print(f"[desktop-runner] running id={item.get('id')} ...")
        code = run_codex(prompt, args.dry_run)
        item["exit_code"] = code

        with archive_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
        write_lines(queue_path, rest)


if __name__ == "__main__":
    main()
