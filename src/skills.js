/**
 * 利用可能な Claude Code スキル / スラッシュコマンドの検出。
 * 以下を走査する:
 *   - <プロジェクト>/.claude/skills/<name>/SKILL.md
 *   - ~/.claude/skills/<name>/SKILL.md
 *   - <プロジェクト>/.claude/commands/**.md
 *   - ~/.claude/commands/**.md
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** SKILL.md の frontmatter から name / description を素朴に抜き出す */
function parseFrontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(name|description):\s*(.+)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

async function scanSkillsDir(dir, source, results) {
  if (!(await exists(dir))) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(dir, entry.name, "SKILL.md");
    if (!(await exists(skillMd))) continue;
    let description = "";
    try {
      const fm = parseFrontmatter(await fs.readFile(skillMd, "utf8"));
      description = fm.description ?? "";
    } catch { /* 説明なしで登録 */ }
    results.push({ name: entry.name, description, source, kind: "skill" });
  }
}

async function scanCommandsDir(dir, source, results, prefix = "") {
  if (!(await exists(dir))) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // サブディレクトリは "dir:command" の名前空間になる
      await scanCommandsDir(
        path.join(dir, entry.name),
        source,
        results,
        prefix ? `${prefix}:${entry.name}` : entry.name
      );
    } else if (entry.name.endsWith(".md")) {
      const base = entry.name.slice(0, -3);
      const name = prefix ? `${prefix}:${base}` : base;
      let description = "";
      try {
        const fm = parseFrontmatter(await fs.readFile(path.join(dir, entry.name), "utf8"));
        description = fm.description ?? "";
      } catch { /* 説明なしで登録 */ }
      results.push({ name, description, source, kind: "command" });
    }
  }
}

/**
 * 検出したスキル/コマンドの一覧を返す。
 * @param {string} projectDir 設定ファイルのあるディレクトリ（プロジェクト基準）
 */
export async function listSkills(projectDir) {
  const home = os.homedir();
  const results = [];
  await scanSkillsDir(path.join(projectDir, ".claude", "skills"), "プロジェクト", results);
  await scanSkillsDir(path.join(home, ".claude", "skills"), "ユーザー", results);
  await scanCommandsDir(path.join(projectDir, ".claude", "commands"), "プロジェクト", results);
  await scanCommandsDir(path.join(home, ".claude", "commands"), "ユーザー", results);

  // 同名はプロジェクト側を優先して重複排除
  const seen = new Set();
  return results.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}
