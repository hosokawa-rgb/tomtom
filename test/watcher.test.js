import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diffSnapshots, scanDir } from "../src/watcher.js";

function snap(entries) {
  return new Map(Object.entries(entries));
}

test("diffSnapshots: 作成・更新・削除を検出する", () => {
  const before = snap({
    "a.txt": { isDir: false, size: 10, mtimeMs: 100 },
    "keep.txt": { isDir: false, size: 5, mtimeMs: 50 },
    "olddir": { isDir: true, size: 0, mtimeMs: 10 },
  });
  const after = snap({
    "a.txt": { isDir: false, size: 12, mtimeMs: 200 }, // 更新
    "keep.txt": { isDir: false, size: 5, mtimeMs: 50 }, // 変化なし
    "new.txt": { isDir: false, size: 1, mtimeMs: 300 }, // 作成
    "newdir": { isDir: true, size: 0, mtimeMs: 300 }, // フォルダ作成
    // olddir 削除
  });
  const events = diffSnapshots(before, after);
  const byKey = Object.fromEntries(events.map((e) => [`${e.event}:${e.relPath}`, e]));
  assert.ok(byKey["file_modified:a.txt"]);
  assert.ok(byKey["file_created:new.txt"]);
  assert.ok(byKey["folder_created:newdir"]);
  assert.ok(byKey["folder_deleted:olddir"]);
  assert.equal(events.length, 4);
});

test("diffSnapshots: 変化がなければ空", () => {
  const s = snap({ "a.txt": { isDir: false, size: 1, mtimeMs: 1 } });
  assert.deepEqual(diffSnapshots(s, s), []);
});

test("scanDir: 再帰的にファイルとフォルダを列挙し .git 等を無視する", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "watch-test-"));
  try {
    await fs.mkdir(path.join(root, "sub"));
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, "top.txt"), "hello");
    await fs.writeFile(path.join(root, "sub", "nested.csv"), "a,b");
    await fs.writeFile(path.join(root, ".git", "config"), "x");

    const result = await scanDir(root, { recursive: true });
    assert.ok(result.has("top.txt"));
    assert.ok(result.has("sub"));
    assert.ok(result.get("sub").isDir);
    assert.ok(result.has("sub/nested.csv"));
    assert.ok(!result.has(".git/config"));

    const flat = await scanDir(root, { recursive: false });
    assert.ok(flat.has("top.txt"));
    assert.ok(flat.has("sub"));
    assert.ok(!flat.has("sub/nested.csv"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
