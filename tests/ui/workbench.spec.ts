import { test, expect, type Page } from "@playwright/test";
import type { Snapshot } from "../../src/shared/types.ts";

/** Terminals persist host-side by design; close them so repeated runs stay within
 * the fixture's MaxSessions budget (monitoring opens its own SSH channels). */
async function closeTerminals(page: Page) {
  await page.evaluate(async () => {
    const base = "/api/remote-workbench";
    const snapshot = await (await fetch(base + "/snapshot")).json();
    const { csrf } = await (await fetch(base + "/bootstrap")).json();
    for (const terminal of snapshot.terminals) {
      await fetch(base + "/terminals/close", {
        method: "POST",
        headers: { "content-type": "application/json", "x-rw-csrf": csrf },
        body: JSON.stringify({ id: terminal.id }),
      });
    }
  });
}

test("terminal, transfers and right-sidebar file opening form one flow", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "本机集成测试" }),
  ).toBeVisible();
  await expect(page.getByText("nginx.conf", { exact: true })).toBeVisible();
  const bootstrap = (await page.evaluate(async () =>
    (await fetch("/api/remote-workbench/bootstrap")).json(),
  )) as Snapshot & { csrf: string };
  const host = bootstrap.hosts.find((h) => h.name === "本机集成测试")!;

  // The workbench itself has no AI collaboration surface at all.
  await expect(page.locator(".rw-ai")).toHaveCount(0);
  await expect(page.locator(".rw-ai-toggle")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /AI 协作/ })).toHaveCount(0);

  await page.locator(".rw-terminal-add").click();
  await expect(page.locator(".rw-terminal-tab").last()).toBeVisible();
  await expect(page.locator(".rw-terminal-connecting")).toHaveCount(0);
  await page.locator(".rw-xterm:visible").click();
  await page.keyboard.type(
    "printf '\\033[32mRemote Workbench connected.\\033[0m\\n'; pwd; ls -lah",
    { delay: 5 },
  );
  await page.keyboard.press("Enter");

  const name = `ui-${Date.now()}.txt`;
  await page.locator("input[type=file]").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded from browser\n"),
  });
  await expect(page.getByText(name, { exact: true })).toBeVisible();

  // Opening a file never uses a column inside the workbench: it opens the
  // native right-sidebar Agent surface (emulated by the dev preview drawer).
  await page.getByText(name, { exact: true }).dblclick();
  const drawer = page.getByRole("complementary", { name: "右侧栏预览" });
  await expect(drawer).toBeVisible();
  const editor = drawer.getByRole("textbox", { name: `${name} 内容` });
  await expect(editor).toContainText("uploaded from browser");
  await expect(page.locator(".rw-workbench .rw-editor")).toHaveCount(0);
  await expect(page.locator(".rw-workspace .rw-ai")).toHaveCount(0);

  // The file stays editable in the right sidebar and saves to SFTP.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("edited in the right sidebar\n");
  await drawer.getByRole("button", { name: "保存", exact: true }).click();
  await expect(drawer.getByRole("status")).toContainText("文件已保存");
  const value = await page.evaluate(
    async ({ id, path }) =>
      (
        await fetch(
          "/api/remote-workbench/file?" +
            new URLSearchParams({ hostId: id, path }),
        )
      ).json(),
    { id: host.id, path: host.rootPath + "/" + name },
  );
  expect(value.content).toContain("edited in the right sidebar");

  // Closing the drawer leaves the workbench and its terminal untouched.
  await page.getByRole("button", { name: "关闭右侧栏预览" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator(".rw-terminal-tab").last()).toBeVisible();

  const oldIds = (
    (await page.evaluate(async () =>
      (await fetch("/api/remote-workbench/snapshot")).json(),
    )) as Snapshot
  ).terminals.map((t) => t.id);
  await page.reload();
  await expect(page.locator(".rw-terminal-tab").first()).toBeVisible();
  const restored = (
    (await page.evaluate(async () =>
      (await fetch("/api/remote-workbench/snapshot")).json(),
    )) as Snapshot
  ).terminals.map((t) => t.id);
  expect(restored).toEqual(oldIds);

  await page.getByRole("button", { name: /任务与传输/ }).click();
  await expect(page.locator(".rw-task-row").first()).toBeVisible();
  await page.screenshot({ path: "docs/workbench-preview.png", fullPage: true });
  expect(errors).toEqual([]);
  await page.evaluate(
    async ({ id, path, csrf }) =>
      fetch("/api/remote-workbench/files/remove", {
        method: "POST",
        headers: { "content-type": "application/json", "x-rw-csrf": csrf },
        body: JSON.stringify({ hostId: id, path }),
      }),
    { id: host.id, path: host.rootPath + "/" + name, csrf: bootstrap.csrf },
  );
  await closeTerminals(page);
});

