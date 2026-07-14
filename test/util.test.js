import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration, parseTimeOfDay, parseDateTime, template, matchPatterns, globToRegExp } from "../src/util.js";

test("parseDuration: 単位付き・複合・数値のみ", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration("90"), 90_000); // 数値のみは秒
  assert.equal(parseDuration(60), 60_000);
  assert.equal(parseDuration("abc"), null);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("0s"), null);
});

test("parseTimeOfDay / parseDateTime", () => {
  assert.deepEqual(parseTimeOfDay("09:30"), { h: 9, m: 30 });
  assert.deepEqual(parseTimeOfDay("23:59"), { h: 23, m: 59 });
  assert.equal(parseTimeOfDay("24:00"), null);
  assert.equal(parseTimeOfDay("9時"), null);
  assert.ok(parseDateTime("2026-07-14 09:00") instanceof Date);
  assert.ok(parseDateTime("2026-07-14T09:00:00") instanceof Date);
  assert.equal(parseDateTime("invalid"), null);
});

test("template: プレースホルダ置換（未定義キーは空文字）", () => {
  assert.equal(
    template("ファイル {path} を {event} で処理", { path: "/tmp/a.csv", event: "file_created" }),
    "ファイル /tmp/a.csv を file_created で処理"
  );
  assert.equal(template("{missing}!", {}), "!");
});

test("globToRegExp / matchPatterns", () => {
  assert.ok(globToRegExp("*.csv").test("data.csv"));
  assert.ok(!globToRegExp("*.csv").test("data.txt"));
  assert.ok(globToRegExp("report-?.md").test("report-1.md"));
  assert.ok(globToRegExp("**/*.csv").test("a/b/c.csv"));
  // パターン未指定は常にマッチ
  assert.equal(matchPatterns(null, "a/b.txt"), true);
  assert.equal(matchPatterns([], "a/b.txt"), true);
  // "/" を含まないパターンはファイル名と照合
  assert.equal(matchPatterns("*.csv", "sub/dir/data.csv"), true);
  // "/" を含むパターンは相対パス全体と照合
  assert.equal(matchPatterns("sub/*.csv", "sub/data.csv"), true);
  assert.equal(matchPatterns("sub/*.csv", "other/data.csv"), false);
  // 複数パターンは OR
  assert.equal(matchPatterns(["*.csv", "*.xlsx"], "a.xlsx"), true);
});
