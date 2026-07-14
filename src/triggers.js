/**
 * トリガー定義の正規化・検証と、時間系トリガーの次回実行時刻計算。
 *
 * トリガー種別:
 *   時間系   : once / daily / weekly / monthly / interval / cron / startup
 *   ファイル系: watch（汎用）と、その糖衣構文
 *              file_created / file_modified / file_deleted /
 *              folder_created / folder_deleted / folder_entered / folder_changed
 *   その他   : condition（コマンド成否） / webhook / manual
 */

import { parseCron, cronNext } from "./cron.js";
import {
  DOW_MAP,
  parseDuration,
  parseTimeOfDay,
  parseDateTime,
  toArray,
} from "./util.js";

export const WATCH_EVENTS = [
  "file_created",
  "file_modified",
  "file_deleted",
  "folder_created",
  "folder_deleted",
];

/** 糖衣トリガー名 → 監視イベントの対応表 */
export const WATCH_SUGAR = {
  watch: null, // events フィールドで明示
  file_created: ["file_created"],
  file_modified: ["file_modified"],
  file_deleted: ["file_deleted"],
  folder_created: ["folder_created"],
  folder_deleted: ["folder_deleted"],
  // 「フォルダに（何かが）入った時」: ファイル/フォルダの出現どちらも拾う
  folder_entered: ["file_created", "folder_created"],
  // フォルダ内の何らかの変化すべて
  folder_changed: [...WATCH_EVENTS],
};

export const TIME_TYPES = ["once", "daily", "weekly", "monthly", "interval", "cron", "startup"];
export const OTHER_TYPES = ["condition", "webhook", "manual"];
export const ALL_TYPES = [...TIME_TYPES, ...Object.keys(WATCH_SUGAR), ...OTHER_TYPES];

/** トリガーの分類: "time" | "watch" | "condition" | "webhook" | "manual" */
export function triggerKind(trigger) {
  const type = trigger?.type;
  if (TIME_TYPES.includes(type)) return "time";
  if (type in WATCH_SUGAR) return "watch";
  if (OTHER_TYPES.includes(type)) return type;
  return null;
}

/** watch系トリガーが監視するイベント一覧 */
export function watchEventsOf(trigger) {
  const sugar = WATCH_SUGAR[trigger.type];
  if (sugar) return sugar;
  const events = toArray(trigger.events);
  return events.length > 0 ? events : [...WATCH_EVENTS];
}

function parseDows(days) {
  const list = toArray(days);
  const result = new Set();
  for (const d of list) {
    let v;
    if (typeof d === "number") v = d;
    else if (/^\d+$/.test(String(d).trim())) v = Number(String(d).trim());
    else v = DOW_MAP[String(d).trim().toLowerCase()];
    if (v === undefined || v === null || v < 0 || v > 7) return null;
    result.add(v % 7);
  }
  return result.size > 0 ? result : null;
}

function parseAts(at) {
  const list = toArray(at ?? "09:00");
  const times = [];
  for (const t of list) {
    const parsed = parseTimeOfDay(t);
    if (!parsed) return null;
    times.push(parsed);
  }
  return times;
}

function lastDayOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * トリガー定義を検証してエラーメッセージ配列を返す（空なら正常）。
 */
export function validateTrigger(trigger) {
  const errors = [];
  if (!trigger || typeof trigger !== "object") {
    return ["trigger オブジェクトが必要です"];
  }
  const type = trigger.type;
  if (!ALL_TYPES.includes(type)) {
    return [
      `trigger.type "${type}" は不明です。利用可能: ${ALL_TYPES.join(", ")}`,
    ];
  }

  switch (type) {
    case "once":
      if (!parseDateTime(trigger.at)) {
        errors.push(`once トリガーには at（例: "2026-07-20 09:00"）が必要です`);
      }
      break;
    case "daily":
      if (!parseAts(trigger.at)) {
        errors.push(`daily トリガーの at は "HH:MM"（または配列）で指定してください`);
      }
      break;
    case "weekly":
      if (!parseDows(trigger.days)) {
        errors.push(`weekly トリガーには days（例: ["mon","fri"] / ["月"] / [1,5]）が必要です`);
      }
      if (!parseAts(trigger.at)) {
        errors.push(`weekly トリガーの at は "HH:MM" で指定してください`);
      }
      break;
    case "monthly": {
      const days = toArray(trigger.day ?? 1);
      for (const d of days) {
        const ok = d === "last" || (Number.isInteger(Number(d)) && Number(d) >= 1 && Number(d) <= 31);
        if (!ok) errors.push(`monthly トリガーの day は 1〜31 または "last" で指定してください: "${d}"`);
      }
      if (!parseAts(trigger.at)) {
        errors.push(`monthly トリガーの at は "HH:MM" で指定してください`);
      }
      break;
    }
    case "interval":
      if (!parseDuration(trigger.every)) {
        errors.push(`interval トリガーには every（例: "30m", "2h", "90s"）が必要です`);
      }
      break;
    case "cron":
      try {
        parseCron(trigger.expression);
      } catch (e) {
        errors.push(String(e.message ?? e));
      }
      break;
    case "startup":
    case "manual":
      break;
    case "condition":
      if (!trigger.command || typeof trigger.command !== "string") {
        errors.push(`condition トリガーには command（シェルコマンド文字列）が必要です`);
      }
      if (trigger.every !== undefined && !parseDuration(trigger.every)) {
        errors.push(`condition トリガーの every が不正です（例: "5m"）`);
      }
      if (trigger.mode !== undefined && !["edge", "level"].includes(trigger.mode)) {
        errors.push(`condition トリガーの mode は "edge" か "level" です`);
      }
      break;
    case "webhook":
      break;
    default: {
      // watch 系
      if (!trigger.path || typeof trigger.path !== "string") {
        errors.push(`${type} トリガーには path（監視するフォルダ）が必要です`);
      }
      if (type === "watch") {
        const evs = toArray(trigger.events);
        for (const ev of evs) {
          if (!WATCH_EVENTS.includes(ev)) {
            errors.push(`watch トリガーの events に不明な値: "${ev}"（利用可能: ${WATCH_EVENTS.join(", ")}）`);
          }
        }
      }
      break;
    }
  }
  return errors;
}

