import ssh2 from "ssh2";
import type { Client as SshClient, ClientChannel, SFTPWrapper } from "ssh2";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable, type Writable } from "node:stream";
import { createServer, type Server, type Socket } from "node:net";
import type {
  ConnectionState,
  Credentials,
  FileEntry,
  Host,
  RemoteFile,
  TerminalInfo,
  Tunnel,
} from "../shared/types.ts";
import { absolutePath, shellQuote, WorkbenchError } from "./errors.ts";
import type { CredentialVault } from "./vault.ts";
import { Store } from "./store.ts";
import { TaskManager } from "./tasks.ts";
import { ResourceMonitor } from "./resources.ts";
import { CommandService } from "./commands.ts";
import {
  identifyFile,
  MAX_TEXT_BYTES,
  MAX_PREVIEW_BYTES,
} from "./file-types.ts";
import type { RemoteFileInfo } from "../shared/workstation.ts";

const MAX_TEXT = MAX_TEXT_BYTES;
const MAX_OUTPUT = 256 * 1024;
export const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
function call<T>(
  fn: (
    callback: (error: Error | undefined | null, value: T) => void,
  ) => unknown,
) {
  return new Promise<T>((resolve, reject) =>
    fn((error, value) => (error ? reject(error) : resolve(value))),
  );
}
function action(fn: (callback: (error?: Error | null) => void) => unknown) {
  return new Promise<void>((resolve, reject) =>
    fn((error) => (error ? reject(error) : resolve())),
  );
}
const { Client, utils } = ssh2;
interface Connection {
  client: SshClient;
  host: Host;
  sftp?: SFTPWrapper;
  ready: Promise<SshClient>;
}
interface TerminalSession {
  info: TerminalInfo;
  channel: ClientChannel;
  buffer: string;
  listeners: Set<(message: object) => void>;
  inputOwner?: string;
}

