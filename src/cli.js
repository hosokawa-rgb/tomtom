/**
 * skill-scheduler コマンドライン。
 * 使い方は printHelp() を参照（`skill-scheduler help`）。
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_CONFIG_FILENAME,
  initialConfig,
  loadConfig,
  saveConfig,
  normalizeTask,
  validateConfig,
  validateTask,
  loadState,
} from "./config.js";
import { describeTrigger, triggerKind, computeNextRun } from "./triggers.js";
import { Daemon } from "./daemon.js";
import { createServer } from "./server.js";
import { runTask } from "./runner.js";
import { writeReport, appendHistory, readHistory, statusLabel, notify } from "./reporter.js";
import { listSkills } from "./skills.js";
import { createLogger, formatLocal, toArray, truncate } from "./util.js";

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        args.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          args.flags[key] = next;
          i++;
        } else {
          args.flags[key] = true;
        }
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Claude Skill Scheduler — Claude Code のスキルを条件で自動実行するスケジューラー

使い方: skill-scheduler <コマンド> [オプション]

セットアップ:
  init                     設定ファイルとフォルダを作成する
  start                    スケジューラーを起動する（Webダッシュボード付き）
  validate                 設定ファイルを検証する

タスク管理:
  list                     タスク一覧と次回実行時刻を表示
  add [オプション]         タスクを追加（下記参照）
  remove <id>              タスクを削除
  enable <id> / disable <id>  タスクの有効/無効を切り替え
  run <id>                 タスクを今すぐ1回実行（デーモン不要）
  history [--limit N]      実行履歴を表示
  skills                   利用可能なスキル/コマンド一覧を表示
  service                  常駐化用の systemd / launchd 設定を出力

add の主なオプション:
  --name <名前> --id <id>
  --trigger <type>         daily / weekly / monthly / interval / once / cron / startup /
                           folder_entered / file_created / file_modified / file_deleted /
                           folder_created / folder_changed / watch / condition / webhook / manual
  --at <HH:MM>             (daily/weekly/monthly) 実行時刻、(once) "YYYY-MM-DD HH:MM"
  --days <mon,fri|月,金>   (weekly) 曜日
  --day <1-31|last>        (monthly) 日にち
  --every <30m|2h>         (interval/condition) 間隔
  --expr "<cron式>"        (cron) 例: "0 9 * * 1-5"
  --path <フォルダ>        (ファイル監視系) 監視対象
  --pattern "<glob>"       (ファイル監視系) 例: "*.csv"
  --command "<cmd>"        (condition) 成立判定コマンド
  --skill <名前>           実行するスキル
  --args "<引数>"          スキルへの引数（{path} 等のプレースホルダ可）
  --prompt "<文章>"        スキルの代わりに直接プロンプト実行
  --allowed-tools "Read,Bash(git *)"
  --permission-mode <default|acceptEdits|plan|bypassPermissions>
  --cwd <dir> --timeout <分> --disabled --json '<タスクJSON>'

共通オプション:
  --config <path>          設定ファイル（既定: ./${DEFAULT_CONFIG_FILENAME}）
  --verbose                詳細ログ

例:
  skill-scheduler add --name "毎朝レポート" --trigger daily --at 09:00 --skill daily-report
  skill-scheduler add --name "CSV取込" --trigger folder_entered --path ./inbox \\
      --pattern "*.csv" --prompt "ファイル {path} を分析して要約して"
  skill-scheduler add --name "平日夕方" --trigger cron --expr "0 18 * * 1-5" --skill wrap-up
`);
}

function configPathOf(flags) {
  return path.resolve(flags.config ?? DEFAULT_CONFIG_FILENAME);
}

async function cmdInit(flags) {
  const configPath = configPathOf(flags);
  try {
    await fs.access(configPath);
    if (!flags.force) {
      console.error(`設定ファイルは既に存在します: ${configPath}（上書きは --force）`);
      process.exitCode = 1;
      return;
    }
  } catch { /* 存在しないので作成 */ }
  const config = initialConfig();
  await saveConfig(configPath, config);
  const dir = path.dirname(configPath);
  await fs.mkdir(path.join(dir, "reports"), { recursive: true });
  await fs.mkdir(path.join(dir, "logs"), { recursive: true });
  console.log(`✅ 設定ファイルを作成しました: ${configPath}`);
  console.log(`
次のステップ:
  1. claude にログイン済みか確認   : claude -p "hello" が動けばOK
  2. タスクを追加                  : skill-scheduler add --help 参照（またはWeb画面から）
  3. スケジューラーを起動          : skill-scheduler start
  4. ブラウザで管理                : http://127.0.0.1:8787/
※ サンプルタスクを2件（無効状態）入れてあります。参考にしてください。`);
}

