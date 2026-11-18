import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Store } from "../src/host/store.ts";
import { Engine } from "../src/host/engine.ts";
import { Permissions } from "../src/host/permissions.ts";
import { startFixture } from "./ssh-fixture.ts";
import { join } from "node:path";
import { writeFile, readFile, symlink, stat } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { createServer, get } from "node:http";

describe("real OpenSSH / SFTP integration", () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  let store: Store;
  let engine: Engine;
  let id: string;
  beforeAll(async () => {
    fixture = await startFixture();
    store = new Store(join(fixture.root, "state"));
    await store.init();
    engine = new Engine(store);
    const host = await store.saveHost({
      name: "OpenSSH 测试",
      address: "127.0.0.1",
      port: fixture.port,
      username: fixture.username,
      rootPath: fixture.workspace,
      group: "测试",
      auth: "key",
      privateKeyPath: fixture.privateKeyPath,
      favorite: false,
    });
    id = host.id;
  }, 20000);
  afterAll(async () => {
    await engine?.dispose();
    await fixture?.close();
  });
  it("requires first-use fingerprint trust, then connects to the same server", async () => {
    await expect(engine.connect(id)).rejects.toMatchObject({
      code: "HOST_KEY_UNKNOWN",
      details: { fingerprint: fixture.fingerprint },
    });
    await engine.trust(id, fixture.fingerprint);
    await engine.connect(id);
    expect(engine.connections()[0].status).toBe("connected");
    expect(
      (await engine.list(id, fixture.workspace)).entries.some(
        (e) => e.name === "nginx.conf",
      ),
    ).toBe(true);
  });
  it("executes exactly once and preserves stdout, stderr and exit status", async () => {
    const result = await engine.exec(
      id,
      "printf '你好'; printf 'warning' >&2; exit 7",
      fixture.workspace,
    );
    expect(result).toMatchObject({
      stdout: "你好",
      stderr: "warning",
      exitCode: 7,
    });
    expect(store.tasks().find((t) => t.id === result.taskId)?.status).toBe(
      "failed",
    );
  });
  it("saves with an etag and rejects a concurrent remote change", async () => {
    const path = join(fixture.workspace, "nginx.conf");
    const original = await engine.read(id, path);
    const saved = await engine.write(
      id,
      path,
      original.content.replace("8080", "8081"),
      original.etag,
    );
    expect(saved.content).toContain("8081");
    await writeFile(path, saved.content + "# external change\n");
    await expect(
      engine.write(id, path, "overwrite", saved.etag),
    ).rejects.toMatchObject({ code: "FILE_CONFLICT" });
    expect(await readFile(path, "utf8")).toContain("# external change");
  });
  it("streams a binary upload and download without changing bytes", async () => {
    const data = Buffer.alloc(5 * 1024 * 1024 + 17);
    for (let n = 0; n < data.length; n++) data[n] = n % 251;
    const path = join(fixture.workspace, "binary.dat");
    await engine.upload(id, path, Readable.from(data), data.length);
    const chunks: Buffer[] = [];
    await engine.download(
      id,
      path,
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      }),
    );
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
    await expect(
      engine.upload(id, path, Readable.from("bad"), 3),
    ).rejects.toMatchObject({ code: "TARGET_EXISTS" });
    expect((await stat(path)).size).toBe(data.length);
  });
  it("rejects truncated uploads and leaves no final file", async () => {
    const path = join(fixture.workspace, "partial.dat");
    await expect(
      engine.upload(id, path, Readable.from("short"), 100),
    ).rejects.toMatchObject({ code: "TRANSFER_INCOMPLETE" });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("enforces AI grants after symlink resolution and keeps shell permission separate", async () => {
    const permissions = new Permissions();
    await permissions.set(engine, {
      sessionId: "session-one",
      hostId: id,
      rootPath: fixture.workspace,
      read: true,
      write: false,
      exec: false,
    });
    await expect(
      permissions.check(engine, "other-session", id, "read", fixture.workspace),
    ).rejects.toMatchObject({ code: "AI_PERMISSION_REQUIRED" });
    await expect(
      permissions.check(engine, "session-one", id, "exec", fixture.workspace),
    ).rejects.toMatchObject({ code: "AI_PERMISSION_REQUIRED" });
    const outside = join(fixture.root, "outside.txt");
    await writeFile(outside, "outside");
    await symlink(outside, join(fixture.workspace, "escape-link"));
    await expect(
      permissions.check(
        engine,
        "session-one",
        id,
        "read",
        join(fixture.workspace, "escape-link"),
      ),
    ).rejects.toMatchObject({ code: "AI_PATH_DENIED" });
  });
  it("retains a PTY when a viewer detaches and replays its output", async () => {
    const terminal = await engine.terminal(id, fixture.workspace);
    let output = "";
    const first = engine.attachTerminal(terminal.id, "first", (m) => {
      const v = m as { type: string; data?: string };
      if (v.type === "output") output += v.data;
    });
    first.write("printf 'RW_PTY_READY\\n'\r");
    await expect
      .poll(() => output, { timeout: 5000 })
      .toContain("RW_PTY_READY");
    first.detach();
    let replay = "";
    const second = engine.attachTerminal(terminal.id, "second", (m) => {
      const v = m as { type: string; data?: string };
      if (v.type === "replay") replay = v.data ?? "";
    });
    expect(replay).toContain("RW_PTY_READY");
    second.detach();
    engine.closeTerminal(terminal.id);
  });
  it("forwards a loopback port through the SSH connection", async () => {
    const target = createServer((_req, res) => res.end("tunnel-ok"));
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const port = (target.address() as { port: number }).port;
    const tunnel = await engine.openTunnel(id, 0, "127.0.0.1", port);
    try {
      const text = await new Promise<string>((resolve, reject) =>
        get(`http://127.0.0.1:${tunnel.localPort}`, (res) => {
          let result = "";
          res.on("data", (b) => (result += b));
          res.on("end", () => resolve(result));
        }).on("error", reject),
      );
      expect(text).toBe("tunnel-ok");
    } finally {
      engine.closeTunnel(tunnel.id);
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
  it("persists host configuration without any authentication secrets", async () => {
    engine.setCredentials(id, {
      password: "private-canary-password",
      passphrase: "private-canary-passphrase",
    });
    await store.persist();
    const persisted = await readFile(
      join(store.directory, "state.json"),
      "utf8",
    );
    expect(persisted).not.toContain("private-canary");
    expect((await stat(join(store.directory, "state.json"))).mode & 0o777).toBe(
      0o600,
    );
  });
  it("rejects editor saves after the connection identity changes", async () => {
    const path = join(fixture.workspace, "README.md");
    const file = await engine.read(id, path);
    const { revision: _revision, ...input } = store.host(id);
    await store.saveHost(input);
    await expect(
      engine.write(id, path, "wrong identity", file.etag, file.hostRevision),
    ).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    expect(await readFile(path, "utf8")).toBe(file.content);
  });
  it("never replays a command whose connection drops after execution starts", async () => {
    const path = join(fixture.workspace, "once.txt");
    const pending = engine
      .exec(id, "printf x >> once.txt; sleep 3", fixture.workspace)
      .catch(() => undefined);
    await expect
      .poll(async () => readFile(path, "utf8").catch(() => ""), {
        timeout: 3000,
      })
      .toBe("x");
    engine.disconnect(id);
    await pending;
    expect(
      store.tasks().find((t) => t.label.includes("once.txt"))?.status,
    ).toBe("unknown");
    expect((await engine.read(id, path)).content).toBe("x");
  });
  it("uses separate credentials through a jump host", async () => {
    const target = await startFixture();
    let targetId: string | undefined;
    try {
      const host = await store.saveHost({
        name: "跳板后目标",
        address: "127.0.0.1",
        port: target.port,
        username: target.username,
        rootPath: target.workspace,
        group: "测试",
        auth: "key",
        privateKeyPath: target.privateKeyPath,
        jumpHostId: id,
        favorite: false,
      });
      targetId = host.id;
      await store.trust(`[127.0.0.1]:${target.port}`, target.fingerprint);
      const result = await engine.exec(
        host.id,
        "printf JUMP_OK",
        target.workspace,
      );
      expect(result.stdout).toBe("JUMP_OK");
      expect(
        (await engine.list(host.id, target.workspace)).entries.some(
          (e) => e.name === "nginx.conf",
        ),
      ).toBe(true);
    } finally {
      if (targetId) {
        engine.disconnect(targetId);
        await store.deleteHost(targetId);
      }
      await target.close();
    }
  });
  it("blocks a changed host key instead of trusting it silently", async () => {
    engine.disconnect(id);
    await store.trust(`[127.0.0.1]:${fixture.port}`, "SHA256:unexpected");
    await expect(engine.connect(id)).rejects.toMatchObject({
      code: "HOST_KEY_CHANGED",
    });
    await store.trust(`[127.0.0.1]:${fixture.port}`, fixture.fingerprint);
  });
});
