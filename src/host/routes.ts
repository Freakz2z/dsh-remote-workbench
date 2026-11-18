import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";
import { z } from "zod";
import {
  API_PREFIX,
  type AiSession,
  type Grant,
  type HostInput,
  type Snapshot,
} from "../shared/types.ts";
import { Engine } from "./engine.ts";
import { WorkbenchError, errorBody } from "./errors.ts";
import { Permissions } from "./permissions.ts";
import { MAX_PREVIEW_BYTES } from "./file-types.ts";

export interface AiBridge {
  sessions(): AiSession[];
  send(sessionId: string, text: string, requestId: string): Promise<void>;
  messages(sessionId: string): { role: string; text: string; time: number }[];
}
const HostId = z.string().uuid();
const StringPath = z.string().startsWith("/").max(4096);
const Revision = z.number().int().min(1);
const queryRevision = (url: URL) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .parse(url.searchParams.get("hostRevision") ?? undefined);
const resolveDependency = createRequire(import.meta.url);
async function pdfAsset(path: string) {
  try {
    return await readFile(new URL("./pdfjs/" + path, import.meta.url));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Standalone development reads the same version from local dependencies.
    return readFile(
      join(dirname(resolveDependency.resolve("pdfjs-dist/package.json")), path),
    );
  }
}
export const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
};
async function body(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > 8 * 1024 * 1024)
      throw new WorkbenchError(
        "BODY_TOO_LARGE",
        "请求内容过大",
        undefined,
        413,
      );
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new WorkbenchError("INVALID_JSON", "请求数据格式不正确");
  }
}
function isLoopback(address?: string) {
  return (
    address === "::1" ||
    address?.startsWith("127.") ||
    address?.startsWith("::ffff:127.")
  );
}
function admit(req: IncomingMessage) {
  if (!isLoopback(req.socket.remoteAddress))
    throw new WorkbenchError(
      "LOCAL_ONLY",
      "首版工作台仅允许从 DSH 宿主本机访问",
      undefined,
      403,
    );
  const origin = req.headers.origin;
  if (origin && origin !== "dsh-app://app") {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new WorkbenchError(
        "ORIGIN_DENIED",
        "请求来源不受信任",
        undefined,
        403,
      );
    }
    if (
      parsed.host !== req.headers.host ||
      !["http:", "https:"].includes(parsed.protocol)
    )
      throw new WorkbenchError(
        "ORIGIN_DENIED",
        "请求来源不受信任",
        undefined,
        403,
      );
  }
  // Only loopback literal authorities: blocks DNS rebinding against local development.
  const authority = new URL(`http://${req.headers.host ?? ""}`).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(authority))
    throw new WorkbenchError(
      "HOST_DENIED",
      "请使用本机地址访问工作台",
      undefined,
      403,
    );
  if (
    req.headers["sec-fetch-site"] === "cross-site" &&
    origin !== "dsh-app://app"
  )
    throw new WorkbenchError("ORIGIN_DENIED", "跨站请求已阻止", undefined, 403);
}

