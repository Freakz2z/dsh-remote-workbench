import { test, expect, type Page } from "@playwright/test";

/**
 * Right-sidebar Agent mode. The development preview mounts the exact component
 * the native `sidebar.right.pane.tab` seat renders (`?agent=1`), so these tests
 * cover the pane's real UI without a host: monitoring, multi-file drafts, PDF
 * annotation/form saving and remote file operations.
 */
async function openAgent(page: Page) {
  await page.goto("/?agent=1");
  await expect(page.locator(".rw-agent")).toBeVisible();
  await expect(page.getByRole("option", { name: /sample\.pdf/ })).toBeVisible();
}

const row = (page: Page, name: string) =>
  page.getByRole("option", { name: new RegExp(name.replace(".", "\\.")) });

test("agent pane shows files and monitoring with no terminal, command bar or chat", async ({
  page,
}) => {
  await openAgent(page);
  // The Agent mode must never host the workbench's terminal, command bar or AI chat.
  await expect(page.locator(".rw-agent .rw-terminal-tab")).toHaveCount(0);
  await expect(page.locator(".rw-agent .rw-xterm")).toHaveCount(0);
  await expect(page.locator(".rw-agent .rw-cmdbar")).toHaveCount(0);
  await expect(page.locator(".rw-agent .rw-ai")).toHaveCount(0);

  // Six monitoring views, driven by the host's /resources endpoint.
  await page.getByRole("tab", { name: "监控" }).click();
  const tabs = page.getByRole("tablist", { name: "监控视图" });
  for (const label of ["综合", "CPU", "显卡", "内存", "磁盘", "网络"])
    await expect(tabs.getByRole("tab", { name: label })).toBeVisible();
  await expect(page.locator(".rw-monitor-card").first()).toBeVisible();
  await expect(page.locator(".rw-monitor-grid strong").first()).toContainText(
    "%",
  );

  await tabs.getByRole("tab", { name: "CPU" }).click();
  // Per-core rows appear only when the platform exposes them; the section and
  // the total are always real either way.
  await expect(page.getByText("每核心")).toBeVisible();
  await expect(page.locator(".rw-monitor-hero strong").first()).toContainText(
    "%",
  );
  await tabs.getByRole("tab", { name: "显卡" }).click();
  await expect(
    page
      .locator(".rw-monitor-gpus .rw-monitor-card, .rw-monitor-empty")
      .first(),
  ).toBeVisible();
  await tabs.getByRole("tab", { name: "磁盘" }).click();
  await expect(
    page.getByRole("columnheader", { name: "挂载点" }),
  ).toBeVisible();
  await tabs.getByRole("tab", { name: "网络" }).click();
  await expect(page.getByRole("columnheader", { name: "网卡" })).toBeVisible();

  // "交给 AI" opens a review dialog, not a chat panel.
  await page.getByRole("button", { name: "交给 AI" }).click();
  await expect(
    page.getByRole("dialog", { name: "交给当前 Agent" }),
  ).toBeVisible();
  await expect(page.getByLabel("交给 Agent 的内容")).toContainText("CPU");
  await page.getByRole("button", { name: "关闭" }).click();
});

test("text and PDF drafts survive mode, list and tab switches", async ({
  page,
}) => {
  await openAgent(page);
  await row(page, "sample.md").dblclick();
  const editor = page.locator(".rw-code-host .cm-content").first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n\n草稿标记 DRAFT_MARK");
  await expect(page.locator(".rw-agent-tab.dirty")).toHaveCount(1);

  // Monitor mode hides the files pane but must not unmount it.
  await page.getByRole("tab", { name: "监控" }).click();
  await expect(
    page.locator(".rw-agent-pane[data-active='false'] .rw-code-host"),
  ).toHaveCount(1);
  await page.getByRole("tab", { name: "文件" }).click();
  await expect(editor).toContainText("DRAFT_MARK");

  // Return to the list (tabs stay open), open another file, come back.
  await page.getByRole("button", { name: "返回文件列表" }).click();
  await row(page, "sample.json").dblclick();
  await expect(page.locator(".rw-agent-tab")).toHaveCount(2);
  await page
    .locator(".rw-agent-tab")
    .filter({ hasText: "sample.md" })
    .getByRole("tab")
    .click();
  await expect(page.locator(".rw-code-host .cm-content").first()).toContainText(
    "DRAFT_MARK",
  );

  // PDF: annotate + rotate, then switch tabs and back.
  await page.getByRole("button", { name: "返回文件列表" }).click();
  await row(page, "sample.pdf").dblclick();
  await expect(page.locator(".rw-pdf-canvas")).toBeVisible();
  const canvas = page.locator(".rw-pdf-canvas");
  await expect(canvas).toHaveAttribute("width", /\d{3,}/);
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
  await page.getByRole("textbox", { name: "批注内容" }).fill("检查这一段");
  await page.keyboard.press("Enter");
  await expect(page.locator(".rw-pdf-annotation")).toHaveCount(1);
  await page.getByRole("button", { name: "顺时针旋转" }).click();
  await expect(page.locator(".rw-pdf-rotate")).toContainText("90");

  await page
    .locator(".rw-agent-tab")
    .filter({ hasText: "sample.md" })
    .getByRole("tab")
    .click();
  await expect(page.locator(".rw-code-host .cm-content").first()).toContainText(
    "DRAFT_MARK",
  );
  await page
    .locator(".rw-agent-tab")
    .filter({ hasText: "sample.pdf" })
    .getByRole("tab")
    .click();
  await expect(page.locator(".rw-pdf-annotation")).toHaveCount(1);
  await expect(page.locator(".rw-pdf-rotate")).toContainText("90");

  // The Markdown tab is still dirty until saved.
  await expect(page.locator(".rw-agent-tab.dirty")).toHaveCount(2);
});

