/**
 * 実行結果の報告まわり:
 *   - Markdown レポートの保存 (reports/<taskId>/<timestamp>-<runId>.md)
 *   - 実行履歴 (reports/history.jsonl) への追記・読み出し
 *   - 通知（任意コマンド実行 / Webhook URL への POST）
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { formatLocal, template, timestampSlug, truncate } from "./util.js";

const STATUS_LABELS = {
  success: "✅ 成功",
  failure: "❌ 失敗",
  timeout: "⏱ タイムアウト",
  error: "🚫 起動エラー",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

/** Markdownレポートを書き出し、record.reportPath を設定して返す */
export async function writeReport(record, { reportsDir }) {
  const dir = path.join(reportsDir, record.taskId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${timestampSlug(new Date(record.startedAt))}-${record.runId}.md`);

  const lines = [
    `# 実行レポート: ${record.taskName}`,
    "",
    `| 項目 | 値 |`,
    `| --- | --- |`,
    `| タスクID | ${record.taskId} |`,
    `| 実行ID | ${record.runId} |`,
    `| トリガー | ${record.triggerType} (${record.event}) |`,
    `| ステータス | ${statusLabel(record.status)} |`,
    `| 開始 | ${formatLocal(new Date(record.startedAt))} |`,
    `| 終了 | ${formatLocal(new Date(record.endedAt))} |`,
    `| 所要時間 | ${Math.round(record.durationMs / 1000)} 秒 |`,
    `| 試行回数 | ${record.attempts} |`,
  ];
  if (record.context?.path) lines.push(`| 対象パス | ${record.context.path.replaceAll("\n", "<br>")} |`);
  if (record.numTurns != null) lines.push(`| ターン数 | ${record.numTurns} |`);
  if (record.costUsd != null) lines.push(`| コスト参考値 | $${Number(record.costUsd).toFixed(4)} |`);
  if (record.sessionId) lines.push(`| セッションID | ${record.sessionId} |`);

  lines.push("", "## 実行したプロンプト", "", "```", record.prompt, "```", "");

  if (record.error) {
    lines.push("## エラー", "", record.error, "");
    if (record.stderr) lines.push("```", record.stderr, "```", "");
  }

  lines.push("## 結果", "", record.resultText || "（出力なし）", "");

  await fs.writeFile(file, lines.join("\n"), "utf8");
  record.reportPath = file;
  return file;
}

/** 履歴（jsonl）に1行追記。巨大なフィールドは切り詰めて保存 */
export async function appendHistory(record, { reportsDir }) {
  await fs.mkdir(reportsDir, { recursive: true });
  const historyFile = path.join(reportsDir, "history.jsonl");
  const compact = {
    ...record,
    resultText: truncate(record.resultText, 2000),
    stderr: truncate(record.stderr, 1000),
    prompt: truncate(record.prompt, 500),
  };
  await fs.appendFile(historyFile, `${JSON.stringify(compact)}\n`, "utf8");
}

/** 履歴を新しい順に最大 limit 件読む */
export async function readHistory({ reportsDir }, limit = 50) {
  const historyFile = path.join(reportsDir, "history.jsonl");
  let raw;
  try {
    raw = await fs.readFile(historyFile, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean);
  const records = [];
  for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch { /* 壊れた行はスキップ */ }
  }
  return records;
}

/** 通知（settings.notify とタスクの options.notify に従う） */
export async function notify(record, settings, logger) {
  const conf = settings.notify ?? {};
  const isSuccess = record.status === "success";
  if (isSuccess && conf.onSuccess === false) return;
  if (!isSuccess && conf.onFailure === false) return;

  const summary =
    `${statusLabel(record.status)} ${record.taskName} ` +
    `(${Math.round(record.durationMs / 1000)}秒) — ${truncate(record.resultText, 300).replaceAll("\n", " ")}`;

  if (conf.command) {
    const cmd = template(conf.command, {
      taskId: record.taskId,
      taskName: record.taskName,
      status: record.status,
      summary,
      report: record.reportPath ?? "",
    });
    const env = {
      ...process.env,
      SCHED_TASK_ID: record.taskId,
      SCHED_TASK_NAME: record.taskName,
      SCHED_STATUS: record.status,
      SCHED_REPORT: record.reportPath ?? "",
      SCHED_RESULT: truncate(record.resultText, 4000),
      SCHED_SUMMARY: summary,
    };
    await new Promise((resolve) => {
      exec(cmd, { env, timeout: 60_000 }, (err) => {
        if (err) logger?.warn(`通知コマンドが失敗しました: ${err.message}`);
        resolve();
      });
    });
  }

  if (conf.webhookUrl) {
    try {
      const res = await fetch(conf.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: summary, // Slack Incoming Webhook 互換
          taskId: record.taskId,
          taskName: record.taskName,
          status: record.status,
          startedAt: record.startedAt,
          durationMs: record.durationMs,
          result: truncate(record.resultText, 4000),
          reportPath: record.reportPath,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) logger?.warn(`通知Webhookがエラーを返しました: HTTP ${res.status}`);
    } catch (e) {
      logger?.warn(`通知Webhookの送信に失敗しました: ${e.message}`);
    }
  }
}
