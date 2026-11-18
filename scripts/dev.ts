import { createServer } from "node:http";
import { createServer as createVite } from "vite";
import { join, resolve } from "node:path";
import { Store } from "../src/host/store.ts";
import { Engine } from "../src/host/engine.ts";
import { Permissions } from "../src/host/permissions.ts";
import { createRoutes } from "../src/host/routes.ts";
import { API_PREFIX } from "../src/shared/types.ts";

const port = Number(process.env.PORT ?? 4720);
const store = new Store(resolve(".dev/state"));
await store.init();
const engine = new Engine(store);
let fixture: { close(): Promise<void> } | undefined;
if (process.env.RW_FIXTURE === "1") {
  const { startFixture } = await import("../tests/ssh-fixture.ts");
  const server = await startFixture();
  fixture = server;
  let host = store.hosts().find((h) => h.name === "本机集成测试");
  const config = {
    name: "本机集成测试",
    address: "127.0.0.1",
    port: server.port,
    username: server.username,
    group: "开发环境",
    rootPath: server.workspace,
    auth: "key" as const,
    privateKeyPath: server.privateKeyPath,
    favorite: false,
  };
  host = await store.saveHost({ ...config, id: host?.id });
  await store.trust(`[127.0.0.1]:${server.port}`, server.fingerprint);
  await engine.connect(host.id);
}
const routes = createRoutes(engine, new Permissions());
const vite = await createVite({
  server: { middlewareMode: true, hmr: { port: port + 1, host: "127.0.0.1" } },
  appType: "spa",
});
const server = createServer((req, res) => {
  if (req.url?.startsWith(API_PREFIX)) void routes.handler(req, res);
  else vite.middlewares(req, res);
});
server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith(API_PREFIX + "/terminal"))
    routes.upgrade(req, socket, head);
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Remote Workbench → http://127.0.0.1:${port}${fixture ? " (isolated local SSH integration fixture)" : ""}`,
  ),
);
const stop = async () => {
  server.close();
  routes.dispose();
  await engine.dispose();
  await fixture?.close();
  await vite.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
