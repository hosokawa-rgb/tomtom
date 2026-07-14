import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 曜日名 → 0-6 (日曜=0)。英語名・略称・日本語一文字に対応 */
export const DOW_MAP = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  "日": 0, "月": 1, "火": 2, "水": 3, "木": 4, "金": 5, "土": 6,
};

export const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

export function pad2(n) {
  return String(n).padStart(2, "0");
}

/** ローカルタイムの "YYYY-MM-DD HH:MM:SS" 表記 */
export function formatLocal(d) {
  if (d === null || d === undefined) return "-";
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return "-";
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())} ` +
    `${pad2(x.getHours())}:${pad2(x.getMinutes())}:${pad2(x.getSeconds())}`;
}

/** ファイル名向けタイムスタンプ "YYYYMMDD-HHMMSS" */
export function timestampSlug(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

export function shortId(prefix = "") {
  return prefix + crypto.randomBytes(4).toString("hex");
}

const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * "30s" "10m" "2h" "1d" "1h30m" のような長さ表記をミリ秒に変換。
 * 数値のみ（例: "30" / 30）は秒として解釈。不正な場合は null。
 */
export function parseDuration(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value * 1000;
  }
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const re = /(\d+)\s*(ms|s|m|h|d)/g;
  let ms = 0;
  let consumed = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index !== consumed) return null;
    ms += Number(m[1]) * DURATION_UNITS[m[2]];
    consumed = m.index + m[0].length;
    while (consumed < s.length && s[consumed] === " ") consumed++;
    re.lastIndex = consumed;
  }
  if (consumed !== s.length || ms <= 0) return null;
  return ms;
}

/** "HH:MM" を {h, m} に。パースできなければ null */
export function parseTimeOfDay(text) {
  const m = String(text ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/** "2026-07-15 09:00" / ISO8601 を Date に。パースできなければ null */
export function parseDateTime(text) {
  if (!text) return null;
  const s = String(text).trim().replace(" ", "T");
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "{name}" 形式のプレースホルダを vars で置換。未定義キーは空文字 */
export function template(str, vars = {}) {
  return String(str ?? "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const v = vars[key];
    return v === null || v === undefined ? "" : String(v);
  });
}

/** glob風パターン（* ? **）を正規表現に変換 */
export function globToRegExp(pattern) {
  let re = "";
  const p = String(pattern);
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * パターン配列とパス（"/" 区切りの相対パス）のマッチ判定。
 * パターンに "/" を含む場合は相対パス全体、含まない場合はファイル名のみと照合。
 * パターン未指定（null / 空配列）は常に true。
 */
export function matchPatterns(patterns, relPath) {
  const list = toArray(patterns);
  if (list.length === 0) return true;
  const base = relPath.split("/").pop();
  return list.some((p) => {
    const target = String(p).includes("/") ? relPath : base;
    return globToRegExp(p).test(target);
  });
}

export function toArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function truncate(str, max = 2000) {
  const s = String(str ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n…（${s.length - max} 文字省略）`;
}

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** コンソール + ファイルに書く簡易ロガー */
export function createLogger({ logFile = null, verbose = false } = {}) {
  let writes = 0;

  function rotateIfNeeded() {
    if (!logFile) return;
    try {
      const st = fs.statSync(logFile);
      if (st.size > LOG_MAX_BYTES) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      // ファイルが無いだけなら何もしない
    }
  }

  function write(level, msg) {
    const line = `[${formatLocal(new Date())}] [${level}] ${msg}`;
    if (level === "ERROR") console.error(line);
    else if (level !== "DEBUG" || verbose) console.log(line);
    if (logFile) {
      try {
        if (writes % 200 === 0) rotateIfNeeded();
        writes++;
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.appendFileSync(logFile, `${line}\n`);
      } catch {
        // ログ書き込み失敗で本体を止めない
      }
    }
  }

  return {
    info: (msg) => write("INFO", msg),
    warn: (msg) => write("WARN", msg),
    error: (msg) => write("ERROR", msg),
    debug: (msg) => write("DEBUG", msg),
  };
}