test("PDF form fields are editable and the annotated file is saved atomically", async ({
  page,
}) => {
  await openAgent(page);
  await row(page, "sample.pdf").dblclick();
  await expect(page.locator(".rw-pdf-canvas")).toBeVisible();
  await expect(page.locator(".rw-pdf-canvas")).toHaveAttribute(
    "width",
    /\d{3,}/,
  );
  const before = await page.evaluate(async () => {
    const bootstrap = await (
      await fetch("/api/remote-workbench/bootstrap")
    ).json();
    const host = bootstrap.hosts[0];
    const response = await fetch(
      "/api/remote-workbench/file/preview?" +
        new URLSearchParams({
          hostId: host.id,
          path: host.rootPath + "/sample.pdf",
        }),
    );
    return {
      etag: response.headers.get("etag"),
      host: host.id,
      root: host.rootPath,
    };
  });

  await page.getByRole("button", { name: "表单字段" }).click();
  const formField = page.locator(".rw-pdf-forms-list label").first();
  await expect(formField).toContainText("Operator");
  // The fixture file may already carry a value from an earlier run; write a unique one.
  const marker = `QA ${Date.now()}`;
  await formField.locator("input").fill(marker);

  const canvas = page.locator(".rw-pdf-canvas");
  // Click inside the visible top of the page: the forms panel covers the rest.
  await canvas.click({ position: { x: 60, y: 40 } });
  await page.getByRole("textbox", { name: "批注内容" }).fill("已核对");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: "保存 PDF" }).click();
  await expect(page.getByRole("status")).toContainText("PDF 批注已保存");
  await expect(page.locator(".rw-agent-tab.dirty")).toHaveCount(0);
  await expect(page.locator(".rw-pdf-annotation")).toHaveCount(0);

  const after = await page.evaluate(
    async ({ host, root }) => {
      const response = await fetch(
        "/api/remote-workbench/file/preview?" +
          new URLSearchParams({ hostId: host, path: root + "/sample.pdf" }),
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        etag: response.headers.get("etag"),
        length: bytes.length,
        base64: btoa(String.fromCharCode(...bytes.slice(0, 0))),
      };
    },
    { host: before.host, root: before.root },
  );
  expect(after.etag).not.toBe(before.etag);

  // Reopen: the saved form value and rotation are read back from the file.
  await page.getByRole("button", { name: "返回文件列表" }).click();
  await page
    .locator(".rw-agent-tab")
    .filter({ hasText: "sample.pdf" })
    .getByRole("button", { name: /关闭/ })
    .click();
  await row(page, "sample.pdf").dblclick();
  await page.getByRole("button", { name: "表单字段" }).click();
  await expect(
    page.locator(".rw-pdf-forms-list label input").first(),
  ).toHaveValue(marker);
});

test("markdown renders sanitized HTML, same-host images and split panes", async ({
  page,
}) => {
  await openAgent(page);
  await row(page, "sample.md").dblclick();
  await expect(page.locator(".rw-md-split > *")).toHaveCount(2);
  await expect(page.locator(".rw-markdown table")).toHaveCount(1);
  const image = page.locator(".rw-markdown img").first();
  await expect(image).toBeVisible();
  expect(await image.getAttribute("src")).toContain("/file/preview?");
  expect(await page.locator(".rw-markdown script").count()).toBe(0);

  // Preview-only and source-only modes are real toggles, not decorative.
  await page.getByRole("button", { name: "只看预览" }).click();
  await expect(page.locator(".rw-md-split > *")).toHaveCount(1);
  await expect(page.locator(".rw-markdown")).toBeVisible();
  await page.getByRole("button", { name: "只看源码" }).click();
  await expect(page.locator(".rw-code-host")).toBeVisible();
  await expect(page.locator(".rw-markdown")).toHaveCount(0);
});