export class Engine {
  private pool = new Map<string, Connection>();
  private states = new Map<string, ConnectionState>();
  private credentials = new Map<string, Credentials>();
  readonly tasks: TaskManager;
  private terminals = new Map<string, TerminalSession>();
  private tunnelServers = new Map<
    string,
    { info: Tunnel; server: Server; sockets: Set<Socket> }
  >();
  private pendingTrust = new Map<
    string,
    { address: string; fingerprint: string }
  >();
  private saveLocks = new Map<string, Promise<unknown>>();
  private monitor: ResourceMonitor;
  readonly commands: CommandService;
  constructor(
    readonly store: Store,
    private readonly vault?: CredentialVault,
  ) {
    this.tasks = new TaskManager(store);
    this.monitor = new ResourceMonitor(
      (id, command) => this.probe(id, command),
      (id) => this.store.host(id).revision,
    );
    this.commands = new CommandService(store, (id, path) => {
      if (this.states.get(id)?.status !== "connected")
        throw new WorkbenchError("NOT_CONNECTED", "服务器未连接");
      return this.list(id, path);
    });
  }
  connections() {
    return this.store.hosts().map(
      (h) =>
        this.states.get(h.id) ?? {
          hostId: h.id,
          status: "disconnected" as const,
        },
    );
  }
  terminalList() {
    return [...this.terminals.values()].map((s) => ({ ...s.info }));
  }
  tunnelList() {
    return [...this.tunnelServers.values()].map((t) => t.info);
  }
  /**
   * Keep credentials in memory for this Host process and persist them to the
   * DSH credential records so the next connect never asks again.
   */
  async setCredentials(id: string, credentials: Credentials) {
    this.store.host(id);
    this.credentials.set(id, { ...credentials });
    await this.vault?.write(id, credentials);
  }
  /** Remove stored credentials; memory is cleared and the record is deleted. */
  async forgetCredentials(id: string) {
    this.credentials.delete(id);
    await this.vault?.forget(id);
  }
  async hasStoredCredentials(id: string) {
    if (this.credentials.has(id)) return true;
    return !!(await this.vault?.read(id));
  }
  isConnected(hostId: string) {
    return this.states.get(hostId)?.status === "connected";
  }
  async trust(hostId: string, fingerprint: string) {
    const pending = this.pendingTrust.get(hostId);
    if (!pending || pending.fingerprint !== fingerprint)
      throw new WorkbenchError("TRUST_EXPIRED", "指纹信息已变化，请重新连接");
    if (
      this.store.fingerprint(pending.address) &&
      this.store.fingerprint(pending.address) !== fingerprint
    )
      throw new WorkbenchError(
        "HOST_KEY_CHANGED",
        "服务器身份已变化，请先通过可信渠道核对主机密钥",
      );
    await this.store.trust(pending.address, fingerprint);
    this.pendingTrust.delete(hostId);
  }
  async connect(hostId: string, seen = new Set<string>()): Promise<SshClient> {
    if (seen.has(hostId) || seen.size > 8)
      throw new WorkbenchError("JUMP_CYCLE", "跳板机链无效");
    seen.add(hostId);
    const host = this.store.host(hostId);
    const existing = this.pool.get(hostId);
    if (existing && existing.host.revision === host.revision)
      return existing.ready;
    if (existing) this.disconnect(hostId);
    this.states.set(hostId, { hostId, status: "connecting" });
    const client = new Client();
    const connection: Connection = {
      client,
      host,
      ready: Promise.resolve(client),
    };
    connection.ready = Promise.resolve().then(async () => {
      try {
        if (!this.credentials.has(hostId) && this.vault) {
          const saved = await this.vault.read(hostId);
          if (saved) this.credentials.set(hostId, saved);
        }
        const credential = this.credentials.get(hostId) ?? {};
        let key: Buffer | undefined;
        if (host.auth === "key")
          key = await readFile(
            host.privateKeyPath!.replace(/^~(?=\/)/, homedir()),
          );
        if (host.auth === "password" && !credential.password)
          throw new WorkbenchError(
            "CREDENTIAL_REQUIRED",
            "请输入此次连接的密码（仅保存在内存）",
            { hostId },
          );
        const agent =
          process.env.SSH_AUTH_SOCK ??
          (process.platform === "win32"
            ? "\\\\.\\pipe\\openssh-ssh-agent"
            : undefined);
        if (host.auth === "agent" && !agent)
          throw new WorkbenchError(
            "AGENT_UNAVAILABLE",
            "未找到 SSH Agent，请选择密钥或密码认证",
          );
        let sock: ClientChannel | undefined;
        if (host.jumpHostId) {
          const jump = await this.connect(host.jumpHostId, seen);
          sock = await call<ClientChannel>((cb) =>
            jump.forwardOut("127.0.0.1", 0, host.address, host.port, cb),
          );
        }
        let verificationError: WorkbenchError | undefined;
        await new Promise<void>((resolve, reject) => {
          client.once("ready", resolve);
          client.once("error", (error) => reject(verificationError ?? error));
          client.once("close", () =>
            reject(
              verificationError ??
                new WorkbenchError("CONNECTION_CLOSED", "SSH 连接已关闭"),
            ),
          );
          client.connect({
            host: host.address,
            port: host.port,
            username: host.username,
            sock,
            password:
              host.auth === "password" ? credential.password : undefined,
            privateKey: key,
            passphrase: credential.passphrase,
            agent: host.auth === "agent" ? agent : undefined,
            readyTimeout: 30000,
            keepaliveInterval: 15000,
            keepaliveCountMax: 3,
            hostVerifier: (raw: Buffer) => {
              const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
              const fingerprint =
                "SHA256:" +
                createHash("sha256")
                  .update(buffer)
                  .digest("base64")
                  .replace(/=+$/, "");
              const address = `[${host.address}]:${host.port}`;
              const expected = this.store.fingerprint(address);
              if (expected === fingerprint) return true;
              const parsed = utils.parseKey(buffer);
              verificationError = new WorkbenchError(
                expected ? "HOST_KEY_CHANGED" : "HOST_KEY_UNKNOWN",
                expected
                  ? "服务器主机密钥与已保存记录不同，连接已阻止"
                  : "首次连接，请核对服务器指纹",
                {
                  hostId,
                  address,
                  fingerprint,
                  algorithm:
                    parsed instanceof Error
                      ? "SSH"
                      : Array.isArray(parsed)
                        ? parsed[0]?.type
                        : parsed.type,
                },
              );
              if (!expected)
                this.pendingTrust.set(hostId, { address, fingerprint });
              return false;
            },
          });
        });
        this.states.set(hostId, { hostId, status: "connected" });
        return client;
      } catch (error) {
        client.end();
        if (this.pool.get(hostId) === connection) this.pool.delete(hostId);
        this.states.set(hostId, {
          hostId,
          status: "error",
          error: error instanceof Error ? error.message : "连接失败",
        });
        throw error;
      }
    });
    this.pool.set(hostId, connection);
    client.on("error", () => {});
    client.on("close", () => {
      if (this.pool.get(hostId) === connection) {
        this.pool.delete(hostId);
        this.states.set(hostId, { hostId, status: "disconnected" });
        for (const t of this.tunnelList())
          if (t.hostId === hostId) this.closeTunnel(t.id);
      }
    });
    return connection.ready;
  }
  disconnect(hostId: string, forget = false) {
    this.monitor.clear(hostId);
    const children = this.store.hosts().filter((h) => h.jumpHostId === hostId);
    for (const child of children) this.disconnect(child.id, forget);
    const connection = this.pool.get(hostId);
    this.pool.delete(hostId);
    connection?.client.end();
    this.states.set(hostId, { hostId, status: "disconnected" });
    if (forget) this.credentials.delete(hostId);
    for (const t of this.terminalList())
      if (t.hostId === hostId && t.status === "running")
        this.closeTerminal(t.id);
    for (const t of this.tunnelList())
      if (t.hostId === hostId) this.closeTunnel(t.id);
  }
  async sftp(hostId: string) {
    const client = await this.connect(hostId);
    const entry = this.pool.get(hostId);
    if (!entry) throw new WorkbenchError("CONNECTION_CLOSED", "连接已中断");
    if (!entry.sftp) {
      const sftp = await call<SFTPWrapper>((cb) => client.sftp(cb));
      entry.sftp = sftp;
      sftp.on("close", () => {
        if (entry.sftp === sftp) entry.sftp = undefined;
      });
      sftp.on("error", () => {});
    }
    return entry.sftp;
  }
  async canonical(hostId: string, path: string) {
    const sftp = await this.sftp(hostId);
    return call<string>((cb) => sftp.realpath(absolutePath(path), cb));
  }
  async list(
    hostId: string,
    path: string,
    hostRevision = this.store.host(hostId).revision,
  ): Promise<{ path: string; entries: FileEntry[]; hostRevision: number }> {
    this.checkRevision(hostId, hostRevision);
    const sftp = await this.sftp(hostId);
    const canonical = await this.canonical(hostId, path);
    this.checkRevision(hostId, hostRevision);
    const rows = await call<import("ssh2").FileEntry[]>((cb) =>
      sftp.readdir(canonical, cb),
    );
    return {
      path: canonical,
      hostRevision,
      entries: rows
        .filter((r) => r.filename !== "." && r.filename !== "..")
        .map((r) => ({
          name: r.filename,
          path: posix.join(canonical, r.filename),
          type:
            (r.attrs.mode & 0o170000) === 0o040000
              ? ("directory" as const)
              : (r.attrs.mode & 0o170000) === 0o120000
                ? ("symlink" as const)
                : ("file" as const),
          size: r.attrs.size,
          modified: r.attrs.mtime * 1000,
          mode: (r.attrs.mode & 0o777).toString(8),
        }))
        .sort(
          (a, b) =>
            Number(b.type === "directory") - Number(a.type === "directory") ||
            a.name.localeCompare(b.name),
        ),
    };
  }
  private checkRevision(hostId: string, revision: number) {
    if (this.store.host(hostId).revision !== revision)
      throw new WorkbenchError(
        "CONNECTION_CHANGED",
        "连接设置已变化，请重新选择目标后操作",
        undefined,
        409,
      );
  }
  resources(hostId: string) {
    if (this.states.get(hostId)?.status !== "connected")
      throw new WorkbenchError(
        "NOT_CONNECTED",
        "请先连接服务器再查看资源状态",
        undefined,
        409,
      );
    return this.monitor.get(hostId);
  }
  /** Bounded telemetry channel: no task creation, retry, or PTY injection. */
  private async probe(hostId: string, command: string): Promise<string> {
    const entry = this.pool.get(hostId);
    if (!entry || this.states.get(hostId)?.status !== "connected")
      throw new WorkbenchError(
        "NOT_CONNECTED",
        "服务器已断开连接",
        undefined,
        409,
      );
    const revision = entry.host.revision;
    const client = await entry.ready;
    this.checkRevision(hostId, revision);
    const result = await new Promise<string>((resolve, reject) => {
      let channel: ClientChannel | undefined;
      let finished = false;
      let size = 0;
      const chunks: Buffer[] = [];
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) {
          channel?.signal("TERM");
          channel?.close();
          reject(error);
        } else resolve(Buffer.concat(chunks).toString("utf8"));
      };
      const timer = setTimeout(
        () =>
          finish(
            new WorkbenchError(
              "METRICS_TIMEOUT",
              "资源采集超时，可稍后手动重试",
            ),
          ),
        8000,
      );
      client.exec(command, (error, stream) => {
        if (error) {
          finish(error);
          return;
        }
        channel = stream;
        if (finished) {
          stream.close();
          return;
        }
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            finish(
              new WorkbenchError("METRICS_TOO_LARGE", "资源采集输出超过限制"),
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        stream.stderr.on("data", () => {});
        stream.once("error", finish);
        stream.once("close", (code?: number) => {
          if (code !== 0)
            finish(
              new WorkbenchError(
                "METRICS_UNAVAILABLE",
                "服务器未能完成资源采集",
              ),
            );
          else finish();
        });
      });
    });
    this.checkRevision(hostId, revision);
    if (
      this.pool.get(hostId) !== entry ||
      this.states.get(hostId)?.status !== "connected"
    )
      throw new WorkbenchError(
        "NOT_CONNECTED",
        "采集期间连接已断开",
        undefined,
        409,
      );
    return result;
  }
  private async readBytes(
    hostId: string,
    path: string,
    limit: number,
    revision: number,
  ) {
    this.checkRevision(hostId, revision);
    absolutePath(path);
    const sftp = await this.sftp(hostId);
    this.checkRevision(hostId, revision);
    const stats = await call<import("ssh2").Stats>((cb) => sftp.stat(path, cb));
    if (!stats.isFile())
      throw new WorkbenchError("NOT_A_FILE", "请选择普通文件");
    if (stats.size > limit)
      throw new WorkbenchError(
        "FILE_TOO_LARGE",
        `当前文件超过 ${Math.round(limit / 1024 / 1024)} MiB 上限，请下载后打开`,
      );
    const stream = sftp.createReadStream(path);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const data = Buffer.from(chunk);
      size += data.length;
      if (size > limit) {
        stream.destroy();
        throw new WorkbenchError("FILE_TOO_LARGE", "读取期间文件超过大小上限");
      }
      chunks.push(data);
    }
    this.checkRevision(hostId, revision);
    if (size !== stats.size)
      throw new WorkbenchError(
        "FILE_CONFLICT",
        "读取期间远程文件长度发生变化，请重试",
        { path },
        409,
      );
    return { data: Buffer.concat(chunks), stats };
  }
  async fileInfo(
    hostId: string,
    path: string,
    revision = this.store.host(hostId).revision,
  ): Promise<RemoteFileInfo> {
    this.checkRevision(hostId, revision);
    const sftp = await this.sftp(hostId);
    const stats = await call<import("ssh2").Stats>((cb) =>
      sftp.stat(absolutePath(path), cb),
    );
    if (!stats.isFile())
      throw new WorkbenchError("NOT_A_FILE", "请选择普通文件");
    const head =
      stats.size === 0
        ? Buffer.alloc(0)
        : await call<Buffer>((cb) =>
            sftp.open(path, "r", (error, handle) => {
              if (error) {
                cb(error, Buffer.alloc(0));
                return;
              }
              const buffer = Buffer.alloc(Math.min(stats.size, 4096));
              sftp.read(
                handle,
                buffer,
                0,
                buffer.length,
                0,
                (readError, count) => {
                  sftp.close(handle, () =>
                    cb(readError, buffer.subarray(0, count)),
                  );
                },
              );
            }),
          );
    this.checkRevision(hostId, revision);
    const type = identifyFile(path, head);
    const text = ["text", "code", "markdown"].includes(type.kind);
    const previewable =
      type.kind !== "binary" &&
      stats.size <= (text ? MAX_TEXT_BYTES : MAX_PREVIEW_BYTES);
    return {
      hostId,
      hostRevision: revision,
      path,
      name: posix.basename(path),
      size: stats.size,
      modified: stats.mtime * 1000,
      mode: (stats.mode & 0o7777).toString(8),
      ...type,
      editable: previewable && (text || type.kind === "pdf"),
      previewable,
      reason: !previewable
        ? type.kind === "binary"
          ? "此类型暂不支持在线预览，请下载后打开"
          : "文件超过在线打开上限，请下载后打开"
        : undefined,
      maxTextBytes: MAX_TEXT_BYTES,
      maxPreviewBytes: MAX_PREVIEW_BYTES,
    };
  }
  async preview(
    hostId: string,
    path: string,
    revision = this.store.host(hostId).revision,
  ) {
    const { data } = await this.readBytes(
      hostId,
      path,
      MAX_PREVIEW_BYTES,
      revision,
    );
    const type = identifyFile(path, data.subarray(0, 4096));
    if (type.kind === "binary")
      throw new WorkbenchError(
        "PREVIEW_UNSUPPORTED",
        "此类型暂不支持在线预览，请下载后打开",
      );
    return {
      data,
      mime: type.mime,
      etag: digest(data),
      hostRevision: revision,
    };
  }
  async read(
    hostId: string,
    path: string,
    hostRevision = this.store.host(hostId).revision,
  ): Promise<RemoteFile> {
    this.checkRevision(hostId, hostRevision);
    absolutePath(path);
    const sftp = await this.sftp(hostId);
    this.checkRevision(hostId, hostRevision);
    const stats = await call<import("ssh2").Stats>((cb) => sftp.stat(path, cb));
    if (!stats.isFile())
      throw new WorkbenchError("NOT_A_FILE", "请选择普通文件");
    if (stats.size > MAX_TEXT)
      throw new WorkbenchError(
        "FILE_TOO_LARGE",
        "编辑器支持 1 MiB 以内的文本文件，请下载较大的文件",
      );
    const stream = sftp.createReadStream(path);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const b = Buffer.from(chunk);
      size += b.length;
      if (size > MAX_TEXT) {
        stream.destroy();
        throw new WorkbenchError("FILE_TOO_LARGE", "文件大小超过编辑上限");
      }
      chunks.push(b);
    }
    const data = Buffer.concat(chunks);
    if (data.includes(0))
      throw new WorkbenchError("BINARY_FILE", "这是二进制文件，请下载查看");
    if (hostRevision !== this.store.host(hostId).revision)
      throw new WorkbenchError(
        "CONNECTION_CHANGED",
        "连接设置已变化，请重新读取文件",
        undefined,
        409,
      );
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new WorkbenchError(
        "ENCODING_UNSUPPORTED",
        "文件不是有效 UTF-8 文本，请下载后按原编码编辑",
      );
    }
    return {
      path,
      content: data.toString("utf8"),
      etag: digest(data),
      size: data.length,
      hostRevision,
    };
  }
  async write(
    hostId: string,
    path: string,
    content: string,
    etag: string,
    hostRevision = this.store.host(hostId).revision,
  ) {
    absolutePath(path);
    if (Buffer.byteLength(content) > MAX_TEXT)
      throw new WorkbenchError("FILE_TOO_LARGE", "文件大小超过编辑上限");
    const lockKey = `${hostId}:${path}`;
    const previous = this.saveLocks.get(lockKey) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        if (hostRevision !== this.store.host(hostId).revision)
          throw new WorkbenchError(
            "CONNECTION_CHANGED",
            "连接设置已变化，请重新打开文件后再保存",
            undefined,
            409,
          );
        const sftp = await this.sftp(hostId);
        const before = await this.read(hostId, path);
        if (before.etag !== etag)
          throw new WorkbenchError(
            "FILE_CONFLICT",
            "远程文件已变化，请重新载入并合并修改",
            { path },
            409,
          );
        const stats = await call<import("ssh2").Stats>((cb) =>
          sftp.stat(path, cb),
        );
        const temp = posix.join(
          posix.dirname(path),
          `.${posix.basename(path)}.rw-${randomUUID()}`,
        );
        try {
          await action((cb) =>
            sftp.writeFile(
              temp,
              Buffer.from(content),
              { mode: stats.mode & 0o777, flag: "wx" },
              cb,
            ),
          );
          if ((await this.read(hostId, path)).etag !== etag)
            throw new WorkbenchError(
              "FILE_CONFLICT",
              "保存期间远程文件发生变化，请重新载入",
              { path },
              409,
            );
          this.checkRevision(hostId, hostRevision);
          // POSIX rename is atomic on servers that advertise the OpenSSH extension.
          try {
            await action((cb) => sftp.ext_openssh_rename(temp, path, cb));
          } catch (error) {
            if (/unsupported|not supported/i.test((error as Error).message))
              throw new WorkbenchError(
                "ATOMIC_RENAME_UNAVAILABLE",
                "此服务器不支持安全替换文件，请使用上传另存为",
              );
            throw error;
          }
          return {
            path,
            content,
            etag: digest(content),
            size: Buffer.byteLength(content),
            hostRevision,
          };
        } finally {
          await action((cb) => sftp.unlink(temp, cb)).catch(() => {});
        }
      });
    this.saveLocks.set(lockKey, operation);
    try {
      return await operation;
    } finally {
      if (this.saveLocks.get(lockKey) === operation)
        this.saveLocks.delete(lockKey);
    }
  }
  async mkdir(
    hostId: string,
    path: string,
    hostRevision = this.store.host(hostId).revision,
  ) {
    this.checkRevision(hostId, hostRevision);
    const sftp = await this.sftp(hostId);
    this.checkRevision(hostId, hostRevision);
    await action((cb) => sftp.mkdir(absolutePath(path), { mode: 0o755 }, cb));
  }
  async createFile(
    hostId: string,
    path: string,
    content = "",
    revision = this.store.host(hostId).revision,
  ) {
    this.checkRevision(hostId, revision);
    if (Buffer.byteLength(content) > MAX_TEXT_BYTES)
      throw new WorkbenchError("FILE_TOO_LARGE", "新建文件内容超过 1 MiB");
    const sftp = await this.sftp(hostId);
    this.checkRevision(hostId, revision);
    try {
      await action((cb) =>
        sftp.writeFile(
          absolutePath(path),
          Buffer.from(content),
          { flag: "wx", mode: 0o644 },
          cb,
        ),
      );
    } catch (error) {
      try {
        await call((cb) => sftp.lstat(path, cb));
      } catch {
        throw error;
      }
      throw new WorkbenchError("TARGET_EXISTS", "文件名已存在，未覆盖原文件");
    }
    this.checkRevision(hostId, revision);
    return this.read(hostId, path, revision);
  }
  async chmod(
    hostId: string,
    path: string,
    mode: string,
    revision = this.store.host(hostId).revision,
  ) {
    if (!/^[0-7]{3,4}$/.test(mode))
      throw new WorkbenchError("INVALID_MODE", "权限需要 3 或 4 位八进制数字");
    this.checkRevision(hostId, revision);
    const sftp = await this.sftp(hostId);
    this.checkRevision(hostId, revision);
    await action((cb) => sftp.chmod(absolutePath(path), parseInt(mode, 8), cb));
    this.checkRevision(hostId, revision);
  }
  async copy(
    hostId: string,
    path: string,
    target: string,
    revision = this.store.host(hostId).revision,
  ) {
    absolutePath(path);
    absolutePath(target);
    this.checkRevision(hostId, revision);
    const sftp = await this.sftp(hostId);
    const stats = await call<import("ssh2").Stats>((cb) =>
      sftp.lstat(path, cb),
    );
    if (!stats.isFile())
      throw new WorkbenchError(
        "COPY_FILE_ONLY",
        "当前只支持复制普通文件；目录和符号链接请使用终端操作",
      );
    this.checkRevision(hostId, revision);
    const source = sftp.createReadStream(path);
    // Upload already uses an exclusive temporary file, cancellation, progress,
    // and a non-overwriting rename. It never buffers the complete source file.
    let result;
    try {
      result = await this.upload(hostId, target, source, stats.size, revision);
    } finally {
      source.destroy();
    }
    this.checkRevision(hostId, revision);
    await action((cb) => sftp.chmod(target, stats.mode & 0o777, cb));
    return result;
  }
  async writePdf(
    hostId: string,
    path: string,
    data: Buffer,
    etag: string,
    revision: number,
  ) {
    absolutePath(path);
    if (data.length > MAX_PREVIEW_BYTES)
      throw new WorkbenchError("FILE_TOO_LARGE", "PDF 保存上限为 25 MiB");
    if (data.subarray(0, 5).toString() !== "%PDF-")
      throw new WorkbenchError("INVALID_PDF", "保存内容不是 PDF 文件");
    const key = `${hostId}:${path}`;
    const previous = this.saveLocks.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        this.checkRevision(hostId, revision);
        const sftp = await this.sftp(hostId);
        const before = await this.readBytes(
          hostId,
          path,
          MAX_PREVIEW_BYTES,
          revision,
        );
        if (before.data.subarray(0, 5).toString() !== "%PDF-")
          throw new WorkbenchError(
            "INVALID_PDF",
            "原文件不是 PDF，不能以 PDF 覆盖",
          );
        if (digest(before.data) !== etag)
          throw new WorkbenchError(
            "FILE_CONFLICT",
            "远程 PDF 已变化，请重新载入并合并批注",
            { path },
            409,
          );
        const temp = posix.join(
          posix.dirname(path),
          `.${posix.basename(path)}.rw-${randomUUID()}`,
        );
        try {
          await action((cb) =>
            sftp.writeFile(
              temp,
              data,
              { flag: "wx", mode: before.stats.mode & 0o777 },
              cb,
            ),
          );
          const latest = await this.readBytes(
            hostId,
            path,
            MAX_PREVIEW_BYTES,
            revision,
          );
          if (digest(latest.data) !== etag)
            throw new WorkbenchError(
              "FILE_CONFLICT",
              "保存期间远程 PDF 已变化，批注尚未覆盖服务器",
              { path },
              409,
            );
          this.checkRevision(hostId, revision);
          try {
            await action((cb) => sftp.ext_openssh_rename(temp, path, cb));
          } catch (error) {
            if (/unsupported|not supported/i.test((error as Error).message))
              throw new WorkbenchError(
                "ATOMIC_RENAME_UNAVAILABLE",
                "服务器不支持原子替换，PDF 尚未保存",
              );
            throw error;
          }
          return {
            path,
            etag: digest(data),
            size: data.length,
            hostRevision: revision,
          };
        } finally {
          await action((cb) => sftp.unlink(temp, cb)).catch(() => {});
        }
      });
    this.saveLocks.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.saveLocks.get(key) === operation) this.saveLocks.delete(key);
    }
  }
  async rename(
    hostId: string,
    path: string,
    target: string,
    hostRevision = this.store.host(hostId).revision,
  ) {
    this.checkRevision(hostId, hostRevision);
    const sftp = await this.sftp(hostId);
    this.checkRevision(hostId, hostRevision);
    absolutePath(path);
    absolutePath(target);
    try {
      await call((cb) => sftp.lstat(target, cb));
      throw new WorkbenchError("TARGET_EXISTS", "目标名称已存在");
    } catch (error) {
      if ((error as { code?: number }).code !== 2) throw error;
    }
    this.checkRevision(hostId, hostRevision);
    await action((cb) => sftp.rename(path, target, cb));
  }
  async remove(
    hostId: string,
    path: string,
    hostRevision = this.store.host(hostId).revision,
  ) {
    this.checkRevision(hostId, hostRevision);
    absolutePath(path);
    if (posix.normalize(path) === "/")
      throw new WorkbenchError("ROOT_PROTECTED", "不能删除根目录");
    const sftp = await this.sftp(hostId);
    const stat = await call<import("ssh2").Stats>((cb) => sftp.lstat(path, cb));
    this.checkRevision(hostId, hostRevision);
    // Empty directories only: recursive removal is deliberately a separate workflow.
    await action((cb) =>
      stat.isDirectory() ? sftp.rmdir(path, cb) : sftp.unlink(path, cb),
    );
  }
  async upload(
    hostId: string,
    path: string,
    source: Readable,
    total: number,
    hostRevision = this.store.host(hostId).revision,
  ) {
    this.checkRevision(hostId, hostRevision);
    absolutePath(path);
    const host = this.store.host(hostId);
    const sftp = await this.sftp(hostId);
    this.checkRevision(hostId, hostRevision);
    const { task, signal } = await this.tasks.start(
      host,
      "upload",
      posix.basename(path),
    );
    const temp = posix.join(
      posix.dirname(path),
      `.${posix.basename(path)}.rw-${task.id}`,
    );
    try {
      try {
        await call((cb) => sftp.lstat(path, cb));
        throw new WorkbenchError(
          "TARGET_EXISTS",
          "同名文件已存在，请重命名后上传",
        );
      } catch (error) {
        if ((error as { code?: number }).code !== 2) throw error;
      }
      let bytes = 0;
      await pipeline(
        source,
        new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            bytes += chunk.length;
            this.tasks.update(task, {
              bytes,
              total,
              progress: total ? Math.min(99, (bytes / total) * 100) : 0,
            });
            callback(null, chunk);
          },
        }),
        sftp.createWriteStream(temp, { flags: "wx", mode: 0o644 }),
        { signal },
      );
      if (total && bytes !== total)
        throw new WorkbenchError(
          "TRANSFER_INCOMPLETE",
          "文件长度不匹配，上传未提交",
        );
      this.checkRevision(hostId, hostRevision);
      await action((cb) => sftp.rename(temp, path, cb));
      await this.tasks.finish(task, {
        status: "completed",
        progress: 100,
        bytes,
        total: bytes,
      });
      return task;
    } catch (error) {
      await action((cb) => sftp.unlink(temp, cb)).catch(() => {});
      await this.tasks.finish(task, {
        status: signal.aborted ? "cancelled" : "failed",
        error: (error as Error).message,
      });
      throw error;
    }
  }
  async download(
    hostId: string,
    path: string,
    destination: Writable,
    hostRevision = this.store.host(hostId).revision,
  ) {
    this.checkRevision(hostId, hostRevision);
    absolutePath(path);
    const host = this.store.host(hostId);
    const sftp = await this.sftp(hostId);
    const stat = await call<import("ssh2").Stats>((cb) => sftp.stat(path, cb));
    this.checkRevision(hostId, hostRevision);
    if (!stat.isFile())
      throw new WorkbenchError("NOT_A_FILE", "请选择文件下载");
    const { task, signal } = await this.tasks.start(
      host,
      "download",
      posix.basename(path),
    );
    let bytes = 0;
    try {
      await pipeline(
        sftp.createReadStream(path),
        new Transform({
          transform: (chunk: Buffer, _enc, cb) => {
            bytes += chunk.length;
            this.tasks.update(task, {
              bytes,
              total: stat.size,
              progress: stat.size ? (bytes / stat.size) * 100 : 100,
            });
            cb(null, chunk);
          },
        }),
        destination,
        { signal },
      );
      if (bytes !== stat.size)
        throw new WorkbenchError(
          "TRANSFER_INCOMPLETE",
          "下载期间文件长度发生变化",
        );
      await this.tasks.finish(task, {
        status: "completed",
        progress: 100,
        bytes,
        total: bytes,
      });
    } catch (error) {
      await this.tasks.finish(task, {
        status: signal.aborted ? "cancelled" : "failed",
        error: (error as Error).message,
      });
      throw error;
    }
  }
  async exec(
    hostId: string,
    command: string,
    cwd: string,
    timeoutMs = 60000,
    externalSignal?: AbortSignal,
    hostRevision = this.store.host(hostId).revision,
  ) {
    this.checkRevision(hostId, hostRevision);
    absolutePath(cwd);
    if (!command.trim() || command.length > 16000)
      throw new WorkbenchError("INVALID_COMMAND", "命令为空或过长");
    const client = await this.connect(hostId);
    this.checkRevision(hostId, hostRevision);
    const host = this.store.host(hostId);
    const { task, signal } = await this.tasks.start(
      host,
      "command",
      command.slice(0, 100),
      { command },
    );
    const combined = externalSignal
      ? AbortSignal.any([signal, externalSignal])
      : signal;
    let channel: ClientChannel | undefined;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let started = false;
    const append = (text: string, kind: "stdout" | "stderr") => {
      const available = MAX_OUTPUT - stdout.length - stderr.length;
      if (available <= 0) {
        truncated = true;
        return;
      }
      if (text.length > available) truncated = true;
      if (kind === "stdout") stdout += text.slice(0, available);
      else stderr += text.slice(0, available);
      this.tasks.update(task, { output: stdout + stderr });
    };
    try {
      combined.throwIfAborted();
      this.checkRevision(hostId, hostRevision);
      const result = await new Promise<{
        exitCode: number | null;
        signal?: string;
      }>((resolve, reject) => {
        const abort = () => {
          channel?.signal("TERM");
          channel?.close();
          reject(combined.reason);
        };
        const timeout = setTimeout(
          () => {
            channel?.signal("TERM");
            channel?.close();
            reject(
              new WorkbenchError(
                "EXEC_TIMEOUT",
                "命令等待超时，远程结果需要核对",
              ),
            );
          },
          Math.min(Math.max(timeoutMs, 1000), 600000),
        );
        const finish = (
          error?: Error,
          value?: { exitCode: number | null; signal?: string },
        ) => {
          clearTimeout(timeout);
          combined.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(value!);
        };
        combined.addEventListener("abort", abort, { once: true });
        client.exec(
          `cd -- ${shellQuote(cwd)} && ${command}`,
          (error, stream) => {
            if (error) {
              finish(error);
              return;
            }
            channel = stream;
            started = true;
            if (combined.aborted) {
              abort();
              return;
            }
            const out = new StringDecoder("utf8");
            const err = new StringDecoder("utf8");
            stream.on("data", (b: Buffer) => append(out.write(b), "stdout"));
            stream.stderr.on("data", (b: Buffer) =>
              append(err.write(b), "stderr"),
            );
            stream.once("error", (error: Error) => finish(error));
            stream.once(
              "close",
              (code: number | undefined, sig: string | undefined) => {
                append(out.end(), "stdout");
                append(err.end(), "stderr");
                finish(undefined, { exitCode: code ?? null, signal: sig });
              },
            );
          },
        );
      });
      const unknown = result.exitCode === null;
      await this.tasks.finish(task, {
        status: unknown
          ? "unknown"
          : result.exitCode === 0
            ? "completed"
            : "failed",
        progress: 100,
        output: stdout + stderr,
        error: unknown ? "连接结束时未收到退出状态，请核对远程结果" : undefined,
      });
      return { taskId: task.id, stdout, stderr, truncated, ...result };
    } catch (error) {
      await this.tasks.finish(task, {
        status: started ? "unknown" : combined.aborted ? "cancelled" : "failed",
        error: started
          ? "命令已发出，最终远程结果未确认：" + (error as Error).message
          : (error as Error).message,
        output: stdout + stderr,
      });
      throw error;
    }
  }
  async terminal(hostId: string, cwd: string, cols = 100, rows = 28) {
    const client = await this.connect(hostId);
    const host = this.store.host(hostId);
    const active = [...this.terminals.values()].filter(
      (t) => t.info.status === "running",
    );
    if (active.length >= 12)
      throw new WorkbenchError(
        "TERMINAL_LIMIT",
        "最多同时打开 12 个终端，请关闭暂时不用的终端",
      );
    const channel = await call<ClientChannel>((cb) =>
      client.shell({ term: "xterm-256color", cols, rows }, cb),
    );
    const info: TerminalInfo = {
      id: randomUUID(),
      hostId,
      title: `${host.username}@${host.name}`,
      status: "running",
      createdAt: Date.now(),
    };
    const terminal: TerminalSession = {
      info,
      channel,
      buffer: "",
      listeners: new Set(),
    };
    this.terminals.set(info.id, terminal);
    const decoder = new StringDecoder("utf8");
    channel.on("data", (data: Buffer) => {
      const text = decoder.write(data);
      terminal.buffer = (terminal.buffer + text).slice(-256 * 1024);
      for (const fn of terminal.listeners) fn({ type: "output", data: text });
    });
    channel.on("error", (error: Error) => {
      for (const fn of terminal.listeners)
        fn({ type: "error", message: error.message });
    });
    channel.on("close", (exitCode?: number) => {
      info.status = "exited";
      info.exitCode = exitCode;
      for (const fn of terminal.listeners) fn({ type: "exit", code: exitCode });
    });
    channel.write(`cd -- ${shellQuote(absolutePath(cwd))}\r`);
    return info;
  }
  attachTerminal(
    id: string,
    attachmentId: string,
    listener: (message: object) => void,
  ) {
    const t = this.terminals.get(id);
    if (!t)
      throw new WorkbenchError(
        "TERMINAL_NOT_FOUND",
        "终端已结束，请新建终端",
        undefined,
        404,
      );
    listener({ type: "replay", data: t.buffer, status: t.info.status });
    t.listeners.add(listener);
    if (!t.inputOwner) t.inputOwner = attachmentId;
    listener({ type: "ownership", writable: t.inputOwner === attachmentId });
    return {
      write: (data: string) => {
        if (t.inputOwner === attachmentId && t.info.status === "running")
          t.channel.write(data);
      },
      resize: (cols: number, rows: number) => {
        if (t.inputOwner === attachmentId && t.info.status === "running")
          t.channel.setWindow(rows, cols, 0, 0);
      },
      takeover: () => {
        t.inputOwner = attachmentId;
        for (const fn of t.listeners) fn({ type: "ownershipChanged" });
        listener({ type: "ownership", writable: true });
      },
      detach: () => {
        t.listeners.delete(listener);
        if (t.inputOwner === attachmentId) t.inputOwner = undefined;
      },
    };
  }
  terminalText(id: string) {
    return this.terminals.get(id)?.buffer ?? "";
  }
  closeTerminal(id: string) {
    const t = this.terminals.get(id);
    if (t) {
      t.channel.close();
      t.info.status = "exited";
    }
  }
  forgetTerminal(id: string) {
    this.closeTerminal(id);
    this.terminals.delete(id);
  }
  async openTunnel(
    hostId: string,
    localPort: number,
    targetHost: string,
    targetPort: number,
  ) {
    const client = await this.connect(hostId);
    const id = randomUUID();
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      client.forwardOut(
        "127.0.0.1",
        socket.remotePort ?? 0,
        targetHost,
        targetPort,
        (error, stream) => {
          if (error) {
            socket.destroy();
            return;
          }
          stream.on("error", () => socket.destroy());
          socket.on("close", () => stream.close());
          stream.pipe(socket).pipe(stream);
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(localPort, "127.0.0.1", resolve);
    });
    server.on("error", () => this.closeTunnel(id));
    const info: Tunnel = {
      id,
      hostId,
      localPort: (server.address() as import("node:net").AddressInfo).port,
      targetHost,
      targetPort,
    };
    this.tunnelServers.set(id, { info, server, sockets });
    return info;
  }
  closeTunnel(id: string) {
    const t = this.tunnelServers.get(id);
    if (!t) return;
    t.server.close();
    for (const socket of t.sockets) socket.destroy();
    this.tunnelServers.delete(id);
  }
  async dispose() {
    for (const h of this.store.hosts()) this.disconnect(h.id, true);
    for (const id of this.tunnelServers.keys()) this.closeTunnel(id);
    await this.tasks.dispose();
  }
}
