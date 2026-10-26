import fs from "node:fs";
import { connect, group, untangle } from "./graph.mjs";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareElement } from "../node_modules/mcp-excalidraw-server/dist/core/normalize.js";
import { expandElementsForExport } from "../node_modules/mcp-excalidraw-server/dist/core/expand-elements.js";

export const palettes = {
  dark: {
    background: "#f5f1e8",
    panel: "#eee8db",
    border: "#68645d",
    text: "#373b3b",
    accent: "#527e79",
  },
  light: {
    background: "#f4f5f7",
    panel: "#ffffff",
    border: "#526176",
    text: "#243247",
    accent: "#187b79",
  },
};
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function read(file) {
  const raw = fs.readFileSync(file, "utf8");
  return { scene: JSON.parse(raw), revision: hash(raw) };
}

export function validate(scene) {
  if (scene.type !== "excalidraw" || !Array.isArray(scene.elements))
    throw Error("Expected an Excalidraw scene");
  const ids = new Set();
  for (const e of scene.elements) {
    if (!e.id || ids.has(e.id))
      throw Error(`Missing or duplicate element ID: ${e.id}`);
    ids.add(e.id);
    for (const key of ["x", "y", "width", "height"]) {
      if (
        !Number.isFinite(e[key]) ||
        (["width", "height"].includes(key) && e[key] < 0)
      )
        throw Error(`Invalid ${key}: ${e.id}`);
    }
  }
  for (const e of scene.elements) {
    const refs = [
      e.containerId,
      e.frameId,
      e.startBinding?.elementId,
      e.endBinding?.elementId,
      ...(e.boundElements ?? []).map((b) => b.id),
    ].filter(Boolean);
    for (const id of refs)
      if (!ids.has(id)) throw Error(`Dangling reference ${e.id} → ${id}`);
  }
  return scene;
}

function routeConnectors(elements, moved, selected) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const e of elements) {
    if (
      e.locked ||
      e.type !== "arrow" ||
      !e.customData?.autoRoute ||
      (selected && !selected.has(e.id))
    )
      continue;
    const from = byId.get(e.startBinding?.elementId),
      to = byId.get(e.endBinding?.elementId);
    if (!from || !to || (moved && !moved.has(from.id) && !moved.has(to.id)))
      continue;
    const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
    const forward = horizontal ? to.x >= from.x : to.y >= from.y;
    const a = horizontal
      ? [from.x + (forward ? from.width + 4 : -4), from.y + from.height / 2]
      : [from.x + from.width / 2, from.y + (forward ? from.height + 4 : -4)];
    const b = horizontal
      ? [to.x + (forward ? -4 : to.width + 4), to.y + to.height / 2]
      : [to.x + to.width / 2, to.y + (forward ? -4 : to.height + 4)];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    Object.assign(e, {
      x: a[0],
      y: a[1],
      width: Math.abs(dx),
      height: Math.abs(dy),
      points: horizontal
        ? [
            [0, 0],
            [dx / 2, 0],
            [dx / 2, dy],
            [dx, dy],
          ]
        : [
            [0, 0],
            [0, dy / 2],
            [dx, dy / 2],
            [dx, dy],
          ],
      elbowed: false,
      roundness: e.roundness,
    });
    const label = elements.find(
      (t) => t.containerId === e.id && t.type === "text",
    );
    if (label) {
      label.x = (a[0] + b[0]) / 2 - label.width / 2;
      label.y = (a[1] + b[1]) / 2 - label.height / 2;
    }
  }
}

export function compose(input, theme = "dark", existing = []) {
  const p = palettes[theme];
  if (!p) throw Error("Theme must be dark or light");
  const specs = Array.isArray(input) ? input : input.elements;
  if (!Array.isArray(specs)) throw Error("Expected an element array");
  const prepared = specs.map((e, i) => {
    if (!e.id) throw Error("Supply stable IDs for every element");
    const shape = !["text", "arrow", "line"].includes(e.type);
    return prepareElement({
      x: (i % 3) * 320,
      y: Math.floor(i / 3) * 180,
      width: shape ? 240 : 0,
      height: shape ? 88 : 0,
      strokeColor: e.type === "text" ? p.text : p.border,
      backgroundColor: shape ? p.panel : "transparent",
      fillStyle: "solid",
      strokeWidth: 1.5,
      roughness: 1,
      fontFamily: 3,
      fontSize: 18,
      roundness: { type: 3 },
      ...(e.startElementId && e.endElementId && !e.points
        ? { customData: { autoRoute: true }, endArrowhead: "arrow" }
        : {}),
      ...e,
    });
  });
  const elements = expandElementsForExport(prepared, { deterministic: true });
  const originals = new Map(prepared.map((e) => [e.id, e]));
  for (const e of elements) {
    const original = originals.get(e.id);
    if (original) e.roundness = original.roundness;
    else if (e.type === "text" && e.containerId) {
      e.roughness = originals.get(e.containerId)?.roughness ?? 0;
      e.strokeColor = p.text;
    }
  }
  const all = [...structuredClone(existing), ...elements];
  connect(all);
  group(all, input.groups ?? []);
  routeConnectors(all, undefined, new Set(elements.map((e) => e.id)));
  return validate({
    type: "excalidraw",
    version: 2,
    source: "wydraw",
    elements,
    appState: { viewBackgroundColor: p.background, gridSize: 16 },
    files: {},
    ...(existing.length ? { elements: all } : {}),
  });
}