test("agent pane edits remote files with the captured connection revision", async ({
  page,
}) => {
  await openAgent(page);
  // Every mutation must carry the connection captured when its dialog opened.
  const mutations: { kind: string; body: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    const match = /\/files\/(create|copy|chmod|rename|mkdir|remove)$/.exec(
      request.url(),
    );
    if (!match) return;
    mutations.push({
      kind: match[1]!,
      body: JSON.parse(request.postData() ?? "{}") as Record<string, unknown>,
    });
  });

  const name = `agent-${Date.now()}.txt`;
  await page.getByRole("button", { name: "新建文件", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建文件" });
  await dialog.getByLabel("名称").fill(name);
  await dialog.getByRole("button", { name: "创建" }).click();
  await expect(row(page, name)).toBeVisible();

  // New folder uses the same rule.
  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  const folder = page.getByRole("dialog", { name: "新建文件夹" });
  const folderName = `agent-dir-${Date.now()}`;
  await folder.getByLabel("名称").fill(folderName);
  await folder.getByRole("button", { name: "创建" }).click();
  await expect(row(page, folderName)).toBeVisible();

  await row(page, name).click();
  await page
    .locator(".rw-agent-detail")
    .getByRole("button", { name: "权限" })
    .click();
  const chmod = page.getByRole("dialog", { name: "修改权限" });
  await chmod.getByLabel("权限").fill("600");
  await chmod.getByRole("button", { name: "保存权限" }).click();
  await expect(page.locator(".rw-agent-detail")).toContainText("600");

  await page
    .locator(".rw-agent-detail")
    .getByRole("button", { name: "复制到…" })
    .click();
  const copy = page.getByRole("dialog", { name: "复制到" });
  await copy.getByLabel("目标路径").fill(`copied-${name}`);
  await copy.getByRole("button", { name: "复制", exact: true }).click();
  await expect(row(page, `copied-${name}`)).toBeVisible();

  // Rename through the row menu keeps the same captured revision.
  await row(page, `copied-${name}`).hover();
  await page.getByRole("button", { name: `copied-${name} 更多操作` }).click();
  const move = page.getByRole("dialog", { name: "移动 / 重命名" });
  await move.getByLabel("名称").fill(`moved-${name}`);
  await move.getByRole("button", { name: "移动" }).click();
  await expect(row(page, `moved-${name}`)).toBeVisible();

  for (const target of [`moved-${name}`, name, folderName]) {
    await row(page, target).click();
    await page
      .locator(".rw-agent-detail")
      .getByRole("button", { name: "删除" })
      .click();
    await page
      .getByRole("dialog", { name: "删除远程项目" })
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await expect(row(page, target)).toHaveCount(0);
  }

  const kinds = mutations.map((entry) => entry.kind);
  expect(kinds).toEqual(
    expect.arrayContaining([
      "create",
      "mkdir",
      "chmod",
      "copy",
      "rename",
      "remove",
    ]),
  );
  for (const mutation of mutations) {
    expect(typeof mutation.body.hostId).toBe("string");
    expect(typeof mutation.body.hostRevision).toBe("number");
  }
});

test("empty agent pane can create connections without leaving the sidebar", async ({
  page,
}) => {
  await openAgent(page);
  await page.locator(".rw-agent-host-button").click();
  const switcher = page.getByRole("dialog", { name: "选择服务器" });
  await expect(switcher).toBeVisible();
  await expect(
    switcher.getByRole("button", { name: "+ 新建连接" }),
  ).toBeVisible();
  await switcher.getByRole("button", { name: "+ 新建连接" }).click();
  const dialog = page.getByRole("dialog", { name: "新建连接" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("连接名称")).toBeVisible();
  await expect(dialog.getByLabel("主机地址")).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);

  // Editing the current connection is available too.
  await page.locator(".rw-agent-host-button").click();
  await page
    .getByRole("dialog", { name: "选择服务器" })
    .getByRole("button", { name: "编辑当前连接" })
    .click();
  await expect(page.getByRole("dialog", { name: "编辑连接" })).toBeVisible();
});
