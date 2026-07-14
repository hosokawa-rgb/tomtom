/**
 * 設定ファイル (scheduler.config.json) の読み書き・検証・正規化。
 * 設定は「settings」（全体設定）と「tasks」（タスク配列）の2部構成。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { shortId } from "./util.js";
import { validateTrigger, triggerKind } from "./triggers.js";

export const DEFAULT_CONFIG_FILENAME = "scheduler.config.json";

export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];

export const DEFAULT_SETTINGS = {
  // Claude Code CLI のコマンド名（PATHにない場合はフルパスを指定）
  claudeCommand: "claude",
  // 同時に実行する claude プロセス数の上限（サブスクのレート制限対策）
  maxConcurrentRuns: 2,
  // 時間トリガーの判定間隔（秒）
  tickSeconds: 15,
  // ファイル監視のポーリング間隔（秒）
  watchIntervalSeconds: 5,
  // 実行レポートの保存先
  reportsDir: "reports",
  // ログの保存先
  logsDir: "logs",
  // 実行状態（前回実行時刻など）の保存ファイル
  stateFile: ".scheduler-state.json",
  web: {
    // Webダッシュボード + Webhook 受信サーバー
    enabled: true,
    host: "127.0.0.1",
    port: 8787,
    // 設定すると API アクセスにトークンが必要になる
    token: null,
  },
  notify: {
    // 実行完了時に叩く任意のコマンド。{taskName} {status} 等のプレースホルダ可。
    // 環境変数 SCHED_TASK_ID / SCHED_STATUS / SCHED_REPORT / SCHED_RESULT も渡される。
    command: null,
    // 実行完了時に JSON を POST する URL（Slack Incoming Webhook 等）
    webhookUrl: null,
    onSuccess: true,
    onFailure: true,
  },
};

export const DEFAULT_TASK_OPTIONS = {
  catchUp: false, // 停止中に過ぎたスケジュールを起動時に1回実行するか
  retries: 0, // 失敗時のリトライ回数
  retryDelaySeconds: 60,
  concurrent: false, // 同一タスクの多重実行を許可するか
  notify: true, // このタスクの結果を通知するか
};

export const DEFAULT_ACTION = {
  skill: null, // スキル名（"/skill名 args" として実行）
  args: "",
  prompt: null, // スキルを使わず直接プロンプトを実行する場合
  cwd: ".",
  allowedTools: null, // 例: ["Read", "Bash(git *)"]
  permissionMode: "default",
  model: null,
  maxTurns: null,
  timeoutMinutes: 15,
  extraArgs: [], // claude CLI へのその他の引数
};

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v) &&
      base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function slugify(text) {
  const s = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  // 日本語名などで意味のある slug にならない場合はランダムIDにする
  return s.length >= 3 ? s : null;
}

/** タスク定義を正規化（デフォルト補完・ID採番） */
export function normalizeTask(task) {
  const t = { ...task };
  if (!t.id) t.id = slugify(t.name) ?? shortId("task-");
  t.name = t.name ?? t.id;
  t.enabled = t.enabled !== false;
  t.trigger = { ...(t.trigger ?? {}) };
  t.action = deepMerge(DEFAULT_ACTION, t.action ?? {});
  t.options = deepMerge(DEFAULT_TASK_OPTIONS, t.options ?? {});
  return t;
}

