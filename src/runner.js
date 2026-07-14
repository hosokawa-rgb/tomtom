/**
 * Claude Code CLI（サブスクプランのログイン認証をそのまま利用）を
 * ヘッドレスモード（claude -p）で起動してスキル/プロンプトを実行する。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { shortId, template, formatLocal } from "./util.js";

const STDOUT_LIMIT = 10 * 1024 * 1024; // 10MB

/** 実行するプロンプト文字列を組み立てる（スキルは "/skill名 引数" 形式） */
export function buildPrompt(action, vars = {}) {
  if (action.skill) {
    const args = action.args ? ` ${template(action.args, vars)}` : "";
    return `/${action.skill}${args}`;
  }
  return template(action.prompt, vars);
}

/** claude CLI に渡す引数配列を組み立てる */
export function buildClaudeArgs(action, prompt) {
  const args = ["-p", prompt, "--output-format", "json"];
  if (Array.isArray(action.allowedTools) && action.allowedTools.length > 0) {
    args.push("--allowedTools", action.allowedTools.join(","));
  }
  if (action.permissionMode && action.permissionMode !== "default") {
    args.push("--permission-mode", action.permissionMode);
  }
  if (action.model) args.push("--model", String(action.model));
  if (action.maxTurns) args.push("--max-turns", String(action.maxTurns));
  if (Array.isArray(action.extraArgs)) args.push(...action.extraArgs.map(String));
  return args;
}

function spawnClaude({ command, args, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 10_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < STDOUT_LIMIT) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < STDOUT_LIMIT) stderr += chunk;
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (err) => {
      finish({ exitCode: null, stdout, stderr, timedOut, spawnError: err });
    });
    child.on("close", (code) => {
      finish({ exitCode: code, stdout, stderr, timedOut, spawnError: null });
    });
  });
}

/** claude --output-format json の出力をパース（失敗したら null） */
export function parseClaudeOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // 前後に警告等が混ざった場合に備え、行単位で後ろから試す
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith("{")) continue;
      try {
        return JSON.parse(line);
      } catch { /* 次の行へ */ }
    }
    return null;
  }
}

/**
 * タスクを1回実行して実行記録（record）を返す。リトライもここで行う。
 * @param {object} params
 * @param {object} params.task       正規化済みタスク
 * @param {object} params.settings   全体設定
 * @param {string} params.configDir  設定ファイルのあるディレクトリ（相対パス基準）
 * @param {object} params.context    トリガーイベント情報（テンプレート変数になる）
 * @param {object} params.logger
 */
export async function runTask({ task, settings, configDir, context = {}, logger }) {
  const runId = shortId("run-");
  const startedAt = new Date();
  const vars = {
    taskId: task.id,
    taskName: task.name,
    now: formatLocal(startedAt),
    event: context.event ?? "manual",
    path: context.path ?? "",
    file: context.file ?? "",
    dir: context.dir ?? "",
    relpath: context.relpath ?? "",
    root: context.root ?? "",
    payload: context.payload ?? "",
    output: context.output ?? "",
    count: context.count ?? "",
  };

  const prompt = buildPrompt(task.action, vars);
  const args = buildClaudeArgs(task.action, prompt);
  const cwd = path.resolve(configDir, task.action.cwd ?? ".");
  const timeoutMs = Math.max(1, Number(task.action.timeoutMinutes ?? 15)) * 60_000;
  const maxAttempts = 1 + Math.max(0, Number(task.options?.retries ?? 0));
  const retryDelayMs = Math.max(0, Number(task.options?.retryDelaySeconds ?? 60)) * 1000;

  logger?.info(`実行開始 [${task.id}] ${runId} prompt="${prompt.slice(0, 120)}"`);

  let attempt = 0;
  let outcome = null;
  while (attempt < maxAttempts) {
    attempt++;
    outcome = await spawnClaude({
      command: settings.claudeCommand,
      args,
      cwd,
      timeoutMs,
    });
    const ok = !outcome.spawnError && !outcome.timedOut && outcome.exitCode === 0;
    if (ok) break;
    if (attempt < maxAttempts) {
      logger?.warn(`実行失敗 [${task.id}] ${runId} (試行 ${attempt}/${maxAttempts})、${retryDelayMs / 1000}秒後にリトライします`);
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  const endedAt = new Date();
  const parsed = parseClaudeOutput(outcome.stdout);

  let status;
  let error = null;
  if (outcome.spawnError) {
    status = "error";
    error =
      `claude コマンドを起動できませんでした: ${outcome.spawnError.message}\n` +
      `settings.claudeCommand（現在: "${settings.claudeCommand}"）を確認してください。`;
  } else if (outcome.timedOut) {
    status = "timeout";
    error = `タイムアウト（${task.action.timeoutMinutes ?? 15}分）のため中断しました`;
  } else if (outcome.exitCode !== 0) {
    status = "failure";
    error = `claude が終了コード ${outcome.exitCode} で終了しました`;
  } else if (parsed && parsed.subtype && parsed.subtype !== "success") {
    status = "failure";
    error = `claude が subtype="${parsed.subtype}" を返しました（最大ターン数超過など）`;
  } else {
    status = "success";
  }

  const resultText = parsed?.result ?? String(outcome.stdout ?? "").trim();

  const record = {
    runId,
    taskId: task.id,
    taskName: task.name,
    triggerType: task.trigger?.type ?? "manual",
    event: vars.event,
    context: {
      path: vars.path,
      relpath: vars.relpath,
      payload: typeof vars.payload === "string" ? vars.payload.slice(0, 4000) : "",
    },
    prompt,
    cwd,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    attempts: attempt,
    status,
    exitCode: outcome.exitCode,
    error,
    resultText,
    stderr: String(outcome.stderr ?? "").trim().slice(0, 8000),
    costUsd: parsed?.total_cost_usd ?? null,
    numTurns: parsed?.num_turns ?? null,
    sessionId: parsed?.session_id ?? null,
    reportPath: null, // reporter が設定する
  };

  logger?.info(
    `実行終了 [${task.id}] ${runId} status=${status} ` +
    `(${Math.round(record.durationMs / 1000)}秒, 試行${attempt}回)`
  );
  return record;
}