async function cmdStart(flags) {
  const configPath = configPathOf(flags);
  const daemon = new Daemon(configPath, { verbose: !!flags.verbose });
  await daemon.start();

  let webServer = null;
  if (daemon.settings.web?.enabled && !flags["no-web"]) {
    webServer = createServer(daemon);
    try {
      await webServer.listen();
    } catch (e) {
      daemon.logger.error(`Webサーバーを起動できませんでした: ${e.message}（--no-web で無効化できます）`);
    }
  }

  const shutdown = async (signal) => {
    daemon.logger.info(`${signal} を受信、終了します…`);
    await daemon.stop();
    await webServer?.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("Ctrl+C で停止します。");
  // タイマーで動き続ける
}

async function cmdList(flags) {
  const config = await loadConfig(configPathOf(flags));
  const state = await loadState(path.resolve(config.dir, config.settings.stateFile));
  if (config.tasks.length === 0) {
    console.log("タスクがありません。「skill-scheduler add」で追加してください。");
    return;
  }
  console.log("");
  for (const task of config.tasks) {
    const s = state.tasks?.[task.id] ?? {};
    const lastRun = s.lastRunAt ? new Date(s.lastRunAt) : null;
    const next =
      task.enabled && triggerKind(task.trigger) === "time"
        ? computeNextRun(task.trigger, new Date(), lastRun)
        : null;
    const mark = task.enabled ? "●" : "○";
    const actionDesc = task.action.skill
      ? `/${task.action.skill}${task.action.args ? ` ${task.action.args}` : ""}`
      : truncate(task.action.prompt ?? "", 50).replaceAll("\n", " ");
    console.log(`${mark} ${task.id}  ${task.name}`);
    console.log(`    トリガー : ${describeTrigger(task.trigger)}`);
    console.log(`    アクション: ${actionDesc}`);
    if (next) console.log(`    次回実行 : ${formatLocal(next)}`);
    if (s.lastRunAt) {
      console.log(`    前回実行 : ${formatLocal(new Date(s.lastRunAt))} → ${statusLabel(s.lastStatus)}`);
    }
    console.log("");
  }
}

function buildTaskFromFlags(flags) {
  if (flags.json) {
    return JSON.parse(flags.json);
  }
  const type = flags.trigger;
  if (!type) throw new Error("--trigger <type> を指定してください（skill-scheduler help 参照）");

  const trigger = { type };
  if (flags.at) trigger.at = String(flags.at);
  if (flags.days) trigger.days = String(flags.days).split(",").map((s) => s.trim());
  if (flags.day) trigger.day = flags.day === "last" ? "last" : Number(flags.day);
  if (flags.every) trigger.every = String(flags.every);
  if (flags.expr) trigger.expression = String(flags.expr);
  if (flags.path) trigger.path = String(flags.path);
  if (flags.pattern) trigger.pattern = String(flags.pattern);
  if (flags.recursive === "false") trigger.recursive = false;
  if (flags.batch) trigger.batch = true;
  if (flags.command) trigger.command = String(flags.command);
  if (flags.mode) trigger.mode = String(flags.mode);
  if (flags.token) trigger.token = String(flags.token);
  if (flags.events) trigger.events = String(flags.events).split(",").map((s) => s.trim());

  const action = {};
  if (flags.skill) action.skill = String(flags.skill);
  if (flags.args) action.args = String(flags.args);
  if (flags.prompt) action.prompt = String(flags.prompt);
  if (flags.cwd) action.cwd = String(flags.cwd);
  if (flags["allowed-tools"]) {
    action.allowedTools = String(flags["allowed-tools"]).split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (flags["permission-mode"]) action.permissionMode = String(flags["permission-mode"]);
  if (flags.model) action.model = String(flags.model);
  if (flags.timeout) action.timeoutMinutes = Number(flags.timeout);

  const task = {
    id: flags.id ? String(flags.id) : undefined,
    name: flags.name ? String(flags.name) : undefined,
    enabled: !flags.disabled,
    trigger,
    action,
  };
  return task;
}

async function cmdAdd(flags) {
  const configPath = configPathOf(flags);
  const config = await loadConfig(configPath);
  const task = normalizeTask(buildTaskFromFlags(flags));
  const errors = validateTask(task);
  if (errors.length > 0) {
    console.error(`タスク定義にエラーがあります:\n  - ${errors.join("\n  - ")}`);
    process.exitCode = 1;
    return;
  }
  if (config.tasks.some((t) => t.id === task.id)) {
    console.error(`タスクIDが既に存在します: ${task.id}（--id で別のIDを指定してください）`);
    process.exitCode = 1;
    return;
  }
  config.tasks.push(task);
  await saveConfig(configPath, { settings: config.settings, tasks: config.tasks });
  console.log(`✅ タスクを追加しました: ${task.id}`);
  console.log(`   ${describeTrigger(task.trigger)}`);
  const next = computeNextRun(task.trigger, new Date(), null);
  if (next) console.log(`   次回実行: ${formatLocal(next)}`);
  console.log(`※ デーモン起動中なら自動で反映されます（skill-scheduler start）`);
}

async function mutateTask(flags, taskId, fn, doneMessage) {
  const configPath = configPathOf(flags);
  const config = await loadConfig(configPath);
  const task = config.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`タスクが見つかりません: ${taskId}`);
    process.exitCode = 1;
    return;
  }
  const tasks = fn(config.tasks, task);
  await saveConfig(configPath, { settings: config.settings, tasks });
  console.log(doneMessage);
}

