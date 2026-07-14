/**
 * スケジューラー本体（デーモン）。
 *   - 時間系トリガーの判定ループ（tick）
 *   - ファイル監視（WatchManager）
 *   - condition トリガーのコマンド判定
 *   - 実行キュー（同時実行数の制御）と結果の報告
 *   - 設定ファイルのホットリロード
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, saveConfig, loadState, saveState, normalizeTask, validateConfig } from "./config.js";
import { computeNextRun, triggerKind, describeTrigger } from "./triggers.js";
import { WatchManager } from "./watcher.js";
import { runTask } from "./runner.js";
import { writeReport, appendHistory, notify } from "./reporter.js";
import { createLogger, formatLocal, parseDuration, shortId } from "./util.js";

const MAX_QUEUE = 200;

export class Daemon {
  constructor(configPath, { verbose = false } = {}) {
    this.configPath = path.resolve(configPath);
    this.verbose = verbose;
    this.settings = null;
    this.tasks = [];
    this.configDir = path.dirname(this.configPath);
    this.configMtimeMs = 0;

    this.logger = null;
    this.state = { tasks: {} };
    this.queue = []; // {jobId, task, context, queuedAt}
    this.running = new Map(); // jobId -> {taskId, taskName, startedAt}
    this.nextRuns = new Map(); // taskId -> {key, next: Date|null}
    this.condState = new Map(); // taskId -> {key, nextCheckAt, lastOk, checking}
    this.watchManager = null;
    this.tickTimer = null;
    this.startedAt = null;
    this.stopped = false;
  }

  get dirs() {
    return {
      reportsDir: path.resolve(this.configDir, this.settings.reportsDir),
      logsDir: path.resolve(this.configDir, this.settings.logsDir),
      stateFile: path.resolve(this.configDir, this.settings.stateFile),
    };
  }

  async start() {
    const config = await loadConfig(this.configPath);
    this.applyConfig(config);
    this.startedAt = new Date();

    this.logger = createLogger({
      logFile: path.join(this.dirs.logsDir, "scheduler.log"),
      verbose: this.verbose,
    });
    this.logger.info("=".repeat(60));
    this.logger.info(`スケジューラー起動: ${this.configPath}`);
    this.logger.info(`タスク数: ${this.tasks.length}（有効: ${this.tasks.filter((t) => t.enabled).length}）`);

    this.state = await loadState(this.dirs.stateFile);
    if (!this.state.tasks) this.state.tasks = {};

    this.watchManager = new WatchManager({
      intervalSeconds: this.settings.watchIntervalSeconds,
      configDir: this.configDir,
      logger: this.logger,
      onEvent: (task, info) => this.enqueue(task, info),
    });
    this.refreshWatchTasks();
    this.watchManager.start();

    // 起動時トリガーと catchUp（停止中に過ぎたスケジュールの追い付き実行）
    for (const task of this.tasks) {
      if (!task.enabled) continue;
      if (task.trigger.type === "startup") {
        this.enqueue(task, { event: "startup" });
      } else if (task.options.catchUp && triggerKind(task.trigger) === "time") {
        const lastRun = this.lastRunAt(task.id);
        if (lastRun) {
          const missed = computeNextRun(task.trigger, lastRun, lastRun);
          if (missed && missed.getTime() <= Date.now()) {
            this.logger.info(`catchUp: [${task.id}] 停止中のスケジュール（${formatLocal(missed)}）を追い付き実行します`);
            this.enqueue(task, { event: "catchup" });
          }
        }
      }
    }

    const tickMs = Math.max(5, this.settings.tickSeconds) * 1000;
    this.tickTimer = setInterval(() => {
      this.tick().catch((e) => this.logger.error(`tickエラー: ${e.stack ?? e.message}`));
    }, tickMs);

    this.logTimeTasks();
    return this;
  }

  logTimeTasks() {
    for (const task of this.tasks) {
      if (!task.enabled) continue;
      const kind = triggerKind(task.trigger);
      if (kind === "time" && task.trigger.type !== "startup") {
        const next = this.nextRunOf(task);
        this.logger.info(`予定 [${task.id}] ${describeTrigger(task.trigger)} → 次回: ${formatLocal(next)}`);
      }
    }
  }

  applyConfig({ settings, tasks, mtimeMs }) {
    this.settings = settings;
    this.tasks = tasks;
    if (mtimeMs) this.configMtimeMs = mtimeMs;
  }

  refreshWatchTasks() {
    const watchTasks = this.tasks.filter(
      (t) => t.enabled && triggerKind(t.trigger) === "watch"
    );
    this.watchManager?.setTasks(watchTasks);
  }

  lastRunAt(taskId) {
    const iso = this.state.tasks?.[taskId]?.lastRunAt;
    return iso ? new Date(iso) : null;
  }

  /** 表示用: タスクの次回実行時刻（時間系のみ） */
  nextRunOf(task) {
    if (!task.enabled || triggerKind(task.trigger) !== "time") return null;
    const cached = this.nextRuns.get(task.id);
    const key = JSON.stringify(task.trigger);
    if (cached && cached.key === key) return cached.next;
    const next = computeNextRun(task.trigger, new Date(), this.lastRunAt(task.id));
    this.nextRuns.set(task.id, { key, next });
    return next;
  }

  async tick() {
    if (this.stopped) return;
    await this.reloadConfigIfChanged();

    const now = new Date();
    for (const task of this.tasks) {
      if (!task.enabled) continue;
      const kind = triggerKind(task.trigger);
      if (kind === "time" && task.trigger.type !== "startup") {
        const next = this.nextRunOf(task);
        if (next && now.getTime() >= next.getTime()) {
          this.enqueue(task, { event: "schedule" });
          const after = new Date();
          this.nextRuns.set(task.id, {
            key: JSON.stringify(task.trigger),
            next: computeNextRun(task.trigger, after, after),
          });
        }
      } else if (kind === "condition") {
        this.checkCondition(task, now);
      }
    }
    this.processQueue();
  }

  async reloadConfigIfChanged() {
    let st;
    try {
      st = await fs.stat(this.configPath);
    } catch {
      return; // 一時的に読めない場合は現状維持
    }
    if (st.mtimeMs === this.configMtimeMs) return;
    try {
      const config = await loadConfig(this.configPath);
      this.applyConfig(config);
      this.refreshWatchTasks();
      // トリガーが変わったタスクの次回時刻は nextRunOf が key 比較で再計算する
      this.logger.info(`設定ファイルの変更を検知して再読み込みしました（タスク数: ${this.tasks.length}）`);
    } catch (e) {
      this.configMtimeMs = st.mtimeMs; // 壊れた設定で毎tickエラーを繰り返さない
      this.logger.error(`設定の再読み込みに失敗しました（旧設定で継続します）: ${e.message}`);
    }
  }

  checkCondition(task, now) {
    const key = JSON.stringify(task.trigger);
    let cs = this.condState.get(task.id);
    if (!cs || cs.key !== key) {
      cs = { key, nextCheckAt: 0, lastOk: null, checking: false };
      this.condState.set(task.id, cs);
    }
    if (cs.checking || now.getTime() < cs.nextCheckAt) return;

    const everyMs = parseDuration(task.trigger.every ?? "5m") ?? 300_000;
    cs.nextCheckAt = now.getTime() + everyMs;
    cs.checking = true;

    exec(
      task.trigger.command,
      { cwd: this.configDir, timeout: 60_000, env: process.env },
      (err, stdout) => {
        cs.checking = false;
        const ok = !err;
        const mode = task.trigger.mode ?? "edge";
        const shouldFire = ok && (mode === "level" || cs.lastOk !== true);
        cs.lastOk = ok;
        if (shouldFire) {
          this.logger.info(`条件成立 [${task.id}]: ${task.trigger.command}`);
          this.enqueue(task, {
            event: "condition",
            output: String(stdout ?? "").trim().slice(0, 8000),
          });
        }
      }
    );
  }

  /** Webhook 受信（server.js から呼ばれる） */
  fireWebhook(taskId, payload) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task || task.trigger.type !== "webhook") {
      return { ok: false, status: 404, message: "webhook トリガーのタスクが見つかりません" };
    }
    if (!task.enabled) {
      return { ok: false, status: 409, message: "タスクが無効化されています" };
    }
    this.enqueue(task, { event: "webhook", payload });
    this.processQueue();
    return { ok: true, status: 202, message: "実行キューに追加しました" };
  }

  /** 手動実行（無効タスクでも明示的な操作なら実行する） */
  manualRun(taskId) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, status: 404, message: `タスクが見つかりません: ${taskId}` };
    this.enqueue(task, { event: "manual" }, { force: true });
    this.processQueue();
    return { ok: true, status: 202, message: "実行キューに追加しました" };
  }

  enqueue(task, context, { force = false } = {}) {
    if (this.stopped) return;
    if (!task.enabled && !force) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.logger.error(`実行キューが上限（${MAX_QUEUE}件）に達したため [${task.id}] をスキップしました`);
      return;
    }
    this.queue.push({ jobId: shortId("job-"), task, context, queuedAt: new Date() });
    this.logger.info(`キュー追加 [${task.id}] event=${context.event}（待機: ${this.queue.length}件）`);
    this.processQueue();
  }

  runningCountOf(taskId) {
    let n = 0;
    for (const r of this.running.values()) if (r.taskId === taskId) n++;
    return n;
  }

  processQueue() {
    while (
      this.running.size < Math.max(1, this.settings.maxConcurrentRuns) &&
      this.queue.length > 0
    ) {
      const job = this.queue.shift();
      const { task } = job;
      if (this.runningCountOf(task.id) > 0 && !task.options.concurrent) {
        this.logger.warn(
          `[${task.id}] は実行中のためスキップしました（options.concurrent: true で多重実行を許可できます）`
        );
        continue;
      }
      this.running.set(job.jobId, {
        taskId: task.id,
        taskName: task.name,
        startedAt: new Date(),
      });
      this.runJob(job).finally(() => {
        this.running.delete(job.jobId);
        this.processQueue();
      });
    }
  }

  async runJob(job) {
    const { task, context } = job;
    const startedAt = new Date();
    this.updateTaskState(task.id, { lastRunAt: startedAt.toISOString(), lastStatus: "running" });

    let record;
    try {
      record = await runTask({
        task,
        settings: this.settings,
        configDir: this.configDir,
        context,
        logger: this.logger,
      });
    } catch (e) {
      this.logger.error(`実行処理で予期しないエラー [${task.id}]: ${e.stack ?? e.message}`);
      this.updateTaskState(task.id, { lastStatus: "error" });
      await this.persistState();
      return;
    }

    try {
      await writeReport(record, this.dirs);
      await appendHistory(record, this.dirs);
    } catch (e) {
      this.logger.error(`レポート保存に失敗しました [${task.id}]: ${e.message}`);
    }

    if (task.options.notify !== false) {
      try {
        await notify(record, this.settings, this.logger);
      } catch (e) {
        this.logger.warn(`通知に失敗しました [${task.id}]: ${e.message}`);
      }
    }

    this.updateTaskState(task.id, {
      lastStatus: record.status,
      lastRunId: record.runId,
      lastReportPath: record.reportPath,
      runCount: (this.state.tasks[task.id]?.runCount ?? 0) + 1,
    });
    await this.persistState();
  }

  updateTaskState(taskId, patch) {
    this.state.tasks[taskId] = { ...(this.state.tasks[taskId] ?? {}), ...patch };
  }

  async persistState() {
    try {
      await saveState(this.dirs.stateFile, this.state);
    } catch (e) {
      this.logger.warn(`状態ファイルの保存に失敗しました: ${e.message}`);
    }
  }

  /**
   * 設定の更新（ダッシュボード等から）。mutator が {settings, tasks} を編集する。
   * 検証に通れば保存して即時反映する。
   */
  async updateConfig(mutator) {
    const draft = {
      settings: structuredClone(this.settings),
      tasks: structuredClone(this.tasks),
    };
    await mutator(draft);
    draft.tasks = draft.tasks.map(normalizeTask);
    const errors = validateConfig(draft);
    if (errors.length > 0) {
      const err = new Error(errors.join(" / "));
      err.statusCode = 400;
      throw err;
    }
    await saveConfig(this.configPath, draft);
    const st = await fs.stat(this.configPath);
    this.applyConfig({ ...draft, mtimeMs: st.mtimeMs });
    this.refreshWatchTasks();
    this.logger.info("設定を更新しました");
    return draft;
  }

  /** ダッシュボード用のタスク一覧（実行状態付き） */
  tasksWithMeta() {
    return this.tasks.map((task) => ({
      ...task,
      meta: {
        kind: triggerKind(task.trigger),
        description: describeTrigger(task.trigger),
        nextRun: this.nextRunOf(task)?.toISOString() ?? null,
        running: this.runningCountOf(task.id) > 0,
        ...(this.state.tasks[task.id] ?? {}),
      },
    }));
  }

  getStatus() {
    return {
      startedAt: this.startedAt?.toISOString() ?? null,
      uptimeSeconds: this.startedAt ? Math.round((Date.now() - this.startedAt.getTime()) / 1000) : 0,
      taskCount: this.tasks.length,
      enabledCount: this.tasks.filter((t) => t.enabled).length,
      queueLength: this.queue.length,
      running: [...this.running.values()].map((r) => ({
        ...r,
        startedAt: r.startedAt.toISOString(),
      })),
      configPath: this.configPath,
    };
  }

  async stop() {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.watchManager?.stop();
    if (this.running.size > 0) {
      this.logger?.warn(`実行中のタスクが ${this.running.size} 件あります（プロセス終了で中断されます）`);
    }
    await this.persistState();
    this.logger?.info("スケジューラーを停止しました");
  }
}
