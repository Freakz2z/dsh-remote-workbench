import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "@playwright/test";
import { startFixture } from "../tests/ssh-fixture.ts";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";

const exec = promisify(execFile);
const dsh =
  process.env.DSH_BIN ??
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const home = resolve(".dev/dsh-verification-home");
await rm(home, { recursive: true, force: true });
await mkdir(home, { recursive: true });
const env = { ...process.env, DSH_HOME: home };
await exec(
  dsh,
  ["rw-verify", "--from-default-profile", "web", "--dump-config"],
  { env, maxBuffer: 4 * 1024 * 1024 },
);
await exec(
  dsh,
  [
    "plugin",
    "--profile",
    "rw-verify",
    "add",
    process.env.RW_INSTALL_SPEC ?? resolve("."),
  ],
  { env },
);
await writeFile(
  join(home, "profiles/rw-verify/cordis.patch.yml"),
  `- insert:\n    - id: rw-validation\n      name: ${JSON.stringify(resolve("tests/dsh-probe.mjs"))}\n`,
);
const server = spawn(dsh, ["rw-verify", "--no-open", "--port", "4726"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let diagnostic = "";
server.stderr.on("data", (b) => (diagnostic += b.toString()));
const entry = await new Promise<string>((resolveEntry, reject) => {
  const timer = setTimeout(
    () => reject(new Error("DSH did not start: " + diagnostic)),
    20000,
  );
  server.stdout.on("data", (b) => {
    const match = b
      .toString()
      .match(/http:\/\/127\.0\.0\.1:4726\/\?token=[\w-]+/);
    if (match) {
      clearTimeout(timer);
      resolveEntry(match[0]);
    }
  });
  server.once("exit", () => {
    clearTimeout(timer);
    reject(new Error("DSH exited: " + diagnostic));
  });
});
const fixture = await startFixture();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(entry);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("Get started", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByText("远程工作台", { exact: true }).first().click();
  await page.locator(".rw-workbench").waitFor();
  const base = "http://127.0.0.1:4726/api/remote-workbench";
  const bootstrap = await (await fetch(base + "/bootstrap")).json();
  const post = async (path: string, value: unknown) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rw-csrf": bootstrap.csrf,
      },
      body: JSON.stringify(value),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  };
  const host = await post("/hosts/save", {
    name: "OpenSSH 验证服务器",
    address: "127.0.0.1",
    port: fixture.port,
    username: fixture.username,
    rootPath: fixture.workspace,
    group: "本机集成测试",
    auth: "key",
    privateKeyPath: fixture.privateKeyPath,
    favorite: false,
  });
  await page.reload();
  await page.getByText("Get started", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByText("远程工作台", { exact: true }).first().click();
  await page.getByRole("heading", { name: "OpenSSH 验证服务器" }).waitFor();
  await page.getByRole("button", { name: "连接", exact: true }).first().click();
  await page.getByRole("dialog", { name: "核对服务器指纹" }).waitFor();
  assert.match(
    await page.locator(".rw-fingerprint code").innerText(),
    /SHA256:/,
  );
  assert.equal(
    await page.locator(".rw-fingerprint code").innerText(),
    fixture.fingerprint,
  );
  await page.getByRole("button", { name: "信任并连接" }).click();
  await page.getByText("nginx.conf", { exact: true }).waitFor();
  await page.locator(".rw-terminal-tab").first().waitFor();
  // Opening a file from the workbench hands off to the native right sidebar.
  await page.getByText("nginx.conf", { exact: true }).dblclick();
  const agentPane = page.locator(".rw-agent").first();
  await agentPane.waitFor({ timeout: 15000 });
  await agentPane.getByRole("tab", { name: "nginx.conf" }).waitFor();
  await agentPane.getByRole("textbox", { name: "nginx.conf 内容" }).waitFor();
  assert.equal(
    await page.locator(".rw-workbench .rw-editor").count(),
    0,
    "the workbench must not open files inside its own column",
  );
  await page.screenshot({
    path: "docs/dsh-workbench-handoff-preview.png",
    fullPage: true,
  });
  // The pane's session authorises the host; rw_connect can then reuse stored credentials.
  await agentPane.getByRole("button", { name: /授权当前会话/ }).click();
  await page.getByRole("button", { name: "允许读取", exact: true }).click();
  await agentPane.getByRole("button", { name: "管理当前会话授权" }).waitFor();
  const snapshot = await (await fetch(base + "/snapshot")).json();
  assert.ok(snapshot.sessions.length, "DSH should own a live conversation");
  const sessionId = snapshot.sessions[0].id;
  const toolNames = await (
    await fetch("http://127.0.0.1:4726/api/rw-validation/tools")
  ).json();
  assert.deepEqual(
    [...toolNames].sort(),
    [
      "rw_hosts",
      "rw_list",
      "rw_read",
      "rw_write",
      "rw_exec",
      "rw_tasks",
      "rw_resources",
      "rw_connect",
    ].sort(),
  );
  const invoke = async (name: string, args: unknown) =>
    (
      await fetch("http://127.0.0.1:4726/api/rw-validation/tools", {
        method: "POST",
        body: JSON.stringify({ name, arguments: args, sessionId }),
      })
    ).json();
  const read = await invoke("rw_read", {
    hostId: host.id,
    path: join(fixture.workspace, "nginx.conf"),
  });
  assert.equal(read.ok, true);
  assert.ok(JSON.parse(read.value).content.includes("proxy_pass"));
  const resources = await invoke("rw_resources", { hostId: host.id });
  assert.equal(resources.ok, true, JSON.stringify(resources));
  assert.ok(JSON.parse(resources.value).memory.totalBytes > 0);
  // The Agent can (re)connect through the grant-gated tool; no secret crosses it.
  const connect = await invoke("rw_connect", { hostId: host.id });
  assert.equal(connect.ok, true, JSON.stringify(connect));
  assert.equal(JSON.parse(connect.value).connected, true);
  assert.equal(JSON.parse(connect.value).hostId, host.id);
  const denied = await invoke("rw_exec", {
    hostId: host.id,
    cwd: fixture.workspace,
    command: "printf SHOULD_NOT_RUN",
  });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /授权/);
  // Tool-level Shell execution is granted from the same Agent dialog; the pane
  // still renders no terminal or command bar.
  await agentPane.getByRole("button", { name: "管理当前会话授权" }).click();
  await page.getByRole("checkbox", { name: "Shell 执行" }).click();
  await page.getByRole("button", { name: "更新授权", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const result = await invoke("rw_exec", {
    hostId: host.id,
    cwd: fixture.workspace,
    command: "printf 'DSH_TOOL_BRIDGE_OK\\n'",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(JSON.parse(result.value).stdout, "DSH_TOOL_BRIDGE_OK\n");
  // The right sidebar hands a file to the bound conversation without a
  // duplicate chat surface: one dialog, one copyable prompt.
  await agentPane.getByRole("button", { name: "把当前文件交给 Agent" }).click();
  const handoff = page.getByRole("dialog", { name: "交给当前 Agent" });
  await handoff.waitFor();
  assert.match(
    await handoff.getByLabel("交给 Agent 的内容").inputValue(),
    /nginx\.conf/,
  );
  await handoff.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({
    path: "docs/dsh-agent-rightbar-preview.png",
    fullPage: true,
  });
  // The host palette lives on body[data-ds-dark-theme]; flip it exactly as
  // ThemePresenter does and confirm the Agent pane repaints from the DSH tokens.
  const panelBackground = () =>
    page.evaluate(
      () =>
        getComputedStyle(document.querySelector(".rw-agent")!).backgroundColor,
    );
  const lightBackground = await panelBackground();
  await page.evaluate(() =>
    document.body.setAttribute("data-ds-dark-theme", ""),
  );
  await page.waitForFunction(
    (light) =>
      getComputedStyle(document.querySelector(".rw-workbench")!)
        .backgroundColor !== light,
    lightBackground,
    { timeout: 5000 },
  );
  const darkBackground = await panelBackground();
  assert.notEqual(darkBackground, lightBackground);
  assert.match(darkBackground, /^rgb\(21, 21, 23\)$/);
  await page.screenshot({
    path: "docs/dsh-agent-rightbar-dark-preview.png",
    fullPage: true,
  });
  await page.evaluate(() =>
    document.body.removeAttribute("data-ds-dark-theme"),
  );
  await page.waitForFunction(
    (light) =>
      getComputedStyle(document.querySelector(".rw-agent")!).backgroundColor ===
      light,
    lightBackground,
    { timeout: 5000 },
  );
  // The extension occupies the native right sidebar while the normal Session
  // remains in the center. This is distinct from the standalone page.
  await agentPane.waitFor();
  await agentPane.getByText("nginx.conf", { exact: true }).waitFor();
  assert.equal(
    await page.locator('[contenteditable="true"]').first().isVisible(),
    true,
    "normal DSH composer stays visible beside the right sidebar",
  );
  assert.equal(
    await agentPane
      .locator(
        ".rw-terminal-instance,.rw-terminal-panel,.rw-commandbar,.rw-cmdbar,.rw-cmdlib,.rw-ai",
      )
      .count(),
    0,
    "Agent mode must not render a terminal",
  );
  await page.screenshot({
    path: "docs/dsh-agent-rightbar-preview.png",
    fullPage: true,
  });
  await agentPane
    .getByRole("button", { name: "返回文件列表", exact: true })
    .click();
  await agentPane.getByText("sample.md", { exact: true }).dblclick();
  const markdown = agentPane.getByRole("textbox", {
    name: "sample.md 内容",
    exact: true,
  });
  await markdown.waitFor();
  const nativeMarkdown =
    "# Native DSH verification\n\nUnsaved drafts survive monitoring.\n";
  await markdown.fill(nativeMarkdown);
  await agentPane.getByRole("tab", { name: "监控", exact: true }).click();
  await agentPane.locator(".rw-monitor-facts").first().waitFor();
  for (const name of ["综合", "CPU", "显卡", "内存", "磁盘", "网络"]) {
    assert.equal(
      await agentPane.getByRole("tab", { name, exact: true }).isVisible(),
      true,
    );
  }
  await page.screenshot({
    path: "docs/dsh-agent-monitor-preview.png",
    fullPage: true,
  });
  await agentPane.getByRole("tab", { name: "文件", exact: true }).click();
  assert.ok(
    (await markdown.innerText()).includes("Unsaved drafts survive monitoring."),
  );
  await agentPane.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(
    async ({ base, hostId, path }) => {
      const file = await (
        await fetch(base + "/file?" + new URLSearchParams({ hostId, path }))
      ).json();
      return file.content.includes("Unsaved drafts survive monitoring.");
    },
    { base, hostId: host.id, path: join(fixture.workspace, "sample.md") },
  );

  await agentPane
    .getByRole("button", { name: "返回文件列表", exact: true })
    .click();
  await page.evaluate(() => {
    const scope = globalThis as unknown as Record<string, unknown>;
    scope.__rwTestOriginalPdfWorker = scope.pdfjsWorker;
  });
  await agentPane.getByText("sample.pdf", { exact: true }).dblclick();
  await agentPane.locator(".rw-pdf-canvas").waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      ".rw-agent .rw-pdf-canvas",
    );
    return !!canvas && canvas.width > 0 && canvas.height > 0;
  });
  assert.equal(
    await page.evaluate(() => {
      const scope = globalThis as unknown as Record<string, unknown>;
      return scope.pdfjsWorker === scope.__rwTestOriginalPdfWorker;
    }),
    true,
    "remote PDF worker must not replace the native host PDF worker global",
  );
  await agentPane
    .getByRole("button", { name: "表单字段", exact: true })
    .click();
  const operator = agentPane.getByLabel("Operator", { exact: true });
  await operator.waitFor();
  await operator.fill("Native DSH form");
  await agentPane
    .getByRole("button", { name: "顺时针旋转", exact: true })
    .click();
  await agentPane
    .getByRole("button", { name: "保存 PDF", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !document
        .querySelector(".rw-agent .rw-pdf-footer")
        ?.textContent?.includes("有未保存修改"),
  );
  const savedPdf = await PDFDocument.load(
    await (
      await fetch(
        base +
          "/file/preview?" +
          new URLSearchParams({
            hostId: host.id,
            path: join(fixture.workspace, "sample.pdf"),
          }),
      )
    ).arrayBuffer(),
  );
  assert.equal(
    savedPdf.getForm().getTextField("Operator").getText(),
    "Native DSH form",
  );
  assert.equal(savedPdf.getPage(0).getRotation().angle, 90);
  // A successful write is separate from a finished preview. Wait for the
  // reloaded form, clear error state and actual nonblank pixels before QA.
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLInputElement>(
      ".rw-agent .rw-pdf-forms input",
    );
    const error = document.querySelector(".rw-agent .rw-pdf-error");
    const canvas = document.querySelector<HTMLCanvasElement>(
      ".rw-agent .rw-pdf-canvas",
    );
    if (
      input?.value !== "Native DSH form" ||
      error?.textContent ||
      !canvas?.width ||
      !canvas.height
    )
      return false;
    const pixels = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < pixels.length; i += 128)
      if (
        pixels[i + 3] > 0 &&
        (pixels[i] < 220 || pixels[i + 1] < 220 || pixels[i + 2] < 220)
      )
        return true;
    return false;
  });
  await page.screenshot({
    path: "docs/dsh-agent-pdf-preview.png",
    fullPage: true,
  });
  await page.evaluate(() =>
    document.body.setAttribute("data-ds-dark-theme", ""),
  );
  await page.screenshot({
    path: "docs/dsh-agent-rightbar-dark-preview.png",
    fullPage: true,
  });
  // A dialog is bound to the connection it was opened against. Another window
  // editing that connection must not silently redirect the pending operation.
  await agentPane
    .getByRole("button", { name: "返回文件列表", exact: true })
    .click();
  await agentPane.getByRole("option", { name: /sample\.json/ }).hover();
  await agentPane
    .getByRole("button", { name: "sample.json 更多操作", exact: true })
    .click();
  await page
    .getByRole("menu")
    .getByRole("button", { name: "移动 / 重命名", exact: true })
    .click();
  const moveDialog = agentPane.getByRole("dialog", {
    name: "移动 / 重命名",
    exact: true,
  });
  await moveDialog
    .getByRole("textbox", { name: "名称" })
    .fill("stale-move.json");
  const beforeMove = await readFile(join(fixture.workspace, "sample.json"));
  const { revision: _revision, ...hostInput } = host;
  await post("/hosts/save", { ...hostInput, name: host.name + " · changed" });
  const rejectedMove = page.waitForResponse(
    (response) =>
      response.url() === base + "/files/rename" &&
      response.request().method() === "POST",
  );
  await moveDialog.getByRole("button", { name: "移动", exact: true }).click();
  assert.equal((await rejectedMove).status(), 409);
  assert.deepEqual(
    await readFile(join(fixture.workspace, "sample.json")),
    beforeMove,
  );
  await assert.rejects(readFile(join(fixture.workspace, "stale-move.json")), {
    code: "ENOENT",
  });
  await moveDialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual(errors, []);
  const report = {
    testedAt: new Date().toISOString(),
    dshVersion: (await exec(dsh, ["--version"])).stdout.trim(),
    result: "passed",
    checks: [
      "isolated profile installation",
      "native sidebar and main panel",
      "first-use host-key UI",
      "real SSH and PTY",
      "SFTP editing inside the native right sidebar",
      "session-scoped grant created from the Agent pane",
      "8 registered tools, including read-authorized rw_resources and grant-gated rw_connect",
      "rw_read against real OpenSSH",
      "rw_exec denied before grant",
      "rw_exec succeeds after grant",
      "workbench file opens beside the conversation, not in its own column",
      "Agent handoff dialog carries the open file",
      "dark palette follows the DSH theme attribute",
      "no browser runtime errors",
      "native right sidebar guide opens the remote Agent pane",
      "remote files in the native right sidebar with no terminal UI",
      "all six live monitor views in the native Agent pane",
      "Markdown draft survives monitor switching and saves over SFTP",
      "production PDF worker paints pages without modifying the host global",
      "PDF form and rotation persist from the native sidebar to real SFTP",
      "pending file move rejects a changed connection without touching either path",
    ],
    limitations: [
      "No external LLM request was made; model generation is not covered by this test.",
      "Tool bridge probe invokes registered definitions directly; it does not replace DSH tool-policy tests.",
    ],
  };
  await writeFile(
    "docs/dsh-verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await new Promise<void>((resolveExit) => {
    if (server.exitCode !== null) resolveExit();
    else server.once("exit", () => resolveExit());
  });
  await fixture.close();
}
