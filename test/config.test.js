import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTask, validateTask, validateConfig, initialConfig } from "../src/config.js";

test("normalizeTask: デフォルト補完とID採番", () => {
  const t = normalizeTask({
    name: "My Task",
    trigger: { type: "daily", at: "09:00" },
    action: { skill: "report" },
  });
  assert.equal(t.id, "my-task");
  assert.equal(t.enabled, true);
  assert.equal(t.action.cwd, ".");
  assert.equal(t.action.permissionMode, "default");
  assert.equal(t.action.timeoutMinutes, 15);
  assert.equal(t.options.retries, 0);
  assert.equal(t.options.notify, true);
});

test("normalizeTask: 日本語名でもIDが生成される", () => {
  const t = normalizeTask({
    name: "毎朝レポート",
    trigger: { type: "daily", at: "09:00" },
    action: { skill: "report" },
  });
  assert.ok(/^task-[0-9a-f]{8}$/.test(t.id));
  // 英数字が少し混ざる名前でも短すぎる slug は使わない
  const t2 = normalizeTask({
    name: "平日9時",
    trigger: { type: "daily", at: "09:00" },
    action: { skill: "report" },
  });
  assert.ok(/^task-[0-9a-f]{8}$/.test(t2.id));
});

test("validateTask: skill と prompt の排他、不正な値の検出", () => {
  const base = { id: "t1", trigger: { type: "daily", at: "09:00" } };
  assert.ok(validateTask({ ...base, action: {} }).length > 0); // どちらも無し
  assert.ok(
    validateTask({ ...base, action: { skill: "a", prompt: "b" } }).length > 0
  ); // 両方指定
  assert.equal(validateTask({ ...base, action: { skill: "report" } }).length, 0);
  assert.ok(
    validateTask({ ...base, action: { skill: "bad name!" } }).length > 0
  );
  assert.ok(
    validateTask({ ...base, action: { skill: "a", permissionMode: "yolo" } }).length > 0
  );
  assert.ok(
    validateTask({ ...base, action: { skill: "a", timeoutMinutes: -1 } }).length > 0
  );
});

test("validateConfig: ID重複を検出する", () => {
  const task = normalizeTask({
    id: "dup",
    trigger: { type: "manual" },
    action: { skill: "x" },
  });
  const errors = validateConfig({ tasks: [task, { ...task }] });
  assert.ok(errors.some((e) => e.includes("重複")));
});

test("initialConfig: そのまま検証を通る", () => {
  const config = initialConfig();
  assert.deepEqual(validateConfig(config), []);
});