/** タスク定義を検証してエラー配列を返す（空なら正常） */
export function validateTask(task) {
  const errors = [];
  if (!task || typeof task !== "object") return ["タスクはオブジェクトで指定してください"];
  if (!task.id || !/^[A-Za-z0-9_-]+$/.test(task.id)) {
    errors.push(`id は英数字・ハイフン・アンダースコアで指定してください: "${task.id}"`);
  }
  errors.push(...validateTrigger(task.trigger).map((e) => `[${task.id}] ${e}`));

  const a = task.action ?? {};
  if (!a.skill && !a.prompt) {
    errors.push(`[${task.id}] action.skill または action.prompt のどちらかが必要です`);
  }
  if (a.skill && a.prompt) {
    errors.push(`[${task.id}] action.skill と action.prompt は同時に指定できません`);
  }
  if (a.skill && !/^[A-Za-z0-9:_-]+$/.test(a.skill)) {
    errors.push(`[${task.id}] action.skill の名前が不正です: "${a.skill}"`);
  }
  if (a.permissionMode && !PERMISSION_MODES.includes(a.permissionMode)) {
    errors.push(`[${task.id}] action.permissionMode は ${PERMISSION_MODES.join(" / ")} のいずれかです`);
  }
  if (a.timeoutMinutes !== undefined && a.timeoutMinutes !== null &&
    (!Number.isFinite(Number(a.timeoutMinutes)) || Number(a.timeoutMinutes) <= 0)) {
    errors.push(`[${task.id}] action.timeoutMinutes は正の数値で指定してください`);
  }
  return errors;
}

/** 設定全体を検証 */
export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") return ["設定ファイルのルートはオブジェクトである必要があります"];
  if (!Array.isArray(config.tasks)) {
    errors.push(`"tasks" は配列で指定してください`);
    return errors;
  }
  const ids = new Set();
  for (const task of config.tasks) {
    errors.push(...validateTask(task));
    if (task?.id) {
      if (ids.has(task.id)) errors.push(`タスクIDが重複しています: "${task.id}"`);
      ids.add(task.id);
    }
  }
  return errors;
}

/**
 * 設定ファイルを読み込んで正規化して返す。
 * @returns {{settings, tasks, path, dir, mtimeMs}}
 */
export async function loadConfig(configPath) {
  const abs = path.resolve(configPath);
  let raw;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(
        `設定ファイルが見つかりません: ${abs}\n` +
        `まず「skill-scheduler init」を実行してください。`
      );
    }
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`設定ファイルのJSONが不正です (${abs}): ${e.message}`);
  }
  const settings = deepMerge(DEFAULT_SETTINGS, parsed.settings ?? {});
  const tasks = (parsed.tasks ?? []).map(normalizeTask);
  const errors = validateConfig({ settings, tasks });
  if (errors.length > 0) {
    throw new Error(`設定にエラーがあります:\n  - ${errors.join("\n  - ")}`);
  }
  const st = await fs.stat(abs);
  return { settings, tasks, path: abs, dir: path.dirname(abs), mtimeMs: st.mtimeMs };
}

/** 設定を整形して保存 */
export async function saveConfig(configPath, { settings, tasks }) {
  const abs = path.resolve(configPath);
  const body = `${JSON.stringify({ settings, tasks }, null, 2)}\n`;
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, abs);
}

/** init 用の初期設定（サンプルタスクは無効状態で入れておく） */
export function initialConfig() {
  return {
    settings: DEFAULT_SETTINGS,
    tasks: [
      normalizeTask({
        id: "example-daily-report",
        name: "毎朝9時に日次レポートのスキルを実行（サンプル）",
        enabled: false,
        trigger: { type: "daily", at: "09:00" },
        action: { skill: "daily-report", args: "" },
      }),
      normalizeTask({
        id: "example-inbox-watch",
        name: "inboxフォルダにファイルが入ったら要約（サンプル）",
        enabled: false,
        trigger: { type: "folder_entered", path: "./inbox", pattern: "*.*" },
        action: {
          prompt: "ファイル {path} の内容を読んで、要点を日本語で3行にまとめてください。",
          allowedTools: ["Read", "Glob", "Grep"],
        },
      }),
    ],
  };
}

/** watch系トリガーの検出状態など、実行時状態の読み書き */
export async function loadState(stateFilePath) {
  try {
    const raw = await fs.readFile(stateFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { tasks: {} };
  } catch {
    return { tasks: {} };
  }
}

export async function saveState(stateFilePath, state) {
  const tmp = `${stateFilePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, stateFilePath);
}