test("server switching lives in the top bar, never in a left sidebar", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".rw-workbench")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "本机集成测试" }),
  ).toBeVisible();
  await expect(page.locator(".rw-sidebar")).toHaveCount(0);
  await expect(
    page.locator(".rw-workbench .rw-main > .rw-topbar"),
  ).toBeVisible();
  await expect(page.locator(".rw-hostbar")).toHaveCount(0);

  await page.locator(".rw-host-switch").click();
  const switcher = page.getByRole("dialog", { name: "切换服务器" });
  await expect(switcher).toBeVisible();
  await expect(switcher.locator(".rw-switcher-row")).toHaveCount(1);
  await expect(switcher.locator(".rw-switcher-tag")).toContainText("当前");

  const topbar = await page.locator(".rw-topbar").boundingBox();
  const popover = await switcher.boundingBox();
  expect(popover!.y).toBeGreaterThanOrEqual(topbar!.y + topbar!.height - 1);
  expect(popover!.x).toBeGreaterThanOrEqual(0);
  expect(popover!.x + popover!.width).toBeLessThanOrEqual(1600);

  await page.getByRole("textbox", { name: "搜索主机" }).fill("不存在的服务器");
  await expect(switcher.getByText(/没有匹配/)).toBeVisible();
  await page.getByRole("textbox", { name: "搜索主机" }).fill("");
  await expect(
    switcher.getByRole("button", { name: "新建连接", exact: true }),
  ).toBeVisible();
  await expect(
    switcher.getByRole("button", { name: "从 SSH Config 导入", exact: true }),
  ).toBeVisible();
  await expect(
    switcher.getByRole("button", { name: "编辑当前连接", exact: true }),
  ).toBeVisible();
  // Escape closes and returns focus to the trigger, like a DSH menu.
  await page.keyboard.press("Escape");
  await expect(switcher).toHaveCount(0);
  await expect(page.locator(".rw-host-switch")).toBeFocused();

  // Arrow keys walk the menu rows without leaving the popover.
  await page.keyboard.press("Enter");
  await expect(switcher).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(
    switcher.locator('[data-rw-switch-row=""]').first(),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    switcher.locator('[data-rw-switch-row=""]').last(),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    switcher.locator('[data-rw-switch-row=""]').first(),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(switcher).toHaveCount(0);
});

