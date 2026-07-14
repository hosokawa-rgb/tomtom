import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, buildClaudeArgs, parseClaudeOutput } from "../src/runner.js";

test("buildPrompt: スキルは /名前 引数、プレースホルダ置換つき", () => {
  assert.equal(
    buildPrompt({ skill: "daily-report", args: "" }, {}),
    "/daily-report"
  );
  assert.equal(
    buildPrompt({ skill: "summarize", args: "{path}" }, { path: "/data/in.csv" }),
    "/summarize /data/in.csv"
  );
  assert.equal(
    buildPrompt({ prompt: "ファイル {file} を処理" }, { file: "a.csv" }),
    "ファイル a.csv を処理"
  );
});

test("buildClaudeArgs: オプションをCLI引数に変換する", () => {
  const args = buildClaudeArgs(
    {
      allowedTools: ["Read", "Bash(git *)"],
      permissionMode: "acceptEdits",
      model: "claude-sonnet-5",
      maxTurns: 10,
      extraArgs: ["--add-dir", "/data"],
    },
    "/report"
  );
  assert.deepEqual(args, [
    "-p", "/report",
    "--output-format", "json",
    "--allowedTools", "Read,Bash(git *)",
    "--permission-mode", "acceptEdits",
    "--model", "claude-sonnet-5",
    "--max-turns", "10",
    "--add-dir", "/data",
  ]);
  // default モードや未指定は余計な引数を付けない
  assert.deepEqual(buildClaudeArgs({ permissionMode: "default" }, "hi"), [
    "-p", "hi", "--output-format", "json",
  ]);
});

test("parseClaudeOutput: JSON・混在出力・非JSONに対応", () => {
  const json = JSON.stringify({ type: "result", subtype: "success", result: "OK" });
  assert.equal(parseClaudeOutput(json).result, "OK");
  assert.equal(parseClaudeOutput(`warning: something\n${json}`).result, "OK");
  assert.equal(parseClaudeOutput("plain text"), null);
  assert.equal(parseClaudeOutput(""), null);
});