export function createRoutes(
  engine: Engine,
  permissions: Permissions,
  ai?: AiBridge,
) {
  const csrf = randomBytes(32).toString("base64url");
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const validToken = (candidate: unknown) =>
    typeof candidate === "string" &&
    candidate.length === csrf.length &&
    timingSafeEqual(Buffer.from(candidate), Buffer.from(csrf));
  const snapshot = (): Snapshot => ({
    hosts: engine.store.hosts(),
    connections: engine.connections(),
    tasks: engine.store.taskSummaries(),
    terminals: engine.terminalList(),
    tunnels: engine.tunnelList(),
    grants: permissions.list(),
    sessions: ai?.sessions() ?? [],
    mode: ai ? "dsh" : "standalone",
  });
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      admit(req);
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = url.pathname.slice(API_PREFIX.length);
      const asset = route.match(
        /^\/assets\/pdfjs\/(cmaps|standard_fonts|wasm|iccs)\/([A-Za-z0-9_.-]+)$/,
      );
      if (req.method === "GET" && asset) {
        const data = await pdfAsset(asset[1] + "/" + asset[2]);
        res.writeHead(200, {
          "content-type": asset[2].endsWith(".wasm")
            ? "application/wasm"
            : asset[2].endsWith(".js")
              ? "text/javascript"
              : "application/octet-stream",
          "content-length": data.length,
          "cache-control": "public, max-age=3600",
          "x-content-type-options": "nosniff",
          ...(req.headers.origin === "dsh-app://app"
            ? { "access-control-allow-origin": "dsh-app://app" }
            : {}),
        });
        res.end(data);
        return;
      }
      if (req.method === "GET" && route === "/bootstrap") {
        json(res, { csrf, ...snapshot() });
        return;
      }
      if (req.method === "GET" && route === "/snapshot") {
        json(res, snapshot());
        return;
      }
      if (req.method === "GET" && route === "/task") {
        json(
          res,
          engine.store.taskById(
            z.string().uuid().parse(url.searchParams.get("id")),
          ),
        );
        return;
      }
      if (req.method !== "GET" && req.method !== "POST") {
        json(
          res,
          { code: "METHOD_NOT_ALLOWED", message: "请求方法不支持" },
          405,
        );
        return;
      }
      if (req.method === "POST" && !validToken(req.headers["x-rw-csrf"]))
        throw new WorkbenchError(
          "CSRF_DENIED",
          "页面已过期，请刷新重试",
          undefined,
          403,
        );
      if (req.method === "GET" && route === "/resources") {
        json(
          res,
          await engine.resources(HostId.parse(url.searchParams.get("hostId"))),
        );
        return;
      }
      if (
        req.method === "GET" &&
        ["/commands", "/commands/suggest"].includes(route)
      ) {
        const hostId = HostId.parse(url.searchParams.get("hostId"));
        if (route === "/commands")
          json(
            res,
            engine.store.commandLibrary(
              hostId,
              z
                .string()
                .max(4096)
                .parse(url.searchParams.get("q") ?? ""),
            ),
          );
        else
          json(
            res,
            await engine.commands.suggest(
              hostId,
              z
                .string()
                .max(4096)
                .parse(url.searchParams.get("input") ?? ""),
              StringPath.parse(url.searchParams.get("cwd")),
            ),
          );
        return;
      }
      if (req.method === "GET" && route === "/file/info") {
        json(
          res,
          await engine.fileInfo(
            HostId.parse(url.searchParams.get("hostId")),
            StringPath.parse(url.searchParams.get("path")),
            queryRevision(url),
          ),
        );
        return;
      }
      if (req.method === "GET" && route === "/file/preview") {
        const path = StringPath.parse(url.searchParams.get("path"));
        const preview = await engine.preview(
          HostId.parse(url.searchParams.get("hostId")),
          path,
          queryRevision(url),
        );
        res.writeHead(200, {
          "content-type": preview.mime,
          "content-length": preview.data.length,
          "cache-control": "no-store",
          etag: `"${preview.etag}"`,
          "x-rw-host-revision": String(preview.hostRevision),
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
        });
        res.end(preview.data);
        return;
      }
      if (req.method === "POST" && route === "/file/save-binary") {
        const hostId = HostId.parse(url.searchParams.get("hostId"));
        const path = StringPath.parse(url.searchParams.get("path"));
        const etag = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(url.searchParams.get("etag"));
        const revision = z.coerce
          .number()
          .int()
          .min(1)
          .parse(url.searchParams.get("hostRevision"));
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const data = Buffer.from(chunk);
          size += data.length;
          if (size > MAX_PREVIEW_BYTES)
            throw new WorkbenchError(
              "FILE_TOO_LARGE",
              "PDF 保存上限为 25 MiB",
              undefined,
              413,
            );
          chunks.push(data);
        }
        json(
          res,
          await engine.writePdf(
            hostId,
            path,
            Buffer.concat(chunks),
            etag,
            revision,
          ),
        );
        return;
      }
      if (
        req.method === "GET" &&
        ["/files", "/file", "/download"].includes(route)
      ) {
        const hostId = HostId.parse(url.searchParams.get("hostId"));
        const path = StringPath.parse(url.searchParams.get("path"));
        if (route === "/files") {
          json(res, await engine.list(hostId, path, queryRevision(url)));
          return;
        }
        if (route === "/file") {
          json(res, await engine.read(hostId, path, queryRevision(url)));
          return;
        }
        const downloadRevision = queryRevision(url);
        if (
          downloadRevision !== undefined &&
          engine.store.host(hostId).revision !== downloadRevision
        )
          throw new WorkbenchError(
            "CONNECTION_CHANGED",
            "连接设置已变化，请重新选择文件",
            undefined,
            409,
          );
        const sftp = await engine.sftp(hostId);
        const stat = await new Promise<import("ssh2").Stats>(
          (resolve, reject) =>
            sftp.stat(path, (error, value) =>
              error ? reject(error) : resolve(value),
            ),
        );
        if (!stat.isFile())
          throw new WorkbenchError("NOT_A_FILE", "请选择普通文件下载");
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": stat.size,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        await engine.download(hostId, path, res, downloadRevision);
        return;
      }
      if (req.method === "POST" && route === "/upload") {
        const hostId = HostId.parse(url.searchParams.get("hostId"));
        const path = StringPath.parse(url.searchParams.get("path"));
        const total = Number(req.headers["content-length"] ?? 0);
        json(
          res,
          await engine.upload(hostId, path, req, total, queryRevision(url)),
        );
        return;
      }
      if (req.method === "GET" && route === "/ai/messages") {
        const sessionId = z
          .string()
          .min(1)
          .parse(url.searchParams.get("sessionId"));
        json(res, { messages: ai?.messages(sessionId) ?? [] });
        return;
      }
      if (req.method !== "POST")
        throw new WorkbenchError("NOT_FOUND", "接口不存在", undefined, 404);
      const value = await body(req);
      if (route === "/commands/remember") {
        const v = z
          .object({
            hostId: HostId,
            command: z.string().max(4096),
            cwd: StringPath,
          })
          .parse(value);
        json(
          res,
          await engine.store.rememberCommand(v.hostId, v.command, v.cwd),
        );
        return;
      }
      if (route === "/commands/preferences") {
        const v = z
          .object({ hostId: HostId, remember: z.boolean() })
          .parse(value);
        await engine.store.commandPreference(v.hostId, v.remember);
        json(res, { ok: true });
        return;
      }
      if (["/commands/clear", "/commands/delete"].includes(route)) {
        const v = z
          .object({ hostId: HostId, id: z.string().uuid().optional() })
          .parse(value);
        if (route === "/commands/delete" && !v.id)
          throw new WorkbenchError("ID_REQUIRED", "请选择要删除的命令记录");
        await engine.store.clearCommands(
          v.hostId,
          route === "/commands/clear" ? undefined : v.id,
        );
        json(res, { ok: true });
        return;
      }
      if (route === "/commands/snippets/save") {
        const v = z
          .object({
            id: z.string().uuid().optional(),
            hostId: HostId.optional(),
            name: z.string().trim().min(1).max(80),
            command: z.string().min(1).max(4096),
            group: z.string().max(50).optional(),
          })
          .parse(value);
        json(res, await engine.store.saveSnippet(v));
        return;
      }
      if (route === "/commands/snippets/delete") {
        const v = z.object({ id: z.string().uuid() }).parse(value);
        await engine.store.deleteSnippet(v.id);
        json(res, { ok: true });
        return;
      }
      if (["/files/create", "/files/copy", "/files/chmod"].includes(route)) {
        const v = z
          .object({
            hostId: HostId,
            path: StringPath,
            hostRevision: z.number().int().min(1),
            content: z.string().optional(),
            target: StringPath.optional(),
            mode: z
              .string()
              .regex(/^[0-7]{3,4}$/)
              .optional(),
          })
          .parse(value);
        if (route === "/files/create") {
          json(
            res,
            await engine.createFile(
              v.hostId,
              v.path,
              v.content ?? "",
              v.hostRevision,
            ),
          );
          return;
        }
        if (route === "/files/copy")
          await engine.copy(
            v.hostId,
            v.path,
            StringPath.parse(v.target),
            v.hostRevision,
          );
        if (route === "/files/chmod")
          await engine.chmod(
            v.hostId,
            v.path,
            z.string().parse(v.mode),
            v.hostRevision,
          );
        json(res, { ok: true });
        return;
      }
      if (route === "/hosts/save") {
        const host = await engine.store.saveHost(value as HostInput);
        engine.disconnect(host.id, true);
        permissions.revokeHost(host.id);
        json(res, host);
        return;
      }
      if (route === "/ssh/import") {
        // Preview a deliberately bounded subset; executable directives are never evaluated.
        const config = await readFile(homedir() + "/.ssh/config", "utf8").catch(
          (error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
            throw error;
          },
        );
        const rows: Partial<HostInput>[] = [];
        const skipped: string[] = [];
        let current: Record<string, string> | undefined;
        for (const raw of config.split("\n")) {
          const line = raw.trim();
          if (!line || line.startsWith("#")) continue;
          const [key, ...parts] = line.split(/[\s=]+/);
          const text = parts.join(" ").replace(/^"|"$/g, "");
          if (key.toLowerCase() === "host") {
            current = undefined;
            if (/[!*?]/.test(text) || parts.length !== 1) {
              skipped.push(line);
              continue;
            }
            current = { alias: text };
            rows.push(current as Partial<HostInput>);
          } else if (current) current[key.toLowerCase()] = text;
        }
        const hosts = (rows as Record<string, string>[]).map((r) => ({
          name: r.alias,
          address: r.hostname ?? r.alias,
          port: Number(r.port ?? 22),
          username: r.user ?? process.env.USER ?? "",
          group: "SSH 导入",
          rootPath: "/",
          auth: r.identityfile ? "key" : "agent",
          privateKeyPath: r.identityfile,
          favorite: false,
          note:
            r.proxyjump || r.proxycommand
              ? "含跳板配置，请在保存后手动配置跳板机"
              : undefined,
        }));
        json(res, { hosts, skipped });
        return;
      }
      if (route === "/hosts/delete") {
        const { hostId } = z.object({ hostId: HostId }).parse(value);
        engine.disconnect(hostId, true);
        await engine.forgetCredentials(hostId);
        await engine.store.deleteHost(hostId);
        permissions.revokeHost(hostId);
        json(res, { ok: true });
        return;
      }
      if (route === "/connect") {
        const { hostId, credentials } = z
          .object({
            hostId: HostId,
            credentials: z
              .object({
                password: z.string().max(4096).optional(),
                passphrase: z.string().max(4096).optional(),
              })
              .optional(),
          })
          .parse(value);
        if (credentials) await engine.setCredentials(hostId, credentials);
        await engine.connect(hostId);
        json(res, { ok: true });
        return;
      }
      if (route === "/credentials") {
        const { hostId, credentials } = z
          .object({
            hostId: HostId,
            credentials: z.object({
              password: z.string().max(4096).optional(),
              passphrase: z.string().max(4096).optional(),
            }),
          })
          .parse(value);
        await engine.setCredentials(hostId, credentials);
        json(res, { ok: true });
        return;
      }
      if (route === "/trust") {
        const { hostId, fingerprint } = z
          .object({ hostId: HostId, fingerprint: z.string().min(1) })
          .parse(value);
        await engine.trust(hostId, fingerprint);
        json(res, { ok: true });
        return;
      }
      if (route === "/credentials/forget") {
        const { hostId } = z.object({ hostId: HostId }).parse(value);
        await engine.forgetCredentials(hostId);
        json(res, { ok: true });
        return;
      }
      if (route === "/disconnect") {
        const { hostId } = z.object({ hostId: HostId }).parse(value);
        engine.disconnect(hostId, true);
        json(res, { ok: true });
        return;
      }
      if (route === "/file/save") {
        const v = z
          .object({
            hostId: HostId,
            path: StringPath,
            content: z.string(),
            etag: z.string().length(64),
            hostRevision: z.number().int(),
          })
          .parse(value);
        json(
          res,
          await engine.write(
            v.hostId,
            v.path,
            v.content,
            v.etag,
            v.hostRevision,
          ),
        );
        return;
      }
      if (["/files/mkdir", "/files/remove", "/files/rename"].includes(route)) {
        const v = z
          .object({
            hostId: HostId,
            path: StringPath,
            target: StringPath.optional(),
            hostRevision: Revision.optional(),
          })
          .parse(value);
        if (route === "/files/mkdir")
          await engine.mkdir(v.hostId, v.path, v.hostRevision);
        if (route === "/files/remove")
          await engine.remove(v.hostId, v.path, v.hostRevision);
        if (route === "/files/rename")
          await engine.rename(
            v.hostId,
            v.path,
            StringPath.parse(v.target),
            v.hostRevision,
          );
        json(res, { ok: true });
        return;
      }
      if (route === "/exec") {
        const v = z
          .object({
            hostId: HostId,
            command: z.string(),
            cwd: StringPath,
            timeoutMs: z.number().optional(),
          })
          .parse(value);
        json(res, await engine.exec(v.hostId, v.command, v.cwd, v.timeoutMs));
        return;
      }
      if (route === "/terminals/create") {
        const v = z.object({ hostId: HostId, cwd: StringPath }).parse(value);
        json(res, await engine.terminal(v.hostId, v.cwd));
        return;
      }
      if (route === "/terminals/close") {
        const v = z.object({ id: z.string().uuid() }).parse(value);
        engine.forgetTerminal(v.id);
        json(res, { ok: true });
        return;
      }
      if (route === "/tasks/cancel") {
        const v = z.object({ id: z.string().uuid() }).parse(value);
        engine.tasks.cancel(v.id);
        json(res, { ok: true });
        return;
      }
      if (route === "/tunnels/create") {
        const v = z
          .object({
            hostId: HostId,
            localPort: z.number().int().min(1024).max(65535),
            targetHost: z
              .string()
              .min(1)
              .max(255)
              .regex(/^[a-zA-Z0-9.:_\-]+$/),
            targetPort: z.number().int().min(1).max(65535),
          })
          .parse(value);
        json(
          res,
          await engine.openTunnel(
            v.hostId,
            v.localPort,
            v.targetHost,
            v.targetPort,
          ),
        );
        return;
      }
      if (route === "/tunnels/close") {
        const v = z.object({ id: z.string().uuid() }).parse(value);
        engine.closeTunnel(v.id);
        json(res, { ok: true });
        return;
      }
      if (route === "/ai/grant") {
        const grant = z
          .object({
            sessionId: z.string().min(1),
            hostId: HostId,
            rootPath: StringPath,
            read: z.boolean(),
            write: z.boolean(),
            exec: z.boolean(),
          })
          .parse(value);
        if (!ai?.sessions().some((s) => s.id === grant.sessionId))
          throw new WorkbenchError(
            "SESSION_NOT_LIVE",
            "请先在 DSH 打开目标会话",
          );
        json(res, await permissions.set(engine, grant));
        return;
      }
      if (route === "/ai/revoke") {
        const v = z
          .object({ sessionId: z.string(), hostId: HostId })
          .parse(value);
        permissions.revoke(v.sessionId, v.hostId);
        json(res, { ok: true });
        return;
      }
      if (route === "/ai/send") {
        const v = z
          .object({
            sessionId: z.string().min(1),
            text: z.string().trim().min(1).max(40000),
            requestId: z.string().uuid(),
          })
          .parse(value);
        if (!ai)
          throw new WorkbenchError(
            "DSH_REQUIRED",
            "AI 协作需要在 DSH 中打开此插件；当前是独立预览",
          );
        await ai.send(v.sessionId, v.text, v.requestId);
        json(res, { ok: true });
        return;
      }
      throw new WorkbenchError("NOT_FOUND", "接口不存在", undefined, 404);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(
        res,
        error instanceof z.ZodError
          ? {
              code: "INVALID_INPUT",
              message: error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("；"),
            }
          : errorBody(error),
        error instanceof WorkbenchError ? error.status : 400,
      );
    }
  };
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      admit(req);
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!validToken(url.searchParams.get("token")))
        throw new WorkbenchError("CSRF_DENIED", "连接令牌无效");
      const id = z.string().uuid().parse(url.searchParams.get("id"));
      if (!engine.terminalList().some((t) => t.id === id))
        throw new WorkbenchError("TERMINAL_NOT_FOUND", "终端不存在");
      wss.handleUpgrade(req, socket, head, (ws) => {
        const attachment = engine.attachTerminal(
          id,
          randomUUID(),
          (message) => {
            if (ws.readyState === ws.OPEN) {
              if (ws.bufferedAmount > 1024 * 1024) {
                ws.close(1013, "终端输出积压，请重新连接");
                return;
              }
              ws.send(JSON.stringify(message));
            }
          },
        );
        ws.on("message", (data) => {
          try {
            const v = JSON.parse(data.toString());
            if (v.type === "input" && typeof v.data === "string")
              attachment.write(v.data.slice(0, 65536));
            if (
              v.type === "resize" &&
              Number.isInteger(v.cols) &&
              Number.isInteger(v.rows)
            )
              attachment.resize(
                Math.max(2, Math.min(v.cols, 500)),
                Math.max(2, Math.min(v.rows, 200)),
              );
            if (v.type === "takeover") attachment.takeover();
          } catch {
            ws.close(1008, "消息格式不正确");
          }
        });
        ws.once("close", attachment.detach);
        ws.on("error", () => {});
      });
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  };
  return {
    handler,
    upgrade,
    snapshot,
    dispose: () => {
      for (const ws of wss.clients) ws.close(1001, "插件已关闭");
      wss.close();
    },
  };
}
