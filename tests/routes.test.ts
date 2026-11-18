import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/host/store.ts";
import { Engine } from "../src/host/engine.ts";
import { Permissions } from "../src/host/permissions.ts";
import { createRoutes } from "../src/host/routes.ts";

describe("HTTP boundary", () => {
  let directory: string;
  let base: string;
  let token: string;
  let engine: Engine;
  let routes: ReturnType<typeof createRoutes>;
  let server: ReturnType<typeof createServer>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "rw-http-"));
    const store = new Store(directory);
    await store.init();
    engine = new Engine(store);
    routes = createRoutes(engine, new Permissions());
    server = createServer(routes.handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/remote-workbench`;
    token = (await (await fetch(base + "/bootstrap")).json()).csrf;
  });
  afterAll(async () => {
    routes.dispose();
    await engine.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  it("refuses writes without a valid page token", async () => {
    const response = await fetch(base + "/hosts/save", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("CSRF_DENIED");
  });
  it("refuses a cross-origin request even from loopback", async () => {
    const response = await fetch(base + "/bootstrap", {
      headers: { origin: "https://untrusted.example" },
    });
    expect(response.status).toBe(403);
  });
  it("rejects malformed bodies with a useful error", async () => {
    const response = await fetch(base + "/hosts/save", {
      method: "POST",
      headers: { "x-rw-csrf": token },
      body: "{",
    });
    expect((await response.json()).code).toBe("INVALID_JSON");
  });
  it("validates host records and rejects persisted secrets", async () => {
    const response = await fetch(base + "/hosts/save", {
      method: "POST",
      headers: { "x-rw-csrf": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "bad",
        address: "127.0.0.1",
        port: 22,
        username: "test",
        group: "test",
        auth: "password",
        rootPath: "/",
        favorite: false,
        password: "should-not-persist",
      }),
    });
    expect((await response.json()).code).toBe("INVALID_INPUT");
    expect(engine.store.hosts()).toEqual([]);
  });
  it("labels standalone AI use instead of producing a simulated reply", async () => {
    const response = await fetch(base + "/ai/send", {
      method: "POST",
      headers: { "x-rw-csrf": token, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "example",
        text: "hello",
        requestId: crypto.randomUUID(),
      }),
    });
    expect((await response.json()).code).toBe("DSH_REQUIRED");
  });
});
