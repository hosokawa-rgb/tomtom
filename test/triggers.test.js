import test from "node:test";
import assert from "node:assert/strict";
import { computeNextRun, validateTrigger, triggerKind, watchEventsOf } from "../src/triggers.js";

// 2026-07-13 は月曜日
const MON_10AM = new Date(2026, 6, 13, 10, 0, 0);

test("daily: 当日の時刻前なら当日、過ぎていれば翌日", () => {
  assert.deepEqual(
    computeNextRun({ type: "daily", at: "18:00" }, MON_10AM),
    new Date(2026, 6, 13, 18, 0)
  );
  assert.deepEqual(
    computeNextRun({ type: "daily", at: "09:00" }, MON_10AM),
    new Date(2026, 6, 14, 9, 0)
  );
});

test("daily: 複数時刻に対応", () => {
  assert.deepEqual(
    computeNextRun({ type: "daily", at: ["09:00", "13:00"] }, MON_10AM),
    new Date(2026, 6, 13, 13, 0)
  );
});

test("weekly: 曜日名（英語・日本語・数値）で指定できる", () => {
  assert.deepEqual(
    computeNextRun({ type: "weekly", days: ["wed"], at: "09:00" }, MON_10AM),
    new Date(2026, 6, 15, 9, 0)
  );
  assert.deepEqual(
    computeNextRun({ type: "weekly", days: ["月"], at: "09:00" }, MON_10AM),
    new Date(2026, 6, 20, 9, 0) // 当日9時は過ぎているので翌週月曜
  );
  assert.deepEqual(
    computeNextRun({ type: "weekly", days: [1], at: "11:00" }, MON_10AM),
    new Date(2026, 6, 13, 11, 0)
  );
});

test("monthly: 日にち指定と last、存在しない日はスキップ", () => {
  assert.deepEqual(
    computeNextRun({ type: "monthly", day: 1, at: "09:00" }, MON_10AM),
    new Date(2026, 7, 1, 9, 0)
  );
  assert.deepEqual(
    computeNextRun({ type: "monthly", day: "last", at: "09:00" }, MON_10AM),
    new Date(2026, 6, 31, 9, 0)
  );
  // 31日指定 → 8/31 の次は 9月をスキップして 10/31 になる
  const from = new Date(2026, 7, 31, 10, 0);
  assert.deepEqual(
    computeNextRun({ type: "monthly", day: 31, at: "09:00" }, from),
    new Date(2026, 9, 31, 9, 0)
  );
});

test("once: 未来なら実行、過去・実行済みなら null", () => {
  assert.deepEqual(
    computeNextRun({ type: "once", at: "2026-07-14 09:00" }, MON_10AM),
    new Date(2026, 6, 14, 9, 0)
  );
  assert.equal(computeNextRun({ type: "once", at: "2026-07-01 09:00" }, MON_10AM), null);
  assert.equal(
    computeNextRun({ type: "once", at: "2026-07-14 09:00" }, new Date(2026, 6, 14, 9, 30), new Date(2026, 6, 14, 9, 0)),
    null
  );
});

test("interval: 前回実行からの経過で次回を決める", () => {
  const next = computeNextRun({ type: "interval", every: "30m" }, MON_10AM, null);
  assert.deepEqual(next, new Date(2026, 6, 13, 10, 30));
  const withLast = computeNextRun(
    { type: "interval", every: "30m" }, MON_10AM, new Date(2026, 6, 13, 9, 50)
  );
  assert.deepEqual(withLast, new Date(2026, 6, 13, 10, 20));
  // 間隔をとっくに過ぎていたら即時実行（= after 時刻）
  const overdue = computeNextRun(
    { type: "interval", every: "30m" }, MON_10AM, new Date(2026, 6, 13, 8, 0)
  );
  assert.deepEqual(overdue, MON_10AM);
});

test("イベント駆動系トリガーは nextRun を持たない", () => {
  for (const type of ["startup", "manual", "webhook", "condition", "file_created"]) {
    assert.equal(computeNextRun({ type, path: "./x", command: "true" }, MON_10AM), null);
  }
});

test("validateTrigger: 必須フィールドを検証する", () => {
  assert.equal(validateTrigger({ type: "daily", at: "09:00" }).length, 0);
  assert.ok(validateTrigger({ type: "daily", at: "25:00" }).length > 0);
  assert.ok(validateTrigger({ type: "weekly", at: "09:00" }).length > 0); // days なし
  assert.ok(validateTrigger({ type: "file_created" }).length > 0); // path なし
  assert.ok(validateTrigger({ type: "unknown" }).length > 0);
  assert.equal(validateTrigger({ type: "cron", expression: "0 9 * * 1-5" }).length, 0);
  assert.ok(validateTrigger({ type: "cron", expression: "bad" }).length > 0);
  assert.ok(validateTrigger({ type: "condition" }).length > 0); // command なし
});

test("triggerKind と watchEventsOf", () => {
  assert.equal(triggerKind({ type: "daily" }), "time");
  assert.equal(triggerKind({ type: "folder_entered" }), "watch");
  assert.equal(triggerKind({ type: "webhook" }), "webhook");
  assert.deepEqual(watchEventsOf({ type: "folder_entered" }), ["file_created", "folder_created"]);
  assert.deepEqual(watchEventsOf({ type: "watch", events: ["file_deleted"] }), ["file_deleted"]);
});