/**
 * 時間系トリガーの次回実行時刻を計算する。
 * @param {object} trigger  正規化済みトリガー
 * @param {Date}   after    この時刻より後で最初の実行時刻を探す
 * @param {Date|null} lastRunAt  前回実行時刻（interval / once で使用）
 * @returns {Date|null} 次回実行時刻。イベント駆動型・実行済み once は null
 */
export function computeNextRun(trigger, after = new Date(), lastRunAt = null) {
  switch (trigger.type) {
    case "once": {
      const at = parseDateTime(trigger.at);
      if (!at) return null;
      if (lastRunAt && lastRunAt.getTime() >= at.getTime()) return null; // 実行済み
      return at.getTime() > after.getTime() ? at : null;
    }
    case "daily": {
      const ats = parseAts(trigger.at);
      if (!ats) return null;
      return nextFromCandidates(after, 2, () => true, ats);
    }
    case "weekly": {
      const dows = parseDows(trigger.days);
      const ats = parseAts(trigger.at);
      if (!dows || !ats) return null;
      return nextFromCandidates(after, 8, (d) => dows.has(d.getDay()), ats);
    }
    case "monthly": {
      const ats = parseAts(trigger.at);
      if (!ats) return null;
      const days = toArray(trigger.day ?? 1);
      const candidates = [];
      for (let offset = 0; offset < 48; offset++) {
        const base = new Date(after.getFullYear(), after.getMonth() + offset, 1);
        const last = lastDayOfMonth(base.getFullYear(), base.getMonth());
        for (const dSpec of days) {
          const dom = dSpec === "last" ? last : Number(dSpec);
          if (dom > last) continue; // 例: 31日が無い月はスキップ
          for (const t of ats) {
            const cand = new Date(base.getFullYear(), base.getMonth(), dom, t.h, t.m, 0, 0);
            if (cand.getTime() > after.getTime()) candidates.push(cand);
          }
        }
        if (candidates.length > 0) break;
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.getTime() - b.getTime());
      return candidates[0];
    }
    case "interval": {
      const ms = parseDuration(trigger.every);
      if (!ms) return null;
      if (lastRunAt) {
        const next = lastRunAt.getTime() + ms;
        // 前回実行から間隔を過ぎていたら即実行
        return new Date(Math.max(next, after.getTime()));
      }
      return new Date(after.getTime() + ms);
    }
    case "cron": {
      try {
        return cronNext(parseCron(trigger.expression), after);
      } catch {
        return null;
      }
    }
    default:
      return null; // startup / watch / condition / webhook / manual はイベント駆動
  }
}

function nextFromCandidates(after, daysAhead, dayFilter, ats) {
  const candidates = [];
  for (let offset = 0; offset <= daysAhead; offset++) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset);
    if (!dayFilter(day)) continue;
    for (const t of ats) {
      const cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), t.h, t.m, 0, 0);
      if (cand.getTime() > after.getTime()) candidates.push(cand);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0];
}

/** トリガーの人間向け説明（ダッシュボード・CLI表示用） */
export function describeTrigger(trigger) {
  const t = trigger ?? {};
  const ats = toArray(t.at).join(", ");
  switch (t.type) {
    case "once": return `1回のみ: ${t.at}`;
    case "daily": return `毎日 ${ats}`;
    case "weekly": return `毎週 ${toArray(t.days).join(",")} ${ats}`;
    case "monthly": return `毎月 ${toArray(t.day ?? 1).join(",")}日 ${ats}`;
    case "interval": return `${t.every} ごと`;
    case "cron": return `cron: ${t.expression}`;
    case "startup": return "スケジューラー起動時";
    case "condition": return `条件コマンド (${t.every ?? "5m"} ごとに判定)`;
    case "webhook": return "Webhook 受信時";
    case "manual": return "手動実行のみ";
    case "watch": return `監視: ${t.path} [${watchEventsOf(t).join(",")}]`;
    case "file_created": return `ファイル作成時: ${t.path}`;
    case "file_modified": return `ファイル更新時: ${t.path}`;
    case "file_deleted": return `ファイル削除時: ${t.path}`;
    case "folder_created": return `フォルダ作成時: ${t.path}`;
    case "folder_deleted": return `フォルダ削除時: ${t.path}`;
    case "folder_entered": return `フォルダ投入時: ${t.path}`;
    case "folder_changed": return `フォルダ変化時: ${t.path}`;
    default: return String(t.type ?? "?");
  }
}
