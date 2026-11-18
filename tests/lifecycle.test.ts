import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { WebServer } from "@deepseek-ai/dsh-host-webserver";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/index.ts";

const prefix = "/api/remote-workbench";
const terminal = prefix + "/terminal";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "rw-lifecycle-"));
  const root = new Context();
  cleanups.push(async () => {
    await root.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await root.plugin(WebServer, { host: "127.0.0.1", port: 0 }).await();
  // These services are unused by the route lifecycle under test. The HTTP
  // server, plugin fiber, persistent store and SSH engine are real instances.
  const parent = root.extend({
    agents: { list: () => [] },
    tools: { register: () => () => {} },
  });
  const load = () =>
    parent.plugin(
      { name: "workbench-lifecycle", apply, inject: ["webServer"] },
      { dataDirectory: directory },
    );
  const bootstrap = () =>
    fetch(root.webServer.getOrigin() + prefix + "/bootstrap");
  return { root, load, bootstrap };
}

describe("DSH plugin lifecycle", () => {
  it("releases HTTP and terminal routes across repeated plugin reloads", async () => {
    const { root, load, bootstrap } = await setup();
    let previousToken: string | undefined;
    for (let i = 0; i < 3; i++) {
      const fiber = load();
      await fiber.await();
      const response = await bootstrap();
      expect(response.status).toBe(200);
      const state = await response.json();
      expect(state.mode).toBe("dsh");
      expect(state.csrf).not.toBe(previousToken);
      previousToken = state.csrf;

      await fiber.dispose();
      expect((await bootstrap()).status).toBe(404);
      const unregister = root.webServer.registerUpgrade({
        path: terminal,
        handler: (_req, socket) => {
          socket.destroy();
        },
      });
      unregister();
    }
  });

  it("cleans up a partial activation without removing another route owner", async () => {
    const { root, load, bootstrap } = await setup();
    const collision = root.webServer.registerUpgrade({
      path: terminal,
      handler: (_req, socket) => {
        socket.destroy();
      },
    });
    const failed = load();
    await expect(failed.await()).rejects.toThrow("duplicate upgrade route");
    expect((await bootstrap()).status).toBe(404);
    expect(() =>
      root.webServer.registerUpgrade({
        path: terminal,
        handler: (_req, socket) => {
          socket.destroy();
        },
      }),
    ).toThrow("duplicate upgrade route");
    await failed.dispose();
    collision();

    const recovered = load();
    await recovered.await();
    expect((await bootstrap()).status).toBe(200);
    await recovered.dispose();
  });
});