async function cmdRun(flags, taskId) {
  const configPath = configPathOf(flags);
  const config = await loadConfig(configPath);
  const task = config.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`タスクが見つかりません: ${taskId}`);
    process.exitCode = 1;
    return;
  }
  const logger = createLogger({ verbose: true });
  const dirs = {
    reportsDir: path.resolve(config.dir, config.settings.reportsDir),
  };
  console.log(`タスク [${task.id}] を実行します…（claude の応答を待っています）`);
  const record = await runTask({
    task,
    settings: config.settings,
    configDir: config.dir,
    context: { event: "manual" },
    logger,
  });
  await writeReport(record, dirs);
  await appendHistory(record, dirs);
  if (task.options.notify !== false) {
    await notify(record, config.settings, logger);
  }
  console.log("");
  console.log(`結果    : ${statusLabel(record.status)}`);
  console.log(`所要時間: ${Math.round(record.durationMs / 1000)}秒`);
  console.log(`レポート: ${record.reportPath}`);
  if (record.error) console.log(`エラー  : ${record.error}`);
  console.log(`--- 結果本文（先頭のみ） ---`);
  console.log(truncate(record.resultText, 1500));
  if (record.status !== "success") process.exitCode = 1;
}

async function cmdHistory(flags) {
  const config = await loadConfig(configPathOf(flags));
  const dirs = { reportsDir: path.resolve(config.dir, config.settings.reportsDir) };
  const limit = Number(flags.limit ?? 20);
  const history = await readHistory(dirs, limit);
  if (history.length === 0) {
    console.log("実行履歴はまだありません。");
    return;
  }
  for (const r of history) {
    console.log(
      `${formatLocal(new Date(r.startedAt))}  ${statusLabel(r.status).padEnd(6)}  ` +
      `[${r.taskId}] ${r.taskName}（${r.event}, ${Math.round(r.durationMs / 1000)}秒）`
    );
    console.log(`    レポート: ${r.reportPath ?? "-"}`);
  }
}

