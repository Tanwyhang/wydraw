import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compose,
  patch,
  read,
  write,
  render,
  validate,
} from "../scripts/diagram-core.mjs";

const input = [
  { id: "a", type: "rectangle", x: 0, y: 0, text: "API" },
  { id: "b", type: "rectangle", x: 400, y: 0, text: "Database" },
  { id: "edge", type: "arrow", startElementId: "a", endElementId: "b" },
];

test("scoped patches preserve unrelated data and move attached labels/connectors", () => {
  const scene = compose(input);
  const before = structuredClone(scene.elements.find((e) => e.id === "b"));
  const next = patch(scene, {
    update: [{ id: "a", set: { x: 40, text: "HTTP API" } }],
  });
  assert.deepEqual(
    next.elements.find((e) => e.id === "b"),
    before,
  );
  assert.equal(next.elements.find((e) => e.id === "a-label").text, "HTTP API");
  assert.equal(next.elements.find((e) => e.id === "a-label").x, 50);
  assert.equal(next.elements.find((e) => e.id === "edge").x, 284);
  assert.equal(scene.elements.find((e) => e.id === "a").x, 0);
});

test("invalid, locked, duplicate, and dangling edits fail without partial mutation", () => {
  const scene = compose(input);
  assert.throws(() => patch(scene, { delete: ["b"] }), /Dangling/);
  assert.throws(
    () => patch(scene, { create: [{ id: "a", type: "rectangle" }] }),
    /duplicate/,
  );
  assert.throws(
    () => patch(scene, { update: [{ id: "a", set: { width: -1 } }] }),
    /Invalid/,
  );
  const locked = patch(scene, { update: [{ id: "a", set: { locked: true } }] });
  assert.throws(
    () => patch(locked, { update: [{ id: "a", set: { x: 20 } }] }),
    /Locked/,
  );
  assert.equal(
    patch(locked, { update: [{ id: "a", set: { locked: false } }] }).elements[0]
      .locked,
    false,
  );
  validate(patch(scene, { delete: ["edge", "b"] }));
});

test("new connectors can bind existing nodes", () => {
  const scene = compose(input.slice(0, 2));
  const next = patch(scene, { create: [input[2]] });
  assert.equal(
    next.elements.find((e) => e.id === "edge").endBinding.elementId,
    "b",
  );
});

