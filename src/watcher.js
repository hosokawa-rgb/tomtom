/**
 * ポーリング式ファイルシステム監視。
 * OS依存の fs.watch ではなくスナップショット比較方式なので、
 * ネットワークドライブや Docker ボリュームでも安定して動く。
 *
 * - 起動時に存在するファイルではイベントを発火しない（スナップショットのみ取得）
 * - 作成/更新イベントは「サイズ・更新時刻が2回のポーリングで安定」してから発火
 *   （コピー中の大きいファイルを途中で処理しないため）
 */

import fs from "node:fs/promises";
import path from "node:path";
import { matchPatterns, toArray } from "./util.js";
import { watchEventsOf } from "./triggers.js";

const DEFAULT_IGNORE = [".git", "node_modules", ".DS_Store"];
const MAX_ENTRIES = 50_000;

/** ディレクトリを走査して Map<relPath, {isDir,size,mtimeMs}> を返す */
export async function scanDir(root, { recursive = true, ignore = [] } = {}) {
  const snapshot = new Map();
  const ignoreSet = new Set([...DEFAULT_IGNORE, ...toArray(ignore)]);

  async function walk(dir, rel) {
    if (snapshot.size >= MAX_ENTRIES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 消えた・権限なし等はスキップ
    }
    for (const entry of entries) {
      if (ignoreSet.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        snapshot.set(relPath, { isDir: true, size: 0, mtimeMs: st.mtimeMs });
        if (recursive) await walk(abs, relPath);
      } else if (st.isFile()) {
        snapshot.set(relPath, { isDir: false, size: st.size, mtimeMs: st.mtimeMs });
      }
      if (snapshot.size >= MAX_ENTRIES) return;
    }
  }

  await walk(root, "");
  return snapshot;
}

/**
 * 2つのスナップショットを比較してイベント配列を返す（純関数・テスト対象）。
 * @returns {Array<{event: string, relPath: string, isDir: boolean}>}
 */
export function diffSnapshots(oldSnap, newSnap) {
  const events = [];
  for (const [relPath, info] of newSnap) {
    const prev = oldSnap.get(relPath);
    if (!prev) {
      events.push({
        event: info.isDir ? "folder_created" : "file_created",
        relPath,
        isDir: info.isDir,
      });
    } else if (!info.isDir && !prev.isDir &&
      (info.size !== prev.size || info.mtimeMs !== prev.mtimeMs)) {
      events.push({ event: "file_modified", relPath, isDir: false });
    }
  }
  for (const [relPath, info] of oldSnap) {
    if (!newSnap.has(relPath)) {
      events.push({
        event: info.isDir ? "folder_deleted" : "file_deleted",
        relPath,
        isDir: info.isDir,
      });
    }
  }
  return events;
}

/**
 * watch系タスクをまとめて監視するマネージャー。
 * onEvent(task, eventInfo) を発火する。
 */
export class WatchManager {
  constructor({ intervalSeconds = 5, configDir = ".", logger, onEvent }) {
    this.intervalMs = Math.max(1, intervalSeconds) * 1000;
    this.configDir = configDir;
    this.logger = logger;
    this.onEvent = onEvent;
    this.entries = new Map(); // taskId -> entry
    this.timer = null;
    this.polling = false;
  }