async function cmdValidate(flags) {
  const configPath = configPathOf(flags);
  try {
    const config = await loadConfig(configPath);
    console.log(`✅ 設定は正常です（タスク ${config.tasks.length} 件）: ${configPath}`);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
  }
}

async function cmdSkills(flags) {
  const configPath = configPathOf(flags);
  let dir = path.dirname(configPath);
  try {
    await fs.access(configPath);
  } catch {
    dir = process.cwd();
  }
  const skills = await listSkills(dir);
  if (skills.length === 0) {
    console.log(`スキルが見つかりませんでした。
.claude/skills/<名前>/SKILL.md（プロジェクト）または ~/.claude/skills/（ユーザー共通）に配置してください。`);
    return;
  }
  console.log("");
  for (const s of skills) {
    console.log(`/${s.name}  [${s.source}${s.kind === "command" ? "コマンド" : "スキル"}]`);
    if (s.description) console.log(`    ${s.description}`);
  }
  console.log("");
}

async function cmdService(flags) {
  const configPath = configPathOf(flags);
  const nodePath = process.execPath;
  const binPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "skill-scheduler.js");
  console.log(`常駐化の設定例です。パスは環境に合わせて調整してください。

### Linux (systemd) — ~/.config/systemd/user/skill-scheduler.service
[Unit]
Description=Claude Skill Scheduler
After=network.target

[Service]
ExecStart=${nodePath} ${binPath} start --config ${configPath}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target

有効化:
  systemctl --user daemon-reload
  systemctl --user enable --now skill-scheduler
  journalctl --user -u skill-scheduler -f   # ログ確認

### macOS (launchd) — ~/Library/LaunchAgents/com.user.skill-scheduler.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.user.skill-scheduler</string>
  <key>ProgramArguments</key><array>
    <string>${nodePath}</string>
    <string>${binPath}</string>
    <string>start</string>
    <string>--config</string>
    <string>${configPath}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>

有効化:
  launchctl load ~/Library/LaunchAgents/com.user.skill-scheduler.plist

### とりあえず動かす（ターミナルを閉じても継続）
  nohup skill-scheduler start --config ${configPath} > /dev/null 2>&1 &
`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [command, ...rest] = args._;
  const flags = args.flags;

  try {
    switch (command) {
      case "init": return await cmdInit(flags);
      case "start": return await cmdStart(flags);
      case "list": case "ls": return await cmdList(flags);
      case "add": return await cmdAdd(flags);
      case "remove": case "rm": {
        const id = rest[0];
        if (!id) throw new Error("使い方: skill-scheduler remove <タスクID>");
        return await mutateTask(flags, id,
          (tasks) => tasks.filter((t) => t.id !== id),
          `✅ タスクを削除しました: ${id}`);
      }
      case "enable": {
        const id = rest[0];
        if (!id) throw new Error("使い方: skill-scheduler enable <タスクID>");
        return await mutateTask(flags, id,
          (tasks, task) => { task.enabled = true; return tasks; },
          `✅ タスクを有効にしました: ${id}`);
      }
      case "disable": {
        const id = rest[0];
        if (!id) throw new Error("使い方: skill-scheduler disable <タスクID>");
        return await mutateTask(flags, id,
          (tasks, task) => { task.enabled = false; return tasks; },
          `✅ タスクを無効にしました: ${id}`);
      }
      case "run": {
        const id = rest[0];
        if (!id) throw new Error("使い方: skill-scheduler run <タスクID>");
        return await cmdRun(flags, id);
      }
      case "history": return await cmdHistory(flags);
      case "validate": return await cmdValidate(flags);
      case "skills": return await cmdSkills(flags);
      case "service": return await cmdService(flags);
      case "help": case undefined: return printHelp();
      default:
        console.error(`不明なコマンド: ${command}（skill-scheduler help で使い方を表示）`);
        process.exitCode = 1;
    }
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
  }
}
