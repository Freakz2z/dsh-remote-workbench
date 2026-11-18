import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Engine } from "../src/host/engine.ts";
import { Store } from "../src/host/store.ts";
import { startFixture } from "./ssh-fixture.ts";
import { join } from "node:path";
import { readFile, writeFile, stat, symlink, truncate } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { createServer, type Server } from "node:http";
import { createRoutes } from "../src/host/routes.ts";
import { Permissions } from "../src/host/permissions.ts";
import { registerTools } from "../src/host/tools.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { Readable } from "node:stream";

describe("workstation against real OpenSSH", () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  let store: Store;
  let engine: Engine;
  let hostId: string;
  let revision: number;
  let server: Server;
  let routes: ReturnType<typeof createRoutes>;
  let base: string;
  let csrf: string;
  beforeAll(async () => {
    fixture = await startFixture();
    store = new Store(join(fixture.root, "workstation-state"));
    await store.init();
    const host = await store.saveHost({
      name: "Workstation",
      address: "127.0.0.1",
      port: fixture.port,
      username: fixture.username,
      rootPath: fixture.workspace,
      group: "test",
      auth: "key",
      privateKeyPath: fixture.privateKeyPath,
      favorite: false,
    });
    hostId = host.id;
    revision = host.revision;
    await store.trust(`[127.0.0.1]:${fixture.port}`, fixture.fingerprint);
    engine = new Engine(store);
    await engine.connect(hostId);
    routes = createRoutes(engine, new Permissions());
    server = createServer(routes.handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/remote-workbench`;
    csrf = (await (await fetch(base + "/bootstrap")).json()).csrf;
  }, 20000);
  afterAll(async () => {
    routes?.dispose();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await engine?.dispose();
    await fixture?.close();
  });

  it("samples the server without injecting PTY input or persisting telemetry tasks", async () => {
    const before = store.tasks().length;
    const metrics = await engine.resources(hostId);
    expect(metrics.sample.platform).toBe(
      process.platform === "darwin" ? "darwin" : "linux",
    );
    expect(metrics.sample.memory!.totalBytes).toBeGreaterThan(0);
    expect(metrics.sample.cpu.logicalCores).toBeGreaterThan(0);
    expect(metrics.sample.filesystems.length).toBeGreaterThan(0);
    expect(metrics.sample.hostname).not.toBe("");
    expect(store.tasks().length).toBe(before);
    expect(metrics.history).toHaveLength(1);
  });
  it("classifies remote documents and rejects invalid UTF-8 without corrupting files", async () => {
    for (const [name, kind] of [
      ["sample.pdf", "pdf"],
      ["sample.md", "markdown"],
      ["sample.json", "code"],
      ["sample.png", "image"],
    ]) {
      expect(
        (await engine.fileInfo(hostId, join(fixture.workspace, name))).kind,
      ).toBe(kind);
    }
    const invalid = join(fixture.workspace, "invalid.txt");
    await writeFile(invalid, Buffer.from([255, 254, 253]));
    expect((await engine.fileInfo(hostId, invalid)).kind).toBe("binary");
    await expect(engine.read(hostId, invalid)).rejects.toMatchObject({
      code: "ENCODING_UNSUPPORTED",
    });
    const html = join(fixture.workspace, "untrusted.html");
    await writeFile(html, "<script>window.__UNSAFE = true</script>");
    expect((await engine.preview(hostId, html)).mime).toBe(
      "text/plain; charset=utf-8",
    );
  });
  it("creates, copies and changes file permissions without overwriting existing paths", async () => {
    const empty = join(fixture.workspace, "empty.txt");
    await engine.createFile(hostId, empty, "", revision);
    expect(await engine.fileInfo(hostId, empty)).toMatchObject({
      kind: "text",
      size: 0,
      editable: true,
    });
    const path = join(fixture.workspace, "new.txt");
    await engine.createFile(hostId, path, "New document", revision);
    await expect(
      engine.createFile(hostId, path, "Must not replace", revision),
    ).rejects.toMatchObject({ code: "TARGET_EXISTS" });
    const copy = join(fixture.workspace, "copied.txt");
    await engine.copy(hostId, path, copy, revision);
    expect(await readFile(copy, "utf8")).toBe("New document");
    await engine.chmod(hostId, copy, "640", revision);
    expect((await stat(copy)).mode & 0o777).toBe(0o640);
    await expect(
      engine.copy(hostId, path, copy, revision),
    ).rejects.toMatchObject({ code: "TARGET_EXISTS" });
    await symlink(path, join(fixture.workspace, "copy-link"));
    await expect(
      engine.copy(hostId, join(fixture.workspace, "copy-link"), copy, revision),
    ).rejects.toMatchObject({ code: "COPY_FILE_ONLY" });
  });
  it("saves PDF edits atomically and detects external changes and connection revisions", async () => {
    const path = join(fixture.workspace, "sample.pdf");
    await engine.chmod(hostId, path, "640", revision);
    const original = await engine.preview(hostId, path);
    const pdf = await PDFDocument.load(original.data);
    pdf.addPage([300, 300]);
    const updated = Buffer.from(await pdf.save());
    const saved = await engine.writePdf(
      hostId,
      path,
      updated,
      original.etag,
      revision,
    );
    expect(saved.etag).not.toBe(original.etag);
    expect((await PDFDocument.load(await readFile(path))).getPageCount()).toBe(
      3,
    );
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    await expect(
      engine.writePdf(hostId, path, original.data, original.etag, revision),
    ).rejects.toMatchObject({ code: "FILE_CONFLICT" });
    await expect(
      engine.writePdf(hostId, path, updated, saved.etag, revision + 1),
    ).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    await expect(
      engine.writePdf(
        hostId,
        path,
        Buffer.from("not pdf"),
        saved.etag,
        revision,
      ),
    ).rejects.toMatchObject({ code: "INVALID_PDF" });
  });
  it("declines oversized previews while keeping the download option", async () => {
    const path = join(fixture.workspace, "large.pdf");
    await writeFile(path, "%PDF-1.7\n");
    await truncate(path, 26 * 1024 * 1024);
    expect(await engine.fileInfo(hostId, path)).toMatchObject({
      kind: "pdf",
      previewable: false,
      editable: false,
    });
    await expect(engine.preview(hostId, path)).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });
  it("remembers explicit commands per host, deduplicates and excludes credentials", async () => {
    await store.rememberCommand(hostId, "ls -lah", fixture.workspace);
    await store.rememberCommand(hostId, "ls -lah", fixture.workspace);
    expect(store.commandLibrary(hostId).history[0].uses).toBe(2);
    for (const command of [
      "export API_TOKEN=do-not-store",
      "curl -H 'Authorization: Bearer sensitive' example.com",
      " echo private",
      "printf 'one'\nprintf 'two'",
    ]) {
      expect(
        (await store.rememberCommand(hostId, command, fixture.workspace))
          .remembered,
      ).toBe(false);
    }
    const snippet = await store.saveSnippet({
      name: "System",
      command: "uname -a",
    });
    expect(store.commandLibrary(hostId).snippets[0].id).toBe(snippet.id);
    const suggestions = await engine.commands.suggest(
      hostId,
      "ls",
      fixture.workspace,
    );
    expect(
      suggestions.items.some(
        (i) => i.kind === "history" && i.value === "ls -lah",
      ),
    ).toBe(true);
    const paths = await engine.commands.suggest(
      hostId,
      "cat sample.",
      fixture.workspace,
    );
    expect(
      paths.items.some(
        (i) => i.kind === "path" && i.value.includes("sample.md"),
      ),
    ).toBe(true);
    const reloaded = new Store(store.directory);
    await reloaded.init();
    expect(reloaded.commandLibrary(hostId).history).toHaveLength(1);
    expect(
      await readFile(join(store.directory, "state.json"), "utf8"),
    ).not.toContain("do-not-store");
    await store.commandPreference(hostId, false);
    expect(
      (await store.rememberCommand(hostId, "pwd", fixture.workspace))
        .remembered,
    ).toBe(false);
    await store.clearCommands(hostId);
    expect(store.commandLibrary(hostId).history).toEqual([]);
    await store.deleteSnippet(snippet.id);
    expect(store.commandLibrary(hostId).snippets).toEqual([]);
  });
  it("serves typed previews and protects PDF, file and history writes at the HTTP boundary", async () => {
    const font = await fetch(
      base + "/assets/pdfjs/standard_fonts/LiberationSans-Regular.ttf",
      { headers: { origin: "dsh-app://app" } },
    );
    expect(font.status).toBe(200);
    expect(font.headers.get("access-control-allow-origin")).toBe(
      "dsh-app://app",
    );
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    const path = join(fixture.workspace, "sample.pdf");
    const query = new URLSearchParams({ hostId, path });
    const response = await fetch(base + "/file/preview?" + query);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-rw-host-revision")).toBe(String(revision));
    const data = Buffer.from(await response.arrayBuffer());
    const etag = response.headers.get("etag")!.replaceAll('"', "");
    const saveQuery = new URLSearchParams({
      hostId,
      path,
      etag,
      hostRevision: String(revision),
    });
    const blocked = await fetch(base + "/file/save-binary?" + saveQuery, {
      method: "POST",
      body: data,
    });
    expect(blocked.status).toBe(403);
    const saved = await fetch(base + "/file/save-binary?" + saveQuery, {
      method: "POST",
      headers: { "x-rw-csrf": csrf },
      body: data,
    });
    expect(saved.status).toBe(200);
    const wrongOrigin = await fetch(
      base + "/resources?" + new URLSearchParams({ hostId }),
      { headers: { origin: "https://untrusted.example" } },
    );
    expect(wrongOrigin.status).toBe(403);
    for (const endpoint of [
      "/commands/remember",
      "/commands/clear",
      "/commands/snippets/save",
      "/files/create",
      "/files/copy",
      "/files/chmod",
    ]) {
      expect(
        (await fetch(base + endpoint, { method: "POST", body: "{}" })).status,
      ).toBe(403);
    }
    const info = await (
      await fetch(
        base +
          "/file/info?" +
          new URLSearchParams({
            hostId,
            path: join(fixture.workspace, "sample.md"),
          }),
      )
    ).json();
    expect(info).toMatchObject({
      kind: "markdown",
      editable: true,
      hostRevision: revision,
    });
  });
  it("lets an Agent read metrics only for the current read-authorized connection", async () => {
    const permissions = new Permissions();
    const definitions = new Map<string, ToolDefinition>();
    registerTools(
      {
        tools: {
          register: (definition: ToolDefinition) => {
            definitions.set(definition.name, definition);
            return () => {};
          },
        },
      } as unknown as Context,
      engine,
      permissions,
    );
    const tool = definitions.get("rw_resources")!;
    const exec = {
      agent: { id: "resource-session" },
      signal: new AbortController().signal,
    } as Parameters<typeof tool.execute>[1];
    await expect(tool.execute({ hostId }, exec)).rejects.toMatchObject({
      code: "AI_PERMISSION_REQUIRED",
    });
    await permissions.set(engine, {
      sessionId: "resource-session",
      hostId,
      rootPath: fixture.workspace,
      read: true,
      write: false,
      exec: false,
    });
    const result = JSON.parse((await tool.execute({ hostId }, exec)) as string);
    expect(result.memory.totalBytes).toBeGreaterThan(0);
    expect(permissions.visible("resource-session")[0].exec).toBe(false);
    expect(permissions.visible("resource-session")[0].write).toBe(false);
  });
  it("rejects stale file operations instead of silently accepting a replacement connection", async () => {
    const { revision: oldRevision, ...input } = store.host(hostId);
    await store.saveHost({ ...input, name: "Changed connection" });
    engine.disconnect(hostId);
    const path = join(fixture.workspace, "new.txt");
    const target = join(fixture.workspace, "must-not-create.txt");
    await expect(
      engine.rename(hostId, path, target, oldRevision),
    ).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    await expect(
      engine.remove(hostId, path, oldRevision),
    ).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    await expect(
      engine.mkdir(hostId, target, oldRevision),
    ).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    await expect(
      engine.copy(hostId, path, target, oldRevision),
    ).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    await expect(
      engine.fileInfo(hostId, path, oldRevision),
    ).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    const source = Readable.from("must not upload");
    try {
      await expect(
        engine.upload(hostId, target, source, 15, oldRevision),
      ).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    } finally {
      source.destroy();
    }
    const query = new URLSearchParams({
      hostId,
      path,
      hostRevision: String(oldRevision),
    });
    expect((await fetch(base + "/file/info?" + query)).status).toBe(409);
    const request = await fetch(base + "/files/rename", {
      method: "POST",
      headers: { "x-rw-csrf": csrf, "content-type": "application/json" },
      body: JSON.stringify({ hostId, path, target, hostRevision: oldRevision }),
    });
    expect(request.status).toBe(409);
    expect(await readFile(path, "utf8")).toBe("New document");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(engine.connections()[0].status).toBe("disconnected");
  });
});
