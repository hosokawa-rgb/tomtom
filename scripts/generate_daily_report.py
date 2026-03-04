#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

MEASURED_TAG = "（実測）"


@dataclass
class WorkEvent:
    title: str
    start: dt.datetime
    end: dt.datetime

    @property
    def minutes(self) -> int:
        return max(0, int((self.end - self.start).total_seconds() // 60))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Googleカレンダーの（実測）予定から日報を生成します。"
    )
    parser.add_argument("--date", required=True, help="対象日 (YYYY-MM-DD)")
    parser.add_argument("--calendar-id", default="primary", help="Google Calendar ID")
    parser.add_argument("--timezone", default="Asia/Tokyo", help="タイムゾーン")
    parser.add_argument("--output", default="report.md", help="出力Markdownファイル")
    parser.add_argument(
        "--from-file",
        help="Google APIを使わず、events配列(JSON)から生成する場合のファイルパス",
    )
    return parser.parse_args()


def parse_iso_datetime(value: str, tz: ZoneInfo) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return parsed.astimezone(tz)


def normalize_google_event(raw: dict[str, Any], tz: ZoneInfo) -> WorkEvent | None:
    summary = raw.get("summary", "")
    if MEASURED_TAG not in summary:
        return None

    start_raw = raw.get("start", {}).get("dateTime")
    end_raw = raw.get("end", {}).get("dateTime")

    if not start_raw or not end_raw:
        return None

    start = parse_iso_datetime(start_raw, tz)
    end = parse_iso_datetime(end_raw, tz)

    return WorkEvent(title=summary, start=start, end=end)


def load_events_from_google(
    day: dt.date,
    calendar_id: str,
    tz: ZoneInfo,
) -> list[dict[str, Any]]:
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build

    scopes = ["https://www.googleapis.com/auth/calendar.readonly"]
    token_path = Path("token.json")
    creds_path = Path("credentials.json")

    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), scopes)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not creds_path.exists():
                raise FileNotFoundError(
                    "credentials.json が見つかりません。READMEの手順で作成してください。"
                )
            flow = InstalledAppFlow.from_client_secrets_file(str(creds_path), scopes)
            creds = flow.run_local_server(port=0)
        token_path.write_text(creds.to_json(), encoding="utf-8")

    service = build("calendar", "v3", credentials=creds)

    start_of_day = dt.datetime.combine(day, dt.time(0, 0), tzinfo=tz)
    end_of_day = start_of_day + dt.timedelta(days=1)

    res = (
        service.events()
        .list(
            calendarId=calendar_id,
            timeMin=start_of_day.isoformat(),
            timeMax=end_of_day.isoformat(),
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )
    return res.get("items", [])


def categorize(title: str) -> str:
    lowered = title.lower()
    if any(k in lowered for k in ["mtg", "meeting", "1on1", "定例", "打合せ", "会議"]):
        return "会議"
    if any(k in lowered for k in ["実装", "開発", "coding", "コーディング", "fix"]):
        return "開発"
    if any(k in lowered for k in ["調査", "検証", "research", "investigation"]):
        return "調査"
    return "その他"


def build_insights(events: list[WorkEvent]) -> list[str]:
    if not events:
        return ["実測予定がありませんでした。予定の記録ルールを再確認しましょう。"]

    total_minutes = sum(e.minutes for e in events)
    meeting_minutes = sum(e.minutes for e in events if categorize(e.title) == "会議")
    research_minutes = sum(e.minutes for e in events if categorize(e.title) == "調査")
    longest = max(events, key=lambda e: e.minutes)

    insights = []
    if total_minutes > 0 and meeting_minutes / total_minutes >= 0.4:
        insights.append("会議比率が40%以上でした。集中作業ブロックの確保余地があります。")
    if research_minutes >= 90:
        insights.append("調査・検証に90分以上使えており、意思決定の質向上につながっています。")
    if longest.minutes >= 90:
        insights.append(
            f"最長作業は『{longest.title}』で{longest.minutes}分。深い作業時間を確保できています。"
        )
    if not insights:
        insights.append("タスク配分は大きな偏りがなく、バランスよく進められました。")

    return insights


def render_markdown(day: dt.date, events: list[WorkEvent]) -> str:
    total_minutes = sum(e.minutes for e in events)

    category_totals: dict[str, int] = {}
    for e in events:
        c = categorize(e.title)
        category_totals[c] = category_totals.get(c, 0) + e.minutes

    lines: list[str] = []
    lines.append(f"# 日報 {day.isoformat()}")
    lines.append("")
    lines.append("## 作業ログ（実測）")
    lines.append("")

    if not events:
        lines.append("- 該当予定なし")
    else:
        for e in events:
            lines.append(
                f"- {e.start.strftime('%H:%M')} - {e.end.strftime('%H:%M')} ({e.minutes}分): {e.title}"
            )

    lines.append("")
    lines.append("## 集計")
    lines.append("")
    lines.append(f"- 合計稼働時間: {total_minutes}分 ({total_minutes / 60:.2f}時間)")

    if category_totals:
        lines.append("- カテゴリ内訳:")
        for category, minutes in sorted(category_totals.items(), key=lambda x: x[1], reverse=True):
            lines.append(f"  - {category}: {minutes}分")

    lines.append("")
    lines.append("## 本日の気づき")
    lines.append("")
    for insight in build_insights(events):
        lines.append(f"- {insight}")

    return "\n".join(lines) + "\n"


def main() -> None:
    args = parse_args()
    day = dt.date.fromisoformat(args.date)
    tz = ZoneInfo(args.timezone)

    if args.from_file:
        raw_events = json.loads(Path(args.from_file).read_text(encoding="utf-8"))
    else:
        raw_events = load_events_from_google(day=day, calendar_id=args.calendar_id, tz=tz)

    events = [
        e
        for raw in raw_events
        if (e := normalize_google_event(raw=raw, tz=tz)) is not None
    ]

    events.sort(key=lambda x: x.start)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(render_markdown(day=day, events=events), encoding="utf-8")
    print(f"Generated: {output_path}")


if __name__ == "__main__":
    main()