export function patch(scene, changes) {
  const next = structuredClone(scene);
  if (changes.background !== undefined) {
    if (typeof changes.background !== "string")
      throw Error("Background must be a color string");
    next.appState = {
      ...next.appState,
      viewBackgroundColor: changes.background,
    };
  }
  const byId = new Map(next.elements.map((e) => [e.id, e]));
  for (const { id, set } of changes.update ?? []) {
    const e = byId.get(id);
    if (!e) throw Error(`Unknown element: ${id}`);
    if (!set || typeof set !== "object" || "id" in set || "type" in set)
      throw Error("Updates require set; identity and type are immutable");
    if (e.locked && !(Object.keys(set).length === 1 && set.locked === false))
      throw Error(`Locked element: ${id}`);
    const fields = { ...set };
    if (
      Object.hasOwn(fields, "startElementId") ||
      Object.hasOwn(fields, "endElementId")
    )
      fields.customData = { ...e.customData, autoRoute: true };
    const label = next.elements.find(
      (t) => t.type === "text" && t.containerId === id,
    );
    if (label && e.type !== "text") {
      if (fields.text !== undefined) {
        label.text = label.originalText = fields.text;
        delete fields.text;
      }
      label.x += (fields.x ?? e.x) - e.x;
      label.y += (fields.y ?? e.y) - e.y;
      if (fields.width !== undefined)
        label.width = Math.max(1, fields.width - 20);
    }
    Object.assign(e, fields);
    if (fields.points && e.customData?.autoRoute)
      e.customData.autoRoute = false;
    if (e.type === "text" && fields.text !== undefined)
      e.originalText = fields.text;
    e.version = (e.version ?? 1) + 1;
  }
  const deleted = new Set(changes.delete ?? []);
  for (const id of deleted) {
    if (!byId.has(id)) throw Error(`Unknown element: ${id}`);
    if (byId.get(id).locked) throw Error(`Locked element: ${id}`);
  }
  // Removing a panel removes its bound label, but never silently removes relationships.
  next.elements = next.elements.filter(
    (e) => !deleted.has(e.id) && !deleted.has(e.containerId),
  );
  for (const e of next.elements)
    if (e.boundElements)
      e.boundElements = e.boundElements.filter((b) => !deleted.has(b.id));
  if (changes.create?.length) {
    const theme =
      next.appState.viewBackgroundColor === palettes.light.background
        ? "light"
        : "dark";
    next.elements = compose(changes.create, theme, next.elements).elements;
  }
  connect(next.elements);
  group(next.elements, changes.groups ?? []);
  if (changes.untangle !== undefined) {
    if (typeof changes.untangle !== "boolean")
      throw Error("untangle must be boolean");
    next.wydraw = { ...next.wydraw, untangle: changes.untangle };
  }
  routeConnectors(
    next.elements,
    new Set((changes.update ?? []).map((e) => e.id)),
  );
  if (next.wydraw?.untangle) untangle(next.elements);
  return validate(next);
}

export function write(file, expected, transform) {
  const lock = `${file}.lock`;
  const fd = fs.openSync(lock, "wx", 0o600);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    const current = fs.existsSync(file) ? read(file) : null;
    if (current?.revision !== expected)
      throw Error("REVISION_CONFLICT: reread the scene before editing");
    const scene = validate(transform(current?.scene));
    fs.writeFileSync(temp, JSON.stringify(scene, null, 2) + "\n");
    fs.renameSync(temp, file);
    return read(file);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function summary({ scene, revision }) {
  return {
    revision,
    count: scene.elements.length,
    elements: scene.elements.map((e) => ({
      id: e.id,
      type: e.type,
      x: e.x,
      y: e.y,
      width: e.width,
      height: e.height,
      ...(e.groupIds?.length ? { groups: e.groupIds } : {}),
      ...(e.text ? { text: e.text } : {}),
      ...(e.locked ? { locked: true } : {}),
      ...(e.startBinding ? { from: e.startBinding.elementId } : {}),
      ...(e.endBinding ? { to: e.endBinding.elementId } : {}),
    })),
  };
}

export async function renderData(scene, format) {
  if (!["png", "svg"].includes(format))
    throw Error("Output must end in .png or .svg");
  const { renderScene } = await import(
    "../node_modules/mcp-excalidraw-server/dist/core/render/index.js"
  );
  return renderScene(scene, {
    format,
    viewBackgroundColor: scene.appState?.viewBackgroundColor,
    padding: 32,
    embedFonts: true,
    systemFonts: false,
  });
}

export async function render(file, out) {
  const { scene } = read(file);
  const format = path.extname(out).slice(1);
  const result = await renderData(scene, format);
  fs.writeFileSync(out, result.data, format === "png" ? "base64" : "utf8");
  return {
    path: path.resolve(out),
    width: result.width,
    height: result.height,
    warnings: result.warnings,
  };
}