test("revision conflicts preserve external edits and headless exports are repeatable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-graph-"));
  try {
    const file = path.join(dir, "test.excalidraw");
    const first = write(file, undefined, () => compose(input));
    write(file, first.revision, (s) =>
      patch(s, { update: [{ id: "b", set: { x: 500 } }] }),
    );
    assert.throws(
      () => write(file, first.revision, () => first.scene),
      /REVISION_CONFLICT/,
    );
    assert.equal(read(file).scene.elements.find((e) => e.id === "b").x, 500);
    for (const ext of ["png", "svg"]) {
      await render(file, path.join(dir, `one.${ext}`));
      await render(file, path.join(dir, `two.${ext}`));
      assert.deepEqual(
        fs.readFileSync(path.join(dir, `one.${ext}`)),
        fs.readFileSync(path.join(dir, `two.${ext}`)),
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("custom styles and existing connector layouts survive unrelated additions", () => {
  const scene = compose([
    ...input,
    {
      id: "note",
      type: "text",
      text: "Custom",
      fontFamily: 1,
      strokeColor: "#ff0000",
      roughness: 2,
    },
    { id: "rounded", type: "rectangle", roundness: { type: 3 }, roughness: 2 },
  ]);
  assert.equal(scene.elements.find((e) => e.id === "note").fontFamily, 1);
  assert.equal(
    scene.elements.find((e) => e.id === "note").strokeColor,
    "#ff0000",
  );
  assert.deepEqual(scene.elements.find((e) => e.id === "rounded").roundness, {
    type: 3,
  });
  const edge = scene.elements.find((e) => e.id === "edge");
  edge.points = [
    [0, 0],
    [12, 20],
    [30, 50],
  ];
  const next = patch(scene, { create: [{ id: "extra", type: "ellipse" }] });
  assert.deepEqual(
    next.elements.find((e) => e.id === "edge"),
    edge,
  );
  edge.locked = true;
  assert.deepEqual(
    patch(scene, { update: [{ id: "a", set: { x: 70 } }] }).elements.find(
      (e) => e.id === "edge",
    ),
    edge,
  );
});

test("canvas backgrounds can be patched without changing elements", () => {
  const scene = compose(input);
  const next = patch(scene, { background: "#faf6ef" });
  assert.equal(next.appState.viewBackgroundColor, "#faf6ef");
  assert.deepEqual(next.elements, scene.elements);
});

test("arbitrary groups include bound labels and connections are reciprocal after rebind", () => {
  const scene = compose({
    elements: [...input, { id: "caption", type: "text", text: "Details" }],
    groups: [{ id: "card", elements: ["a", "caption"] }],
  });
  for (const id of ["a", "a-label", "caption"])
    assert.deepEqual(scene.elements.find((e) => e.id === id).groupIds, [
      "card",
    ]);
  assert.ok(
    scene.elements
      .find((e) => e.id === "a")
      .boundElements.some((e) => e.id === "edge"),
  );
  const next = patch(scene, {
    create: [{ id: "c", type: "ellipse", x: 800, y: 0 }],
    update: [{ id: "edge", set: { startElementId: "b", endElementId: "c" } }],
  });
  assert.equal(
    next.elements.find((e) => e.id === "edge").endBinding.elementId,
    "c",
  );
  assert.ok(
    !next.elements
      .find((e) => e.id === "a")
      .boundElements.some((e) => e.id === "edge"),
  );
  assert.ok(
    next.elements
      .find((e) => e.id === "c")
      .boundElements.some((e) => e.id === "edge"),
  );
  assert.throws(
    () => patch(scene, { groups: [{ id: "oops", elements: ["missing"] }] }),
    /Unknown group/,
  );
});

test("optional untangle avoids an intervening card and preserves nodes and locked paths", () => {
  const scene = compose([
    { id: "left", type: "rectangle", x: 0, y: 0, width: 100, height: 80 },
    { id: "right", type: "rectangle", x: 500, y: 0, width: 100, height: 80 },
    {
      id: "obstacle",
      type: "rectangle",
      x: 220,
      y: -50,
      width: 130,
      height: 200,
    },
    {
      id: "link",
      type: "arrow",
      startElementId: "left",
      endElementId: "right",
    },
  ]);
  const next = patch(scene, { untangle: true });
  assert.equal(next.wydraw.untangle, true);
  for (const id of ["left", "right", "obstacle"])
    assert.deepEqual(
      next.elements.find((e) => e.id === id),
      scene.elements.find((e) => e.id === id),
    );
  const edge = next.elements.find((e) => e.id === "link");
  assert.ok(
    edge.points.some((p) => edge.y + p[1] <= -58 || edge.y + p[1] >= 158),
  );
  for (let i = 1; i < edge.points.length; i++) {
    const a = edge.points[i - 1].map((v, j) => v + (j ? edge.y : edge.x)),
      b = edge.points[i].map((v, j) => v + (j ? edge.y : edge.x));
    assert.ok(a[0] === b[0] || a[1] === b[1]);
    if (a[1] === b[1] && a[1] > -50 && a[1] < 150)
      assert.ok(Math.max(a[0], b[0]) <= 220 || Math.min(a[0], b[0]) >= 350);
  }
  assert.deepEqual(patch(next, { untangle: false }).elements, next.elements);
  const locked = patch(scene, {
    update: [{ id: "link", set: { locked: true } }],
  });
  assert.deepEqual(
    patch(locked, { untangle: true }).elements.find((e) => e.id === "link"),
    locked.elements.find((e) => e.id === "link"),
  );
});