  /** 監視対象タスク一覧を反映（追加/削除/設定変更に対応） */
  setTasks(tasks) {
    const seen = new Set();
    for (const task of tasks) {
      seen.add(task.id);
      const key = JSON.stringify(task.trigger);
      const existing = this.entries.get(task.id);
      if (existing && existing.key === key) {
        existing.task = task; // action等の変更だけ反映
        continue;
      }
      const root = path.resolve(this.configDir, task.trigger.path);
      this.entries.set(task.id, {
        key,
        task,
        root,
        recursive: task.trigger.recursive !== false,
        ignore: toArray(task.trigger.ignore),
        events: new Set(watchEventsOf(task.trigger)),
        patterns: toArray(task.trigger.pattern),
        snapshot: null, // 初回スキャンで設定（発火なし）
        pending: new Map(), // relPath -> {event, size, mtimeMs}
        missingWarned: false,
      });
      this.logger?.info(`監視開始: [${task.id}] ${root}`);
    }
    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) {
        this.entries.delete(id);
        this.logger?.info(`監視終了: [${id}]`);
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch((e) => this.logger?.error(`監視ポーリングエラー: ${e.message}`));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.polling) return; // 前回のスキャンが長引いている間は重ねない
    this.polling = true;
    try {
      for (const entry of this.entries.values()) {
        await this.pollEntry(entry);
      }
    } finally {
      this.polling = false;
    }
  }

  async pollEntry(entry) {
    let rootStat;
    try {
      rootStat = await fs.stat(entry.root);
    } catch {
      rootStat = null;
    }
    if (!rootStat || !rootStat.isDirectory()) {
      if (!entry.missingWarned) {
        this.logger?.warn(`監視フォルダが存在しません: ${entry.root}（作成されると監視を開始します）`);
        entry.missingWarned = true;
      }
      entry.snapshot = null;
      entry.pending.clear();
      return;
    }

    const newSnap = await scanDir(entry.root, {
      recursive: entry.recursive,
      ignore: entry.ignore,
    });

    if (entry.snapshot === null) {
      // 初回（またはフォルダ再出現時）: 既存分は発火せずベースラインにする
      entry.snapshot = newSnap;
      entry.missingWarned = false;
      return;
    }

    const rawEvents = diffSnapshots(entry.snapshot, newSnap);
    const ready = [];

    for (const ev of rawEvents) {
      if (ev.event === "file_created" || ev.event === "file_modified") {
        // ファイルはサイズ安定を待つ（コピー途中対策）
        const info = newSnap.get(ev.relPath);
        entry.pending.set(ev.relPath, {
          event: entry.pending.get(ev.relPath)?.event === "file_created" ? "file_created" : ev.event,
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
      } else if (ev.event === "file_deleted" && entry.pending.has(ev.relPath)) {
        // 発火前に消えた作成イベントは黙って破棄
        entry.pending.delete(ev.relPath);
      } else {
        ready.push(ev);
      }
    }

    // 保留中イベントの安定チェック
    for (const [relPath, p] of [...entry.pending]) {
      const cur = newSnap.get(relPath);
      if (!cur) {
        entry.pending.delete(relPath);
        continue;
      }
      if (cur.size === p.size && cur.mtimeMs === p.mtimeMs) {
        ready.push({ event: p.event, relPath, isDir: false });
        entry.pending.delete(relPath);
      } else {
        entry.pending.set(relPath, { event: p.event, size: cur.size, mtimeMs: cur.mtimeMs });
      }
    }

    entry.snapshot = newSnap;

    const matched = ready.filter(
      (ev) => entry.events.has(ev.event) && matchPatterns(entry.patterns, ev.relPath)
    );
    if (matched.length === 0) return;

    if (entry.task.trigger.batch) {
      // 1回のポーリングで検出した分をまとめて1回の実行にする
      const paths = matched.map((ev) => path.join(entry.root, ev.relPath));
      this.emit(entry.task, {
        event: matched.map((ev) => ev.event).join(","),
        path: paths.join("\n"),
        paths,
        file: matched.map((ev) => ev.relPath.split("/").pop()).join(", "),
        relpath: matched.map((ev) => ev.relPath).join(", "),
        dir: entry.root,
        root: entry.root,
        count: matched.length,
      });
    } else {
      for (const ev of matched) {
        const abs = path.join(entry.root, ev.relPath);
        this.emit(entry.task, {
          event: ev.event,
          path: abs,
          paths: [abs],
          file: ev.relPath.split("/").pop(),
          relpath: ev.relPath,
          dir: path.dirname(abs),
          root: entry.root,
          count: 1,
        });
      }
    }
  }

  emit(task, info) {
    try {
      this.onEvent(task, info);
    } catch (e) {
      this.logger?.error(`監視イベント処理エラー [${task.id}]: ${e.message}`);
    }
  }
}
