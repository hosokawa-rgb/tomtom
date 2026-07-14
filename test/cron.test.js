import test from "node:test";
import assert from "node:assert/strict";
import { parseCron, cronMatches, cronNext } from "../src/cron.js";

test("parseCron: 基本形をパースできる", () => {
  const spec = parseCron("*/15 9-18 * * 1-5");
  assert.equal(spec.minute.has(0), true);
  assert.equal(spec.minute.has(15), true);
  assert.equal(spec.minute.has(20), false);
  assert.equal(spec.hour.has(9), true);
  assert.equal(spec.hour.has(19), false);
  assert.equal(spec.dow.has(1), true);
  assert.equal(spec.dow.has(0), false);
});

test("parseCron: 曜日名と月名、7=日曜の正規化", () => {
  const spec = parseCron("0 0 * jan sun");
  assert.equal(spec.month.has(1), true);
  assert.equal(spec.month.has(2), false);
  assert.equal(spec.dow.has(0), true);
  const spec7 = parseCron("0 0 * * 7");
  assert.equal(spec7.dow.has(0), true);
});

test("parseCron: エイリアス @daily", () => {
  const spec = parseCron("@daily");
  assert.equal(spec.minute.has(0), true);
  assert.equal(spec.hour.has(0), true);
  assert.equal(spec.hour.has(1), false);
});

test("parseCron: 不正な式は例外", () => {
  assert.throws(() => parseCron("* * * *"));
  assert.throws(() => parseCron("60 * * * *"));
  assert.throws(() => parseCron("* * * * 8"));
  assert.throws(() => parseCron("a * * * *"));
});

test("cronMatches: 平日9時", () => {
  const spec = parseCron("0 9 * * 1-5");
  // 2026-07-13 は月曜
  assert.equal(cronMatches(spec, new Date(2026, 6, 13, 9, 0)), true);
  assert.equal(cronMatches(spec, new Date(2026, 6, 12, 9, 0)), false); // 日曜
  assert.equal(cronMatches(spec, new Date(2026, 6, 13, 10, 0)), false);
});

test("cronNext: 次の実行時刻を返す", () => {
  const next = cronNext("0 9 * * *", new Date(2026, 6, 13, 10, 0));
  assert.deepEqual(next, new Date(2026, 6, 14, 9, 0));
  // 同時刻ちょうどは「次」を返す
  const next2 = cronNext("0 9 * * *", new Date(2026, 6, 13, 9, 0));
  assert.deepEqual(next2, new Date(2026, 6, 14, 9, 0));
  // 直前なら当日
  const next3 = cronNext("0 9 * * *", new Date(2026, 6, 13, 8, 59));
  assert.deepEqual(next3, new Date(2026, 6, 13, 9, 0));
});

test("cronNext: 毎月1日 0:00", () => {
  const next = cronNext("@monthly", new Date(2026, 6, 13, 10, 0));
  assert.deepEqual(next, new Date(2026, 7, 1, 0, 0));
});

test("cronNext: dom と dow の両指定は OR（標準cron互換）", () => {
  // 13日 または 金曜
  const spec = parseCron("0 0 13 * 5");
  const from = new Date(2026, 6, 13, 10, 0); // 7/13(月) 10時
  const next = cronNext(spec, from);
  // 次の金曜(7/17)より前に来る「14日」は dom=13 に合わないので、7/17(金)
  assert.deepEqual(next, new Date(2026, 6, 17, 0, 0));
});
