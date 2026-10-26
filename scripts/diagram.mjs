#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  compose,
  patch,
  read,
  write,
  summary,
  validate,
  render,
  hash,
} from "./diagram-core.mjs";

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const sessionPath = (file) =>
  path.join(root, ".state", `${hash(path.resolve(file)).slice(0, 20)}.json`);

async function session(file) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(sessionPath(file), "utf8"));
    const response = await fetch(`${info.url}/api/scene`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) return info;
  } catch {}
  if (info?.pid) {
    let alive = false;
    try {
      process.kill(info.pid, 0);
      alive = true;
    } catch {}
    if (alive)
      throw Error(
        "The document viewer is unreachable; restore it before writing or opening another viewer",
      );
  }
  return null;
}

async function main() {
  const [command, arg, value, ...flags] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(`Local diagrams (no browser needed except open):
  create FILE.excalidraw ELEMENTS.json|- [--light]
  inspect FILE.excalidraw [ELEMENT_ID ...]
  apply FILE.excalidraw PATCH.json --revision HASH
  validate FILE.excalidraw
  render FILE.excalidraw OUTPUT.png|OUTPUT.svg
  open FILE.excalidraw
  stop FILE.excalidraw
  serve FILE.excalidraw
Create/apply accept JSON from stdin with -. One batch draws the whole scene.
Minimal shape: {"id":"api","type":"rectangle","text":"API"}
Link: {"id":"flow","type":"arrow","startElementId":"api","endElementId":"db"}
Any native Excalidraw shape/style/position is accepted; Pencil styling is only a default.
Grouping: {"groups":[{"id":"card","elements":["panel","heading","body"]}]}
Connect: update an arrow with set: {"startElementId":"api","endElementId":"db"}
Untangle: apply {"untangle":true}; false disables future rerouting.
Patch: {"update":[{"id":"api","set":{"x":120,"text":"HTTP API"}}]}
inspect returns the revision required by apply; only listed elements change.
Cursor mode pauses agent writes. open starts a warm renderer and live viewer.`);
    return;
  }
  if (!arg) throw Error("A scene path is required");
  const file = path.resolve(arg);
  if (command === "create") {
    if (fs.existsSync(file))
      throw Error("Scene exists; inspect and apply a patch");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const input = JSON.parse(
      fs.readFileSync(value === "-" ? 0 : value, "utf8"),
    );
    console.log(
      JSON.stringify(
        summary(
          write(file, undefined, () =>
            compose(input, flags.includes("--light") ? "light" : "dark"),
          ),
        ),
      ),
    );
  } else if (command === "inspect") {
    const result = summary(read(file));
    const ids = new Set([value, ...flags].filter(Boolean));
    if (ids.size)
      result.elements = result.elements.filter((e) => ids.has(e.id));
    console.log(JSON.stringify(result));
  } else if (command === "validate") {
    validate(read(file).scene);
    console.log(JSON.stringify({ valid: true, file }));
  } else if (command === "render") {
    const running = await session(file);
    if (!running)
      console.log(JSON.stringify(await render(file, path.resolve(value))));
    else {
      const format = path.extname(value).slice(1);
      const response = await fetch(`${running.url}/api/render`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${running.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ format }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      fs.writeFileSync(
        value,
        result.data,
        format === "png" ? "base64" : "utf8",
      );
      console.log(
        JSON.stringify({
          path: path.resolve(value),
          width: result.width,
          height: result.height,
          warnings: result.warnings,
        }),
      );
    }
  } else if (command === "apply") {
    const revision = flags[flags.indexOf("--revision") + 1];
    if (!flags.includes("--revision") || !revision)
      throw Error("--revision from inspect is required");
    const changes = JSON.parse(
      fs.readFileSync(value === "-" ? 0 : value, "utf8"),
    );
    const running = await session(file);
    if (running) {
      const response = await fetch(`${running.url}/api/apply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${running.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ revision, changes }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(body.error);
      console.log(JSON.stringify(summary(body)));
    } else
      console.log(
        JSON.stringify(
          summary(write(file, revision, (scene) => patch(scene, changes))),
        ),
      );
  } else if (command === "serve") {
    const { serve } = await import("./diagram-server.mjs");
    await serve(file);
  } else if (command === "open") {
    let running = await session(file);
    if (!running) {
      fs.mkdirSync(path.join(root, ".state"), { recursive: true });
      const log = fs.openSync(
        path.join(root, ".state", "viewer.log"),
        "a",
        0o600,
      );
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "serve", file],
        { detached: true, stdio: ["ignore", log, log], cwd: root },
      );
      child.unref();
      fs.closeSync(log);
      for (let i = 0; i < 80 && !running; i++) {
        await new Promise((r) => setTimeout(r, 100));
        running = await session(file);
      }
    }
    if (!running)
      throw Error("Viewer failed to start; inspect .state/viewer.log");
    console.log(JSON.stringify({ url: running.url, mode: "view", file }));
  } else if (command === "stop") {
    const running = await session(file);
    if (running) {
      const response = await fetch(`${running.url}/api/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${running.token}` },
      });
      const body = await response.json();
      if (!response.ok) throw Error(body.error);
      console.log(JSON.stringify(body));
    } else console.log(JSON.stringify({ stopped: false }));
  } else throw Error(`Unknown command: ${command}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
