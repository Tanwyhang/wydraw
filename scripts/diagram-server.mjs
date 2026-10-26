import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import express from "express";
import { build } from "esbuild";
import { read, write, patch, renderData } from "./diagram-core.mjs";
import { root, sessionPath } from "./diagram.mjs";

export async function serve(file) {
  read(file);
  fs.mkdirSync(path.join(root, ".state"), { recursive: true });
  const lease = sessionPath(file) + ".lock";
  if (fs.existsSync(lease)) {
    const pid = Number(fs.readFileSync(lease, "utf8"));
    let alive = false;
    try {
      if (pid > 0) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {}
    if (alive)
      throw Error("A viewer is already running or starting for this document");
    fs.unlinkSync(lease);
  }
  const leaseFd = fs.openSync(lease, "wx", 0o600);
  fs.writeSync(leaseFd, String(process.pid));
  fs.closeSync(leaseFd);
  process.on("exit", () => {
    try {
      fs.unlinkSync(lease);
    } catch {}
  });
  const token = randomBytes(24).toString("hex");
  let mode = "view";
  const clients = new Set();
  let lastRevision = read(file).revision,
    cachedRevision,
    cached = new Map();
  const notify = () => {
    lastRevision = read(file).revision;
    for (const client of clients)
      client.write(
        `data: ${JSON.stringify({ revision: lastRevision, mode })}\n\n`,
      );
  };
  const assets = path.join(root, ".state", "viewer");
  await build({
    entryPoints: [path.join(root, "viewer", "app.jsx")],
    bundle: true,
    outdir: assets,
    format: "esm",
    minify: true,
    conditions: ["production", "browser", "default"],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: {
      ".woff2": "file",
      ".woff": "file",
      ".ttf": "file",
      ".svg": "file",
    },
    logLevel: "silent",
  });
  const app = express();
  let url;
  app.use((req, res, next) => {
    if (url && req.headers.host !== new URL(url).host)
      return res.sendStatus(403);
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'",
    );
    if (
      req.path.startsWith("/api/") &&
      req.headers.authorization !== `Bearer ${token}` &&
      !(req.path === "/api/events" && req.query.token === token)
    )
      return res.sendStatus(403);
    next();
  });
  app.use(express.json({ limit: "10mb" }));
  app.use("/assets", express.static(assets));
  app.use(
    "/fonts",
    express.static(
      path.join(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts"),
    ),
  );
  app.get("/", (_req, res) =>
    res
      .type("html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>System canvas</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script>window.DIAGRAM_TOKEN="${token}";window.EXCALIDRAW_ASSET_PATH="/";</script><script type="module" src="/assets/app.js"></script></body></html>`,
      ),
  );
  app.get("/api/scene", (_req, res) =>
    res.json({ ...read(file), mode, name: path.basename(file) }),
  );
  app.get("/api/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });
  app.post("/api/mode", (req, res) => {
    if (!["view", "cursor"].includes(req.body.mode))
      return res.status(400).json({ error: "Unknown mode" });
    mode = req.body.mode;
    res.json({ mode });
    notify();
  });
  app.post("/api/apply", (req, res) => {
    if (mode === "cursor")
      return res
        .status(409)
        .json({
          error: "CURSOR_ACTIVE: wait for the user to return to view mode",
        });
    res.json(
      write(file, req.body.revision, (scene) => patch(scene, req.body.changes)),
    );
    notify();
  });
  app.post("/api/save", (req, res) => {
    if (mode !== "cursor")
      return res.status(409).json({ error: "Cursor mode is not enabled" });
    res.json(write(file, req.body.revision, () => patch(req.body.scene, {})));
    notify();
  });
  app.post("/api/untangle", (req, res) => {
    res.json(
      write(file, req.body.revision, (scene) =>
        patch(scene, { untangle: req.body.enabled }),
      ),
    );
    notify();
  });
  app.post("/api/render", async (req, res, next) => {
    try {
      const { scene, revision } = read(file);
      if (cachedRevision !== revision) {
        cached.clear();
        cachedRevision = revision;
      }
      const format = req.body.format;
      if (!["png", "svg"].includes(format))
        throw Error("Format must be png or svg");
      if (!cached.has(format)) cached.set(format, renderData(scene, format));
      res.json(await cached.get(format));
    } catch (error) {
      cached.clear();
      next(error);
    }
  });
  const server = createServer(app);
  app.post("/api/stop", (_req, res) => {
    if (mode === "cursor")
      return res
        .status(409)
        .json({
          error: "Return to view mode to finish saving before stopping",
        });
    res.json({ stopped: true });
    for (const client of clients) client.end();
    server.close(() => process.exit(0));
  });
  app.use((error, _req, res, _next) =>
    res.status(409).json({ error: error.message }),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(
    sessionPath(file),
    JSON.stringify({ url, token, pid: process.pid }),
    { mode: 0o600 },
  );
  fs.watchFile(file, { interval: 250 }, () => {
    try {
      if (read(file).revision !== lastRevision) notify();
    } catch {}
  });
  process.on("exit", () => {
    try {
      fs.unlinkSync(sessionPath(file));
    } catch {}
  });
  console.log(JSON.stringify({ url, file }));
}
