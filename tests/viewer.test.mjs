import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { root, sessionPath } from "../scripts/diagram.mjs";
import { compose, read, write } from "../scripts/diagram-core.mjs";

test(
  "local viewer supports cursor editing and safely hands the saved document back to the CLI",
  { timeout: 60000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-viewer-"));
    const file = path.join(dir, "test.excalidraw");
    write(file, undefined, () =>
      compose([
        {
          id: "note",
          type: "text",
          x: 100,
          y: 100,
          text: "Original label",
          fontSize: 24,
        },
      ]),
    );
    const cli = (...args) =>
      spawnSync(
        process.execPath,
        [path.join(root, "scripts/diagram.mjs"), ...args],
        { encoding: "utf8", cwd: root },
      );
    let browser;
    try {
      const opened = cli("open", file);
      assert.equal(opened.status, 0, opened.stderr);
      const { url } = JSON.parse(opened.stdout);
      const { token } = JSON.parse(fs.readFileSync(sessionPath(file)));
      const request = async (route, body, auth = true) => {
        const response = await fetch(`${url}/api/${route}`, {
          method: body ? "POST" : "GET",
          headers: {
            ...(auth ? { Authorization: `Bearer ${token}` } : {}),
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return response;
      };
      assert.equal((await request("scene", null, false)).status, 403);
      assert.equal(
        (
          await request(
            "untangle",
            { revision: read(file).revision, enabled: true },
            false,
          )
        ).status,
        403,
      );
      browser = await chromium.launch({
        channel: process.env.CI ? undefined : "chrome",
        headless: true,
      });
      const page = await browser.newPage({
        viewport: { width: 1200, height: 800 },
      });
      const errors = [],
        external = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) => {
        if (
          /^https?:/.test(route.request().url()) &&
          !route.request().url().startsWith(url)
        ) {
          external.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      await page.goto(url);
      await page.getByRole("button", { name: "Enable cursor mode" }).waitFor();
      await page.waitForFunction(() =>
        document
          .querySelector('footer[role="status"]')
          ?.textContent.includes("View mode"),
      );
      const untangle = page.getByRole("checkbox", {
        name: "Untangle connected arrows",
      });
      assert.equal(await untangle.isChecked(), false);
      await untangle.check();
      await page.waitForFunction(
        () => document.querySelector('input[type="checkbox"]')?.checked,
      );
      await page.waitForFunction(
        () => !document.querySelector('input[type="checkbox"]')?.disabled,
      );
      assert.equal(read(file).scene.wydraw.untangle, true);
      await untangle.uncheck();
      await page.waitForFunction(
        () => !document.querySelector('input[type="checkbox"]')?.checked,
      );
      await page.waitForFunction(
        () => !document.querySelector('input[type="checkbox"]')?.disabled,
      );
      assert.equal(read(file).scene.wydraw.untangle, false);
      assert.equal(
        await page
          .getByRole("button", { name: "Enable cursor mode" })
          .innerText(),
        "",
      );
      await page.getByRole("button", { name: "Enable cursor mode" }).click();
      await page
        .getByRole("button", { name: "Save · return to agent" })
        .waitFor();
      const blocked = await request("apply", {
        revision: read(file).revision,
        changes: { delete: ["note"] },
      });
      assert.equal(blocked.status, 409);
      // Exercise Excalidraw's actual text editing UI, not a server-side substitute.
      await page.locator(".excalidraw").click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Enter");
      const editor = page.locator("textarea.excalidraw-wysiwyg");
      await editor.waitFor();
      await editor.fill("Human edited label");
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Save · return to agent" })
        .click();
      await page.getByRole("button", { name: "Enable cursor mode" }).waitFor();
      assert.equal(
        read(file).scene.elements.find((e) => e.id === "note").text,
        "Human edited label",
      );
      const firstRender = await (
        await request("render", { format: "svg" })
      ).json();
      const cachedRender = await (
        await request("render", { format: "svg" })
      ).json();
      assert.equal(firstRender.data, cachedRender.data);
      const events = await fetch(`${url}/api/events?token=${token}`, {
        signal: AbortSignal.timeout(5000),
      });
      const stream = events.body.getReader();
      const event = stream.read();
      const revision = read(file).revision;
      const patchFile = path.join(dir, "patch.json");
      fs.writeFileSync(
        patchFile,
        JSON.stringify({
          update: [{ id: "note", set: { x: 200, strokeColor: "#ff0000" } }],
        }),
      );
      const applied = cli("apply", file, patchFile, "--revision", revision);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(new TextDecoder().decode((await event).value), /revision/);
      await stream.cancel();
      const changedRender = await (
        await request("render", { format: "svg" })
      ).json();
      assert.notEqual(changedRender.data, firstRender.data);
      assert.equal(
        read(file).scene.elements.find((e) => e.id === "note").text,
        "Human edited label",
      );
      assert.notEqual(
        cli("apply", file, patchFile, "--revision", revision).status,
        0,
      );
      await page.reload();
      await page.getByRole("button", { name: "Enable cursor mode" }).waitFor();
      await page.screenshot({ path: path.join(root, "audit/viewer.png") });
      assert.deepEqual(errors, []);
      assert.deepEqual(external, [], "The editor should not fetch CDN assets");
    } finally {
      if (browser) await browser.close();
      try {
        const { url, token } = JSON.parse(fs.readFileSync(sessionPath(file)));
        await fetch(`${url}/api/mode`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
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