test("panels and dialogs follow the host light and dark theme tokens", async ({
  page,
}) => {
  await page.goto("/");
  const shell = page.locator(".rw-workbench");
  await expect(shell).toBeVisible();
  const background = () =>
    shell.evaluate((el) => getComputedStyle(el).backgroundColor);

  expect(await background()).toBe("rgb(255, 255, 255)");
  expect(
    await page
      .locator(".rw-identity-name h1")
      .evaluate((el) => getComputedStyle(el).color),
  ).toBe("rgb(15, 17, 21)");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(background).toBe("rgb(21, 21, 23)");
  expect(
    await page
      .locator(".rw-identity-name h1")
      .evaluate((el) => getComputedStyle(el).color),
  ).toBe("rgb(249, 250, 251)");
  // The file column, terminal and dialogs all read the same dark palette.
  expect(
    await page
      .locator(".rw-pane-heading")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(21, 21, 23)");
  expect(
    await page
      .locator(".rw-files")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(21, 21, 23)");

  await page.locator(".rw-terminal-add").click();
  await expect(page.locator(".rw-terminal-body")).toBeVisible();
  expect(
    await page
      .locator(".rw-terminal-body")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(21, 21, 23)");
  await page.screenshot({
    path: "docs/workbench-dark-preview.png",
    fullPage: true,
  });

  // No fallback shadows a real DSH token: the host value wins without a reload.
  await page.evaluate(() =>
    document.body.style.setProperty("--dsw-alias-bg-base", "rgb(1, 2, 3)"),
  );
  await expect.poll(background).toBe("rgb(1, 2, 3)");
  await page.evaluate(() =>
    document.body.style.removeProperty("--dsw-alias-bg-base"),
  );
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(background).toBe("rgb(255, 255, 255)");
});

test("responsive layouts keep the workspace inside the viewport", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".rw-workbench")).toBeVisible();
  for (const width of [1280, 1000, 760, 390]) {
    await page.setViewportSize({ width, height: 850 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    const box = await page.locator(".rw-workbench").boundingBox();
    expect(box?.width).toBe(width);
    const topbar = await page.locator(".rw-topbar").boundingBox();
    expect(topbar?.width).toBe(width);
    const actions = await page.locator(".rw-topbar-actions").boundingBox();
    expect((actions?.x ?? 0) + (actions?.width ?? 0)).toBeLessThanOrEqual(
      width,
    );
  }
  await page.locator(".rw-host-switch").click();
  const popover = await page
    .getByRole("dialog", { name: "切换服务器" })
    .boundingBox();
  expect(popover!.x).toBeGreaterThanOrEqual(0);
  expect(popover!.x + popover!.width).toBeLessThanOrEqual(390);
});

test("command bar sends once, records raw text, and fills from history without executing", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".rw-terminal-add").click();
  await expect(page.locator(".rw-xterm:visible")).toBeVisible();
  await expect(page.locator(".rw-terminal-connecting")).toHaveCount(0);

  // Count PTY input frames so a double send would be visible.
  await page.evaluate(() => {
    const state = { frames: [] as string[] };
    (window as unknown as { __rwFrames: string[] }).__rwFrames = state.frames;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: unknown) {
      try {
        const value = JSON.parse(String(data));
        if (value?.type === "input") state.frames.push(String(value.data));
      } catch {}
      return send.call(this, data as never);
    };
  });

  const remember: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/commands/remember"))
      remember.push(request.postData() ?? "");
  });

  const bar = page.getByRole("textbox", { name: "命令输入" });
  const marker = `BAR_${Date.now()}`;
  await bar.fill(`echo ${marker}`);
  await bar.press("Enter");
  await expect(bar).toHaveValue("");
  await expect.poll(() => remember.length, { timeout: 5000 }).toBe(1);
  expect(remember[0]).toContain(`echo ${marker}`);

  // Leading whitespace is preserved in the record (the host decides sensitivity).
  await bar.fill(` echo ${marker}_LEAD`);
  await bar.press("Enter");
  await expect.poll(() => remember.length, { timeout: 5000 }).toBe(2);
  expect(remember[1]).toContain(`"command":" echo ${marker}_LEAD"`);

  const frames = await page.evaluate(
    () => (window as unknown as { __rwFrames: string[] }).__rwFrames,
  );
  expect(frames.filter((frame) => frame.includes(marker)).length).toBe(2);
  expect(
    frames.filter((frame) => frame.includes(`${marker}_LEAD`)).length,
  ).toBe(1);

  // Pick a history row: it only fills the bar, no new PTY input.
  await page.getByRole("button", { name: "命令历史" }).click();
  const picker = page.getByRole("dialog", { name: "命令历史" });
  await expect(picker).toBeVisible();
  await picker
    .getByRole("button", { name: new RegExp(marker) })
    .first()
    .click();
  await expect(bar).toHaveValue(new RegExp(marker));
  const afterFill = await page.evaluate(
    () => (window as unknown as { __rwFrames: string[] }).__rwFrames,
  );
  expect(afterFill.filter((frame) => frame.includes(marker)).length).toBe(2);
  await closeTerminals(page);
});

test("command library fills the bar and keeps secrets out of history", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".rw-terminal-add").click();
  await expect(page.locator(".rw-xterm:visible")).toBeVisible();
  await expect(page.locator(".rw-terminal-connecting")).toHaveCount(0);

  const bar = page.getByRole("textbox", { name: "命令输入" });
  const marker = `LIB_${Date.now()}`;
  await bar.fill(`echo ${marker}`);
  await bar.press("Enter");
  await expect(bar).toHaveValue("");

  await page.getByRole("button", { name: "管理命令库" }).click();
  const library = page.getByRole("dialog", { name: "命令库" });
  await expect(library).toBeVisible();
  await expect(
    library.getByText(`echo ${marker}`, { exact: false }).first(),
  ).toBeVisible();
  await expect(
    library.getByRole("button", { name: /暂停记录|恢复记录/ }),
  ).toBeVisible();
  await library.getByRole("button", { name: "关闭命令库" }).click();
  await expect(library).toHaveCount(0);

  // A leading-space command is never stored by the host.
  await bar.fill(` token=${marker}`);
  await bar.press("Enter");
  await bar.fill(`echo ${marker}`);
  await bar.press("Enter");
  await page.getByRole("button", { name: "管理命令库" }).click();
  const reopened = page.getByRole("dialog", { name: "命令库" });
  await expect(
    reopened.getByText(`token=${marker}`, { exact: false }),
  ).toHaveCount(0);
  await closeTerminals(page);
});
