import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Host, HostInput, Task } from "../shared/types.ts";
import { WorkbenchError } from "./errors.ts";
import type {
  CommandHistoryEntry,
  CommandSnippet,
  CommandLibrary,
} from "../shared/workstation.ts";
import { canRememberCommand } from "./commands.ts";

const HostSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(80),
    address: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[a-zA-Z0-9.:_\-]+$/, "主机地址格式不正确"),
    port: z.number().int().min(1).max(65535),
    username: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\s\0]+$/),
    group: z.string().max(50).default("未分组"),
    rootPath: z.string().startsWith("/").max(4096),
    auth: z.enum(["agent", "key", "password"]),
    privateKeyPath: z.string().max(4096).optional(),
    jumpHostId: z.string().uuid().optional(),
    favorite: z.boolean().default(false),
  })
  .strict();
interface Stored {
  version: 1;
  hosts: Host[];
  knownHosts: Record<string, string>;
  tasks: Task[];
  commandHistory?: CommandHistoryEntry[];
  commandSnippets?: CommandSnippet[];
  commandPreferences?: Record<string, { remember: boolean }>;
}

export class Store {
  private data: Stored = { version: 1, hosts: [], knownHosts: {}, tasks: [] };
  private writes = Promise.resolve();
  constructor(readonly directory: string) {}
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(
        await readFile(join(this.directory, "state.json"), "utf8"),
      ) as Stored;
      if (
        data.version !== 1 ||
        !Array.isArray(data.hosts) ||
        !Array.isArray(data.tasks) ||
        typeof data.knownHosts !== "object"
      )
        throw new Error("配置文件格式不正确");
      for (const host of data.hosts)
        HostSchema.parse(
          Object.fromEntries(
            Object.entries(host).filter(([key]) => key != "revision"),
          ),
        );
      this.data = data;
      this.data.commandHistory = (
        Array.isArray(data.commandHistory) ? data.commandHistory : []
      )
        .filter(
          (row) =>
            typeof row.command === "string" &&
            canRememberCommand(row.command) &&
            typeof row.hostId === "string",
        )
        .slice(0, 2000);
      this.data.commandSnippets = Array.isArray(data.commandSnippets)
        ? data.commandSnippets.slice(0, 200)
        : [];
      this.data.commandPreferences =
        data.commandPreferences && typeof data.commandPreferences === "object"
          ? data.commandPreferences
          : {};
      for (const task of this.data.tasks)
        if (task.status === "running") {
          task.status = "unknown";
          task.error = "宿主已重启，上一次操作结果需要核对";
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  hosts() {
    return structuredClone(this.data.hosts);
  }
  host(id: string) {
    const host = this.data.hosts.find((h) => h.id === id);
    if (!host)
      throw new WorkbenchError(
        "HOST_NOT_FOUND",
        "主机已删除或不存在",
        undefined,
        404,
      );
    return structuredClone(host);
  }
  async saveHost(input: HostInput) {
    const value = HostSchema.parse(input);
    if (value.auth === "key" && !value.privateKeyPath?.trim())
      throw new WorkbenchError("KEY_REQUIRED", "请输入私钥路径");
    const old = value.id ? this.host(value.id) : undefined;
    const id = value.id ?? randomUUID();
    if (value.jumpHostId === id)
      throw new WorkbenchError("JUMP_CYCLE", "跳板机不能是主机本身");
    let jump = value.jumpHostId;
    const seen = new Set([id]);
    while (jump) {
      if (seen.has(jump))
        throw new WorkbenchError("JUMP_CYCLE", "跳板机配置存在循环");
      seen.add(jump);
      jump = this.host(jump).jumpHostId;
    }
    const host: Host = { ...value, id, revision: (old?.revision ?? 0) + 1 };
    this.data.hosts = [...this.data.hosts.filter((h) => h.id !== id), host];
    await this.persist();
    return host;
  }
  async deleteHost(id: string) {
    this.host(id);
    if (this.data.hosts.some((h) => h.jumpHostId === id))
      throw new WorkbenchError(
        "HOST_IN_USE",
        "这台主机正在被用作跳板机，请先修改关联配置",
      );
    this.data.hosts = this.data.hosts.filter((h) => h.id !== id);
    this.data.commandHistory = this.data.commandHistory?.filter(
      (row) => row.hostId !== id,
    );
    this.data.commandSnippets = this.data.commandSnippets?.filter(
      (row) => row.hostId !== id,
    );
    if (this.data.commandPreferences) delete this.data.commandPreferences[id];
    await this.persist();
  }
  fingerprint(address: string) {
    return this.data.knownHosts[address];
  }
  async trust(address: string, fingerprint: string) {
    this.data.knownHosts[address] = fingerprint;
    await this.persist();
  }
  tasks() {
    return structuredClone(this.data.tasks);
  }
  taskSummaries() {
    return this.data.tasks.map(
      ({ output: _output, command: _command, ...task }) => ({ ...task }),
    );
  }
  taskById(id: string) {
    const task = this.data.tasks.find((t) => t.id === id);
    if (!task)
      throw new WorkbenchError(
        "TASK_NOT_FOUND",
        "任务记录不存在",
        undefined,
        404,
      );
    return structuredClone(task);
  }
  task(task: Task) {
    const index = this.data.tasks.findIndex((t) => t.id === task.id);
    if (index < 0) this.data.tasks.unshift(task);
    else this.data.tasks[index] = task;
    this.data.tasks = this.data.tasks.slice(0, 200);
    for (const old of this.data.tasks.slice(20))
      if (old.output && old.output.length > 4096)
        old.output = old.output.slice(0, 4096) + "\n[旧任务输出已截断]";
  }
  persist() {
    const payload = JSON.stringify(this.data, null, 2);
    const write = async () => {
      const temp = join(this.directory, `.state-${randomUUID()}.tmp`);
      await writeFile(temp, payload, { mode: 0o600 });
      await rename(temp, join(this.directory, "state.json"));
    };
    const result = this.writes.then(write);
    this.writes = result.catch(() => {});
    return result;
  }
  async flush() {
    await this.writes;
  }
  commandLibrary(hostId: string, query = ""): CommandLibrary {
    this.host(hostId);
    const q = query.toLowerCase();
    return structuredClone({
      history: (this.data.commandHistory ?? []).filter(
        (row) => row.hostId === hostId && row.command.toLowerCase().includes(q),
      ),
      snippets: (this.data.commandSnippets ?? []).filter(
        (row) =>
          (!row.hostId || row.hostId === hostId) &&
          `${row.name} ${row.command}`.toLowerCase().includes(q),
      ),
      remember: this.data.commandPreferences?.[hostId]?.remember !== false,
    });
  }
  async rememberCommand(hostId: string, command: string, cwd: string) {
    this.host(hostId);
    if (!this.commandLibrary(hostId).remember || !canRememberCommand(command))
      return { remembered: false };
    const history = this.data.commandHistory ?? [];
    const old = history.find(
      (row) => row.hostId === hostId && row.command === command,
    );
    const entry: CommandHistoryEntry = {
      id: old?.id ?? randomUUID(),
      hostId,
      command,
      cwd,
      lastUsedAt: Date.now(),
      uses: (old?.uses ?? 0) + 1,
    };
    let perHost = 0;
    this.data.commandHistory = [
      entry,
      ...history.filter((row) => row.id !== old?.id),
    ]
      .filter((row) => row.hostId !== hostId || ++perHost <= 500)
      .slice(0, 2000);
    await this.persist();
    return { remembered: true };
  }
  async commandPreference(hostId: string, remember: boolean) {
    this.host(hostId);
    this.data.commandPreferences ??= {};
    this.data.commandPreferences[hostId] = { remember };
    await this.persist();
  }
  async clearCommands(hostId: string, id?: string) {
    this.host(hostId);
    this.data.commandHistory = (this.data.commandHistory ?? []).filter(
      (row) => row.hostId !== hostId || (id !== undefined && row.id !== id),
    );
    await this.persist();
  }
  async saveSnippet(input: {
    id?: string;
    hostId?: string;
    name: string;
    command: string;
    group?: string;
  }): Promise<CommandSnippet> {
    if (input.hostId) this.host(input.hostId);
    if (!canRememberCommand(input.command))
      throw new WorkbenchError(
        "SENSITIVE_COMMAND",
        "片段不可包含凭据或控制字符，请使用服务器环境变量引用敏感值",
      );
    const snippets = this.data.commandSnippets ?? [];
    const old = input.id
      ? snippets.find((row) => row.id === input.id)
      : undefined;
    if (input.id && !old)
      throw new WorkbenchError(
        "SNIPPET_NOT_FOUND",
        "命令片段不存在",
        undefined,
        404,
      );
    if (!old && snippets.length >= 200)
      throw new WorkbenchError("SNIPPET_LIMIT", "最多保存 200 条命令片段");
    const now = Date.now();
    const row: CommandSnippet = {
      ...input,
      group: input.group ?? "常用命令",
      id: old?.id ?? randomUUID(),
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
    this.data.commandSnippets = [
      row,
      ...snippets.filter((entry) => entry.id !== row.id),
    ];
    await this.persist();
    return structuredClone(row);
  }
  async deleteSnippet(id: string) {
    this.data.commandSnippets = (this.data.commandSnippets ?? []).filter(
      (row) => row.id !== id,
    );
    await this.persist();
  }
}
