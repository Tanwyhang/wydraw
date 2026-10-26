import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { compose, read, write } from "../scripts/diagram-core.mjs";
import { root, sessionPath } from "../scripts/diagram.mjs";

test(
  "dragging a grouped card moves its independent text and attached arrow endpoint",
  { timeout: 60000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wydraw-drag-")),
      file = path.join(dir, "drag.excalidraw");
    const cli = (...args) =>
      spawnSync(
        process.execPath,
        [path.join(root, "scripts/diagram.mjs"), ...args],
        { encoding: "utf8", cwd: root },
      );
    write(file, undefined, () =>
      compose({
        elements: [
          {
            id: "card",
            type: "rectangle",
            x: 0,
            y: 0,
            width: 240,
            height: 140,
          },
          { id: "heading", type: "text", x: 20, y: 25, text: "A grouped card" },
          { id: "body", type: "text", x: 20, y: 65, text: "Independent text" },
          {
            id: "target",
            type: "rectangle",
            x: 500,
            y: 0,
            width: 240,
            height: 140,
            text: "Target",
          },
          {
            id: "edge",
            type: "arrow",
            startElementId: "card",
            endElementId: "target",
          },
        ],
        groups: [
          { id: "card-component", elements: ["card", "heading", "body"] },
        ],
      }),
    );
    let browser;
    try {
      const open = cli("open", file);
      assert.equal(open.status, 0, open.stderr);
      const { url } = JSON.parse(open.stdout);
      browser = await chromium.launch({
        channel: process.env.CI ? undefined : "chrome",
        headless: true,
      });
      const page = await browser.newPage({
        viewport: { width: 1200, height: 800 },
      });
      await page.goto(url);
      await page.getByRole("button", { name: "Enable cursor mode" }).click();
      await page
        .getByRole("button", { name: "Save · return to agent" })
        .waitFor();
      // scrollToContent centers this 740 x 140 scene at unit zoom in a 1200 x 800 viewport.
      await page.mouse.move(300, 425);
      await page.mouse.down();
      await page.mouse.move(380, 475, { steps: 12 });
      await page.mouse.up();
      await page
        .getByRole("button", { name: "Save · return to agent" })
        .click();
      await page.getByRole("button", { name: "Enable cursor mode" }).waitFor();
      const after = read(file).scene.elements;
      const card = after.find((e) => e.id === "card");
      assert.ok(
        card.x > 40,
        "card should have moved by dragging its grouped interior",
      );
      assert.equal(after.find((e) => e.id === "heading").x - card.x, 20);
      assert.equal(after.find((e) => e.id === "body").y - card.y, 65);
      const edge = after.find((e) => e.id === "edge");
      assert.equal(edge.startBinding.elementId, "card");
      assert.ok(edge.x > 260, "bound endpoint follows card");
      assert.equal(after.find((e) => e.id === "target").x, 500);
    } finally {
      if (browser) await browser.close();
      try {
        const s = JSON.parse(fs.readFileSync(sessionPath(file)));
        await fetch(s.url + "/api/mode", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${s.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ mode: "view" }),
        });
      } catch {}
      cli("stop", file);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
