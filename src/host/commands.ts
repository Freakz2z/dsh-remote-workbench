import type { CommandSuggestion } from "../shared/workstation.ts";
import type { Store } from "./store.ts";
import type { FileEntry } from "../shared/types.ts";
import { posix } from "node:path";
import { absolutePath, shellQuote } from "./errors.ts";

/** Never infer commands from raw PTY input: that includes password prompts. */
export function canRememberCommand(command: string) {
  const literal = command.replace(/\$\{?[A-Za-z_]\w*\}?/g, "$ENV");
  return (
    !!command.trim() &&
    command.length <= 4096 &&
    !/^\s/.test(command) &&
    !/[\r\n\x00-\x1f\x7f]/.test(command) &&
    !/(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|private[_-]?key|credential|BEGIN[ -](?:RSA|OPENSSH|EC)?[ -]*PRIVATE)/i.test(
      literal,
    ) &&
    !/(?:https?:\/\/)[^\s/@]+:[^\s/@]+@|(?:^|\s)(?:sshpass|mysql\s+.*-p\S|curl\s+.*(?:-u|--user)\s)|(?:^|\s)-[pP]\S{3,}/.test(
      command,
    )
  );
}

const COMMON_COMMANDS = [
  ["ls -lah", "列出文件与隐藏项"],
  ["cd ", "切换目录"],
  ["pwd", "显示当前目录"],
  ["cat ", "读取文本文件"],
  ["less ", "分页阅读文件"],
  ["head -n 50 ", "查看文件开头"],
  ["tail -f ", "持续查看日志"],
  ["grep -n ", "搜索文本与行号"],
  ["find . -name ", "按名称查找文件"],
  ["du -sh ", "查看目录占用"],
  ["df -h", "查看挂载点容量"],
  ["free -h", "查看内存"],
  ["top", "查看系统进程"],
  ["htop", "交互查看系统进程"],
  ["ps aux", "查看进程列表"],
  ["uptime", "查看运行时间与负载"],
  ["uname -a", "查看系统信息"],
  ["whoami", "查看当前用户"],
  ["ip addr", "查看网卡地址"],
  ["ss -tulnp", "查看监听端口"],
  ["ping -c 4 ", "检查网络连通性"],
  ["curl -I ", "查看 HTTP 响应头"],
  ["journalctl -f", "持续查看系统日志"],
  ["systemctl status ", "查看服务状态"],
  ["docker ps", "查看运行中容器"],
  ["docker logs -f ", "持续查看容器日志"],
  ["docker compose ps", "查看 Compose 服务"],
  ["git status", "查看工作区状态"],
  ["git diff", "查看改动"],
  ["git log --oneline -10", "查看最近提交"],
  ["npm run ", "运行项目脚本"],
  ["python3 --version", "查看 Python 版本"],
  ["nvidia-smi", "查看 NVIDIA 显卡状态"],
  ["chmod ", "修改文件权限"],
  ["mkdir -p ", "创建目录"],
] as const;

export class CommandService {
  constructor(
    private store: Store,
    private list: (
      hostId: string,
      path: string,
    ) => Promise<{ entries: FileEntry[] }>,
  ) {}
  async suggest(
    hostId: string,
    input: string,
    cwd: string,
  ): Promise<{ items: CommandSuggestion[] }> {
    this.store.host(hostId);
    absolutePath(cwd);
    const query = input.trim().toLowerCase();
    const library = this.store.commandLibrary(hostId);
    const items: CommandSuggestion[] = [];
    for (const entry of library.history) {
      if (!query || entry.command.toLowerCase().includes(query))
        items.push({
          id: entry.id,
          kind: "history",
          label: entry.command,
          value: entry.command,
          description: `历史 · ${entry.uses} 次 · ${entry.cwd}`,
        });
    }
    for (const entry of library.snippets) {
      if (
        !query ||
        `${entry.name} ${entry.command}`.toLowerCase().includes(query)
      )
        items.push({
          id: entry.id,
          kind: "snippet",
          label: entry.name,
          value: entry.command,
          description: entry.command,
        });
    }
    if (query) {
      for (const [command, description] of COMMON_COMMANDS) {
        if (command.toLowerCase().startsWith(query))
          items.push({
            id: "common:" + command,
            kind: "command",
            label: command,
            value: command,
            description,
          });
      }
    }
    // A deliberately small shell-token subset: arbitrary shell syntax is never
    // executed to obtain completions. Complex quoting keeps history suggestions.
    const match = input.match(/^(.*\s)([^\s'"`$\\;|&<>]*)$/);
    if (match) {
      const token = match[2];
      const base = token.includes("/")
        ? token.slice(0, token.lastIndexOf("/") + 1)
        : "";
      const needle = token.slice(base.length);
      const directory = posix.resolve(cwd, base || ".");
      try {
        const { entries } = await this.list(hostId, directory);
        const directoriesOnly = /^\s*cd\s+/.test(input);
        for (const entry of entries
          .filter(
            (e) =>
              !/[\x00-\x1f\x7f]/.test(e.name) &&
              e.name.startsWith(needle) &&
              (!directoriesOnly || e.type === "directory"),
          )
          .slice(0, 20)) {
          const value =
            base + entry.name + (entry.type === "directory" ? "/" : "");
          items.push({
            id: "path:" + entry.path,
            kind: "path",
            label: value,
            value: match[1] + shellQuote(value),
            description: entry.type === "directory" ? "远程目录" : "远程文件",
          });
        }
      } catch {
        /* Lack of directory access must not break history completion. */
      }
    }
    const seen = new Set<string>();
    return {
      items: items
        .filter((item) => !seen.has(item.value) && !!seen.add(item.value))
        .slice(0, 40),
    };
  }
}
