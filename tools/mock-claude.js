#!/usr/bin/env node
/**
 * claude CLI のモック。実際のサブスク枠を消費せずに
 * スケジューラーの動作確認（ドライラン）をするためのツール。
 *
 * 使い方: scheduler.config.json の settings.claudeCommand を
 *         "node <このリポジトリ>/tools/mock-claude.js" ではなく、
 *         実行可能なパスとして指定する場合は
 *         "claudeCommand": "/path/to/repo/tools/mock-claude.js" とする
 *         （chmod +x 済み）。
 */
const args = process.argv.slice(2);
const pIndex = args.indexOf("-p");
const prompt = pIndex >= 0 ? args[pIndex + 1] : "(no prompt)";

const result = {
  type: "result",
  subtype: "success",
  result: `モック実行しました。受け取ったプロンプト:\n${prompt}`,
  total_cost_usd: 0,
  duration_ms: 100,
  num_turns: 1,
  session_id: "mock-session",
};
console.log(JSON.stringify(result));
