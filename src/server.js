/**
 * Webダッシュボード + REST API + Webhook 受信サーバー。
 * Node 標準の http モジュールのみ使用（依存なし）。
 *
 * settings.web.token を設定すると API はトークン必須になる
 * （Authorization: Bearer <token> または ?token=<token>）。
 * Webhook（POST /hooks/:id）はタスク側 trigger.token で個別に保護する。
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHistory } from "./reporter.js";
import { listSkills } from "./skills.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 1 * 1024 * 1024; // 1MB

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("リクエストボディが大きすぎます (1MB上限)"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createServer(daemon) {
  const { settings } = daemon;

  function authorized(req, url) {
    const token = daemon.settings.web?.token;
    if (!token) return true;
    const header = req.headers.authorization ?? "";
    if (header === `Bearer ${token}`) return true;
    if (url.searchParams.get("token") === token) return true;
    return false;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      // ---- ダッシュボード（HTML自体は認証不要。APIがトークンで守られる） ----
      if (req.method === "GET" && url.pathname === "/") {
        const html = await fs.readFile(path.join(__dirname, "dashboard.html"), "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // ---- Webhook 受信（タスク個別の token で保護） ----
      if (req.method === "POST" && parts[0] === "hooks" && parts.length === 2) {
        const taskId = decodeURIComponent(parts[1]);
        const task = daemon.tasks.find((t) => t.id === taskId);
        const hookToken = task?.trigger?.token;
        if (hookToken) {
          const provided =
            req.headers["x-hook-token"] ?? url.searchParams.get("token") ?? "";
          if (provided !== hookToken) {
            json(res, 403, { ok: false, message: "Webhookトークンが一致しません" });
            return;
          }
        }
        const body = await readBody(req);
        const result = daemon.fireWebhook(taskId, body.slice(0, 100_000));
        json(res, result.status, result);
        return;
      }

      // ---- API ----
      if (parts[0] !== "api") {
        json(res, 404, { ok: false, message: "not found" });
        return;
      }
      if (!authorized(req, url)) {
        json(res, 401, { ok: false, message: "認証トークンが必要です" });
        return;
      }

      const route = `${req.method} /${parts.slice(0, 3).join("/")}`;

      if (req.method === "GET" && url.pathname === "/api/status") {
        json(res, 200, { ok: true, status: daemon.getStatus() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/tasks") {
        json(res, 200, { ok: true, tasks: daemon.tasksWithMeta() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tasks") {
        const body = JSON.parse((await readBody(req)) || "{}");
        await daemon.updateConfig((draft) => {
          if (body.id && draft.tasks.some((t) => t.id === body.id)) {
            throw Object.assign(new Error(`タスクIDが既に存在します: ${body.id}`), { statusCode: 409 });
          }
          draft.tasks.push(body);
        });
        json(res, 201, { ok: true, tasks: daemon.tasksWithMeta() });
        return;
      }

      if (parts[1] === "tasks" && parts.length >= 3) {
        const taskId = decodeURIComponent(parts[2]);
        const exists = daemon.tasks.some((t) => t.id === taskId);

        if (req.method === "POST" && parts[3] === "run") {
          const result = daemon.manualRun(taskId);
          json(res, result.status, result);
          return;
        }
        if (!exists) {
          json(res, 404, { ok: false, message: `タスクが見つかりません: ${taskId}` });
          return;
        }
        if (req.method === "PUT") {
          const body = JSON.parse((await readBody(req)) || "{}");
          await daemon.updateConfig((draft) => {
            const i = draft.tasks.findIndex((t) => t.id === taskId);
            draft.tasks[i] = { ...body, id: taskId };
          });
          json(res, 200, { ok: true, tasks: daemon.tasksWithMeta() });
          return;
        }
        if (req.method === "PATCH") {
          const body = JSON.parse((await readBody(req)) || "{}");
          await daemon.updateConfig((draft) => {
            const t = draft.tasks.find((x) => x.id === taskId);
            if (typeof body.enabled === "boolean") t.enabled = body.enabled;
          });
          json(res, 200, { ok: true, tasks: daemon.tasksWithMeta() });
          return;
        }
        if (req.method === "DELETE") {
          await daemon.updateConfig((draft) => {
            draft.tasks = draft.tasks.filter((t) => t.id !== taskId);
          });
          json(res, 200, { ok: true, tasks: daemon.tasksWithMeta() });
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/api/history") {
        const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 50) || 50);
        const history = await readHistory(daemon.dirs, limit);
        json(res, 200, { ok: true, history });
        return;
      }

      if (req.method === "GET" && parts[1] === "runs" && parts[3] === "report") {
        const runId = decodeURIComponent(parts[2]);
        const history = await readHistory(daemon.dirs, 500);
        const record = history.find((r) => r.runId === runId);
        if (!record?.reportPath) {
          json(res, 404, { ok: false, message: "レポートが見つかりません" });
          return;
        }
        // 履歴由来のパスのみ許可し、reports ディレクトリ外へのアクセスを防ぐ
        const abs = path.resolve(record.reportPath);
        if (!abs.startsWith(daemon.dirs.reportsDir + path.sep)) {
          json(res, 403, { ok: false, message: "不正なレポートパスです" });
          return;
        }
        const content = await fs.readFile(abs, "utf8");
        json(res, 200, { ok: true, content, record });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/skills") {
        const skills = await listSkills(daemon.configDir);
        json(res, 200, { ok: true, skills });
        return;
      }

      json(res, 404, { ok: false, message: `不明なAPI: ${route}` });
    } catch (e) {
      const status = e.statusCode ?? 500;
      if (status >= 500) daemon.logger?.error(`APIエラー: ${e.stack ?? e.message}`);
      json(res, status, { ok: false, message: e.message });
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        const { host, port } = daemon.settings.web;
        server.once("error", reject);
        server.listen(port, host, () => {
          daemon.logger?.info(`Webダッシュボード: http://${host}:${port}/`);
          resolve({ host, port });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
