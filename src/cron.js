/**
 * 5フィールド cron 式（分 時 日 月 曜日）のパーサーと次回実行時刻計算。
 * 対応: "*" "," "-" "/" 、月・曜日の英語名、@daily などのエイリアス。
 * 日(dom)と曜日(dow)が両方指定された場合は標準cronと同じく OR 判定。
 */

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const ALIASES = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

function resolveToken(token, names) {
  const t = token.toLowerCase();
  if (names && t in names) return names[t];
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

function parseField(field, min, max, names, mapValue) {
  const values = new Set();
  for (const part of field.split(",")) {
    if (!part) throw new Error(`cronフィールドが不正です: "${field}"`);
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`cronのステップ値が不正です: "${part}"`);
      }
    }
    let lo;
    let hi;
    if (range === "*" || range === "") {
      lo = min;
      hi = max;
    } else {
      const dash = range.indexOf("-");
      if (dash > 0) {
        lo = resolveToken(range.slice(0, dash), names);
        hi = resolveToken(range.slice(dash + 1), names);
      } else {
        lo = resolveToken(range, names);
        // "5/15" のような開始値+ステップ指定は 5..max
        hi = slash >= 0 ? max : lo;
      }
    }
    if (lo === null || hi === null || lo === undefined || hi === undefined) {
      throw new Error(`cronの値を解釈できません: "${part}"`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cronの値が範囲外です (${min}-${max}): "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(mapValue ? mapValue(v) : v);
    }
  }
  return values;
}

/** cron式をパースして仕様オブジェクトを返す。不正なら例外 */
export function parseCron(expression) {
  let expr = String(expression ?? "").trim().toLowerCase();
  if (ALIASES[expr]) expr = ALIASES[expr];
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron式は「分 時 日 月 曜日」の5フィールドで指定してください: "${expression}"`
    );
  }
  const [minute, hour, dom, month, dow] = parts;
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(month, 1, 12, MONTH_NAMES),
    // 曜日は 0-7 を受け、7 は 0 (日曜) に正規化
    dow: parseField(dow, 0, 7, DOW_NAMES, (v) => v % 7),
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

function dayMatches(spec, date) {
  const domOk = spec.dom.has(date.getDate());
  const dowOk = spec.dow.has(date.getDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

/** 指定日時が cron 仕様にマッチするか（秒以下は無視） */
export function cronMatches(spec, date) {
  return (
    spec.minute.has(date.getMinutes()) &&
    spec.hour.has(date.getHours()) &&
    spec.month.has(date.getMonth() + 1) &&
    dayMatches(spec, date)
  );
}

/**
 * after より後の次回実行時刻を返す。約4年先まで見つからなければ null。
 * spec には parseCron の結果か cron 式文字列を渡せる。
 */
export function cronNext(spec, after = new Date()) {
  const s = typeof spec === "string" ? parseCron(spec) : spec;
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  // 月→日→時→分の順に不一致部分をスキップしながら探索
  let guard = 600_000;
  while (guard-- > 0) {
    if (!s.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(s, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!s.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}
