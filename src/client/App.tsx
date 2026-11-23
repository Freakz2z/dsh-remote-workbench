import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Circle,
  Copy,
  Eraser,
  FilePlus,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  Link2,
  LoaderCircle,
  Maximize2,
  MoreHorizontal,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  Unplug,
  Upload,
  X,
} from "lucide-react";
import {
  API_PREFIX,
  type Credentials,
  type FileEntry,
  type Host,
  type HostInput,
  type Snapshot,
  type Task,
  type TerminalInfo,
} from "../shared/types.ts";
import { api, ApiError, bytes, parentPath, remoteJoin } from "./api.ts";
import { HostDialog } from "./HostDialog.tsx";
import { CommandBar, CommandLibraryPanel } from "./Commands.tsx";
import {
  TerminalView,
  type TerminalHandle,
  type TerminalStatus,
} from "./TerminalView.tsx";
import { ConfirmDialog, Modal } from "./components/Modal.tsx";
import { FileContextMenu, FileEntryIcon } from "./components/FileIcons.tsx";
import { HostSwitcher } from "./components/HostSwitcher.tsx";
import {
  SshImportDialog,
  type SshImportCandidate,
} from "./components/SshImportDialog.tsx";
import "./style.css";

const empty: Snapshot = {
  hosts: [],
  connections: [],
  tasks: [],
  terminals: [],
  tunnels: [],
  sessions: [],
  grants: [],
  mode: "standalone",
};
const remembered = (key: string, fallback = "") => {
  try {
    return localStorage.getItem("rw:" + key) ?? fallback;
  } catch {
    return fallback;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem("rw:" + key, value);
  } catch {}
};
const authLabel = (host: Host) =>
  host.auth === "agent"
    ? "SSH Agent"
    : host.auth === "key"
      ? "密钥认证"
      : "密码认证";
const statusLabel: Record<Task["status"], string> = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  unknown: "待核对",
};
const sortFiles = (
  list: FileEntry[],
  key: "name" | "size" | "modified",
  direction: 1 | -1,
) =>
  [...list].sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (b.type === "directory" && a.type !== "directory") return 1;
    const value =
      key === "name"
        ? a.name.localeCompare(b.name, "zh-CN", { numeric: true })
        : key === "size"
          ? a.size - b.size
          : a.modified - b.modified;
    return value * direction;
  });
interface Dialog {
  title: string;
  description?: string;
  initial?: string;
  placeholder?: string;
  danger?: boolean;
  confirm: string;
  action(value: string): Promise<void>;
  input?: boolean;
  password?: boolean;
}

export function App({
  onBack,
  onOpenFile,
  onFocus,
}: {
  onBack?: () => void;
  /** Open a remote file in the native right sidebar (DSH surface). */
  onOpenFile?: (hostId: string, path: string) => void;
  onFocus?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [loaded, setLoaded] = useState(false);
  const [hostId, setHostId] = useState(remembered("host"));
  const [hostDialog, setHostDialog] = useState<{
    host?: Host | Partial<HostInput>;
  }>();
  const [sshImport, setSshImport] = useState<{
    hosts: SshImportCandidate[];
    skipped: string[];
  }>();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [directory, setDirectory] = useState("/");
  const [pathDraft, setPathDraft] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [lastAnchor, setLastAnchor] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [fileSort, setFileSort] = useState<{
    key: "name" | "size" | "modified";
    direction: 1 | -1;
  }>({ key: "name", direction: 1 });
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [busyHost, setBusyHost] = useState("");
  const [activeTerminal, setActiveTerminal] = useState("");
  const [terminalStatus, setTerminalStatus] = useState<
    Record<string, TerminalStatus>
  >({});
  const [terminalNames, setTerminalNames] = useState<Record<string, string>>({});
  const [editingTermId, setEditingTermId] = useState("");
  const [editingTermName, setEditingTermName] = useState("");
  const [terminalSelection, setTerminalSelection] = useState("");
  const [termSearchOpen, setTermSearchOpen] = useState(false);
  const [termSearchQuery, setTermSearchQuery] = useState("");
  const [termSearchMatch, setTermSearchMatch] = useState<{
    current: number;
    total: number;
  }>();
  const [commandDraft, setCommandDraft] = useState("");
  const [commandLibrary, setCommandLibrary] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskFilter, setTaskFilter] = useState<"all" | "running" | "issue">(
    "all",
  );
  const [taskDetail, setTaskDetail] = useState<Task>();
  const [dialog, setDialog] = useState<Dialog>();
  const [bulkDelete, setBulkDelete] = useState<string[]>();
  const [trust, setTrust] = useState<{
    hostId: string;
    address: string;
    fingerprint: string;
    algorithm: string;
    resumeHostId?: string;
  }>();
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry;
  }>();
  const [dragging, setDragging] = useState(false);
  const [tunnelOpen, setTunnelOpen] = useState(false);
  const [fileWidth, setFileWidth] = useState(280);
  const uploadRef = useRef<HTMLInputElement>(null);
  const terminalRefs = useRef(new Map<string, TerminalHandle>());
  const switchButtonRef = useRef<HTMLButtonElement>(null);
  const requestVersion = useRef(0);
  const selectedHostRef = useRef(hostId);
  selectedHostRef.current = hostId;
  const filePaneRef = useRef<HTMLDivElement>(null);
  const host = snapshot.hosts.find((h) => h.id === hostId);
  const connected =
    snapshot.connections.find((s) => s.hostId === hostId)?.status ===
    "connected";
  const hostTerminals = snapshot.terminals.filter((t) => t.hostId === hostId);
  const currentTerminal =
    hostTerminals.find((t) => t.id === activeTerminal) ?? hostTerminals.at(-1);
  const runningTasks = snapshot.tasks.filter((t) => t.status === "running");
  const issueTasks = snapshot.tasks.filter(
    (t) => t.status === "failed" || t.status === "unknown",
  );
  const filteredTasks = snapshot.tasks.filter((t) =>
    taskFilter === "running"
      ? t.status === "running"
      : taskFilter === "issue"
        ? t.status === "failed" || t.status === "unknown"
        : true,
  );
  const filteredEntries = useMemo(() => {
    const list = entries.filter(
      (e) =>
        (showHidden || !e.name.startsWith(".")) &&
        e.name.toLowerCase().includes(fileQuery.toLowerCase()),
    );
    return sortFiles(list, fileSort.key, fileSort.direction);
  }, [entries, showHidden, fileQuery, fileSort]);
  const fileBreadcrumbs = useMemo(() => {
    const parts = directory.split("/").filter(Boolean);
    const list = [{ label: "/", path: "/" }];
    let current = "";
    for (const part of parts) {
      current += "/" + part;
      list.push({ label: part, path: current });
    }
    return list;
  }, [directory]);
  const toast = useCallback(
    (text: string, error = false) => setNotice({ text, error }),
    [],
  );
  const failure = useCallback(
    (error: unknown) =>
      toast(error instanceof Error ? error.message : "操作失败", true),
    [toast],
  );
  const refresh = useCallback(async () => {
    const value = await api.get<Snapshot>("/snapshot");
    setSnapshot(value);
    return value;
  }, []);
  useEffect(() => {
    let disposed = false;
    api
      .init()
      .then((value) => {
        if (disposed) return;
        setSnapshot(value);
        setLoaded(true);
        if (!value.hosts.some((h) => h.id === hostId))
          setHostId(value.hosts[0]?.id ?? "");
      })
      .catch(failure);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh().catch(failure);
    }, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(
      () => setNotice(undefined),
      notice.error ? 8000 : 4000,
    );
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  const loadFiles = useCallback(
    async (id: string, path: string) => {
      const version = ++requestVersion.current;
      setLoadingFiles(true);
      try {
        const value = await api.get<{ path: string; entries: FileEntry[] }>(
          "/files",
          { hostId: id, path },
        );
        if (
          version !== requestVersion.current ||
          selectedHostRef.current !== id
        )
          return;
        setEntries(value.entries);
        setDirectory(value.path);
        setPathDraft(value.path);
        setSelection([]);
        remember("path:" + id, value.path);
      } catch (error) {
        if (version === requestVersion.current) failure(error);
      } finally {
        if (version === requestVersion.current) setLoadingFiles(false);
      }
    },
    [failure],
  );
  useEffect(() => {
    remember("host", hostId);
    setEntries([]);
    setSelection([]);
    setFileQuery("");
    requestVersion.current++;
    const h = snapshot.hosts.find((h) => h.id === hostId);
    const path = remembered("path:" + hostId, h?.rootPath ?? "/");
    setDirectory(path);
    setPathDraft(path);
    if (
      h &&
      snapshot.connections.find((c) => c.hostId === hostId)?.status ===
        "connected"
    )
      void loadFiles(hostId, path);
    setActiveTerminal(remembered("terminal:" + hostId));
  }, [hostId, loaded]);
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (e) {
      failure(e);
    }
  };
  const chooseHost = (id: string) => {
    if (id !== hostId) setHostId(id);
  };
  const toggleSwitcher = () => {
    if (switcherOpen) {
      closeSwitcher();
      return;
    }
    setSwitcherOpen(true);
  };
  // Closing returns focus to the trigger, like a DSH menu.
  const closeSwitcher = () => {
    setSwitcherOpen(false);
    switchButtonRef.current?.focus();
  };
  const importSshConfig = () => {
    setSwitcherOpen(false);
    void run(async () => {
      const value = await api.post<{
        hosts: SshImportCandidate[];
        skipped: string[];
      }>("/ssh/import", {});
      if (!value.hosts.length) {
        toast("没有找到可导入的明确 Host 配置");
        return;
      }
      if (value.hosts.length === 1) {
        const first = value.hosts[0]!;
        setHostDialog({
          host: {
            ...first,
            auth:
              first.auth === "agent" || !first.auth
                ? first.privateKeyPath
                  ? "key"
                  : "password"
                : first.auth,
          },
        });
        toast("发现 1 个配置，确认后保存");
      } else {
        setSshImport({ hosts: value.hosts, skipped: value.skipped ?? [] });
      }
    });
  };
  const openTerminal = async (id = hostId, cwd = directory) => {
    const t = await api.post<TerminalInfo>("/terminals/create", {
      hostId: id,
      cwd,
    });
    setActiveTerminal(t.id);
    remember("terminal:" + id, t.id);
    await refresh();
    return t;
  };
  const connectHost = async (
    id: string,
    credentials?: Credentials,
    credentialHostId = id,
  ) => {
    setBusyHost(id);
    try {
      if (credentials)
        await api.post("/credentials", {
          hostId: credentialHostId,
          credentials,
        });
      await api.post("/connect", { hostId: id });
      const next = await refresh();
      if (selectedHostRef.current === id) {
        const h = next.hosts.find((h) => h.id === id)!;
        const cwd = remembered("path:" + id, h.rootPath);
        await loadFiles(id, cwd);
        if (
          !next.terminals.some((t) => t.hostId === id && t.status === "running")
        )
          await openTerminal(id, cwd);
      }
      toast("连接已就绪");
    } catch (error) {
      if (error instanceof ApiError && error.code === "HOST_KEY_UNKNOWN")
        setTrust({ ...error.details, resumeHostId: id } as never);
      else if (
        error instanceof ApiError &&
        error.code === "CREDENTIAL_REQUIRED"
      )
        setDialog({
          title: "输入连接密码",
          description:
            "密码将安全保存到 DSH 凭据库，重连自动复用，随时可在编辑连接中忘记。",
          confirm: "连接",
          input: true,
          password: true,
          action: async (password) =>
            connectHost(id, { password }, String(error.details?.hostId ?? id)),
        });
      else failure(error);
      await refresh();
    } finally {
      setBusyHost("");
    }
  };
  const saveHost = async (input: HostInput, credentials: Credentials) => {
    const saved = await api.post<Host>("/hosts/save", input);
    await refresh();
    chooseHost(saved.id);
    if (credentials.password || credentials.passphrase)
      await connectHost(saved.id, credentials);
  };
  /** Files never open inside the workbench: they open in the native right sidebar. */
  const openFile = (entry: FileEntry) => {
    if (entry.type === "directory") {
      void loadFiles(hostId, entry.path);
      return;
    }
    if (!onOpenFile) {
      toast("当前宿主没有右侧栏，无法打开文件", true);
      return;
    }
    onOpenFile(hostId, entry.path);
  };
  const upload = async (files: FileList | File[]) => {
    if (!host) return;
    const id = host.id;
    const path = directory;
    const values = Array.from(files);
    for (const file of values) {
      try {
        await api.upload(id, remoteJoin(path, file.name), file);
        toast(`${file.name} 上传完成`);
      } catch (e) {
        failure(e);
      }
    }
    await refresh();
    if (selectedHostRef.current === id) await loadFiles(id, path);
  };
  const fileActions = (entry: FileEntry) => (
    <>
      <button onClick={() => openFile(entry)}>
        {entry.type === "directory" ? (
          <FolderOpen size={14} />
        ) : (
          <Pencil size={14} />
        )}{" "}
        {entry.type === "directory" ? "打开目录" : "在右侧栏打开"}
      </button>
      <button
        onClick={() => {
          void navigator.clipboard
            .writeText(entry.path)
            .then(() => toast("路径已复制"))
            .catch(failure);
        }}
      >
        <Copy size={14} />
        复制路径
      </button>
      {entry.type !== "directory" && (
        <button
          onClick={() => {
            window.open(
              API_PREFIX +
                "/download?" +
                new URLSearchParams({ hostId, path: entry.path }),
              "_self",
            );
          }}
        >
          <ArrowDownToLine size={14} />
          下载文件
        </button>
      )}
      <div className="rw-menu-sep" />
      <button
        onClick={() => {
          const boundId = hostId;
          setDialog({
            title: "重命名",
            description: entry.path,
            input: true,
            initial: entry.name,
            confirm: "重命名",
            action: async (name) => {
              if (!name || /[\/\0]/.test(name))
                throw new Error("名称不能为空，也不能包含斜杠");
              await api.post("/files/rename", {
                hostId: boundId,
                path: entry.path,
                target: remoteJoin(parentPath(entry.path), name),
                hostRevision: host?.revision,
              });
              if (selectedHostRef.current === boundId)
                await loadFiles(boundId, directory);
            },
          });
        }}
      >
        <Pencil size={14} />
        重命名
      </button>
      <button
        onClick={() => {
          const boundId = hostId;
          const boundRev = host?.revision;
          setDialog({
            title: "复制到…",
            description: entry.path,
            input: true,
            initial: entry.name + ".bak",
            placeholder: "目标文件名或绝对路径",
            confirm: "复制",
            action: async (name) => {
              const target = name.trim().startsWith("/")
                ? name.trim()
                : remoteJoin(directory, name.trim());
              await api.post("/files/copy", {
                hostId: boundId,
                path: entry.path,
                target,
                hostRevision: boundRev,
              });
              if (selectedHostRef.current === boundId)
                await loadFiles(boundId, directory);
            },
          });
        }}
      >
        <Copy size={14} />
        复制到…
      </button>
      <button
        onClick={() => {
          const boundId = hostId;
          const boundRev = host?.revision;
          setDialog({
            title: "修改权限",
            description: entry.path,
            input: true,
            initial: entry.mode.replace(/^0+/, "") || "644",
            placeholder: "例如 644 或 0755",
            confirm: "保存权限",
            action: async (mode) => {
              if (!/^[0-7]{3,4}$/.test(mode.trim()))
                throw new Error("请输入 3 或 4 位八进制权限，例如 644 或 0755");
              await api.post("/files/chmod", {
                hostId: boundId,
                path: entry.path,
                mode: mode.trim(),
                hostRevision: boundRev,
              });
              if (selectedHostRef.current === boundId)
                await loadFiles(boundId, directory);
            },
          });
        }}
      >
        <ShieldAlert size={14} />
        修改权限
      </button>
      <button
        className="danger"
        onClick={() => {
          const boundId = hostId;
          setDialog({
            title: "删除远程项目？",
            description: `${host?.name} · ${entry.path}${entry.type === "directory" ? "\n仅支持删除空目录。" : ""}`,
            confirm: "删除",
            danger: true,
            action: async () => {
              await api.post("/files/remove", {
                hostId: boundId,
                path: entry.path,
              });
              if (selectedHostRef.current === boundId)
                await loadFiles(boundId, directory);
            },
          });
        }}
      >
        <Trash2 size={14} />
        删除
      </button>
    </>
  );
  const resize = (e: React.PointerEvent) => {
    const start = e.clientX;
    const width = fileWidth;
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) =>
      setFileWidth(Math.max(220, Math.min(460, width + event.clientX - start)));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };

  return (
    <div className="rw-workbench">
      <main className="rw-main">
        <header className="rw-topbar">
          <div className="rw-topbar-brand" title="AI 远程工作台">
            <span className="rw-brand-mark">
              <TerminalSquare size={18} />
            </span>
            <span className="rw-brand-word">
              远程<span>工作台</span>
            </span>
          </div>
          <span className="rw-topbar-sep" aria-hidden="true" />
          <div className="rw-identity">
            <div className="rw-identity-name">
              {host ? (
                <h1>
                  <button
                    ref={switchButtonRef}
                    className="rw-host-switch"
                    aria-haspopup="dialog"
                    aria-expanded={switcherOpen}
                    aria-controls="rw-host-switcher"
                    title="切换服务器"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={toggleSwitcher}
                  >
                    <span className="rw-host-switch-name">{host.name}</span>
                    <ChevronDown
                      size={14}
                      aria-hidden="true"
                      className={
                        "rw-switch-caret" + (switcherOpen ? " open" : "")
                      }
                    />
                  </button>
                </h1>
              ) : (
                <button
                  ref={switchButtonRef}
                  className="rw-host-switch rw-host-switch-empty"
                  aria-haspopup="dialog"
                  aria-expanded={switcherOpen}
                  aria-controls="rw-host-switcher"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={toggleSwitcher}
                >
                  <Server size={14} />
                  <span className="rw-host-switch-name">选择服务器</span>
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={
                      "rw-switch-caret" + (switcherOpen ? " open" : "")
                    }
                  />
                </button>
              )}
              {host && (
                <span
                  className={
                    "rw-connection-pill " +
                    (connected ? "connected " : "") +
                    (busyHost === hostId ? "connecting" : "")
                  }
                >
                  <i />
                  {connected
                    ? "已连接"
                    : busyHost === hostId
                      ? "连接中"
                      : "未连接"}
                </span>
              )}
              {host?.group && (
                <span
                  className={
                    "rw-env " +
                    (host.group.includes("生产") ? "production" : "")
                  }
                >
                  {host.group}
                </span>
              )}
            </div>
            <p className="rw-identity-meta">
              {host ? (
                <>
                  <span className="rw-identity-addr">
                    {host.username}@{host.address}:{host.port}
                  </span>
                  <span className="rw-meta-dot">·</span>
                  <span>{authLabel(host)}</span>
                  {host.jumpHostId && (
                    <>
                      <span className="rw-meta-dot">·</span>
                      <span>经跳板机</span>
                    </>
                  )}
                </>
              ) : (
                <span>
                  {loaded
                    ? "添加一台服务器，文件、终端与 AI 从这里开始"
                    : "正在读取本机连接…"}
                </span>
              )}
            </p>
            {switcherOpen && (
              <HostSwitcher
                id="rw-host-switcher"
                ariaLabel="切换服务器"
                hosts={snapshot.hosts}
                connections={snapshot.connections}
                currentHostId={hostId}
                onSelect={(value) => {
                  closeSwitcher();
                  chooseHost(value.id);
                }}
                onConnect={(value) => {
                  closeSwitcher();
                  void connectHost(value.id);
                }}
                onNew={() => {
                  closeSwitcher();
                  setHostDialog({});
                }}
                onImport={importSshConfig}
                onEditHost={(value) => {
                  closeSwitcher();
                  setHostDialog({ host: value });
                }}
                onEditCurrent={
                  host
                    ? () => {
                        closeSwitcher();
                        setHostDialog({ host });
                      }
                    : undefined
                }
                onTunnel={
                  host
                    ? () => {
                        closeSwitcher();
                        setTunnelOpen(true);
                      }
                    : undefined
                }
                onClose={closeSwitcher}
              />
            )}
          </div>
          {host && (
            <div className="rw-connection-actions">
              <button
                className="rw-icon"
                title="编辑连接"
                aria-label="编辑连接"
                onClick={() => setHostDialog({ host })}
              >
                <Settings2 size={15} />
              </button>
              <button
                className="rw-icon"
                title="端口隧道"
                aria-label="端口隧道"
                onClick={() => setTunnelOpen(true)}
              >
                <Link2 size={15} />
              </button>
              {connected ? (
                <button
                  className="rw-button"
                  onClick={() => {
                    void run(async () => {
                      await api.post("/disconnect", { hostId });
                      await refresh();
                    });
                  }}
                >
                  <Unplug size={14} />
                  断开
                </button>
              ) : (
                <button
                  className="rw-button primary"
                  disabled={!!busyHost}
                  onClick={() => {
                    void connectHost(hostId);
                  }}
                >
                  {busyHost === hostId ? (
                    <LoaderCircle size={14} className="rw-spin" />
                  ) : (
                    <PlugZap size={14} />
                  )}
                  {busyHost === hostId ? "连接中" : "连接"}
                </button>
              )}
            </div>
          )}
          <div className="rw-topbar-actions">
            {onFocus && (
              <button
                className="rw-icon"
                aria-label="切换宽阔视图"
                title="收起 DSH 侧栏，扩大工作区"
                onClick={onFocus}
              >
                <Maximize2 size={15} />
              </button>
            )}
            {onBack && (
              <button className="rw-topbar-back" onClick={onBack}>
                <ArrowLeft size={14} />
                <span>返回 DSH</span>
              </button>
            )}
          </div>
        </header>
        {!host ? (
          <div className="rw-welcome">
            <div className="rw-welcome-icon">
              <TerminalSquare size={22} />
            </div>
            <h1>连接一台服务器</h1>
            <p>
              文件、终端与 AI 协作共用同一条 SSH
              连接。配置一次，之后从顶部切换服务器即可继续工作。
            </p>
            <button
              className="rw-button primary large"
              onClick={() => setHostDialog({})}
            >
              <Plus size={16} />
              新建 SSH 连接
            </button>
            <ul className="rw-welcome-features">
              <li>
                <Files size={16} />
                <div>
                  <strong>文件与终端同屏</strong>
                  <small>浏览、编辑与命令操作保持连续，不打断远端会话。</small>
                </div>
              </li>
              <li>
                <Sparkles size={16} />
                <div>
                  <strong>选中即交给 AI</strong>
                  <small>把文件、目录或终端输出引用到 DSH 会话上下文。</small>
                </div>
              </li>
              <li>
                <ShieldCheck size={16} />
                <div>
                  <strong>授权与结果可核对</strong>
                  <small>指纹核对、会话授权与操作记录都保留在工作台内。</small>
                </div>
              </li>
            </ul>
          </div>
        ) : (
          <div
            className="rw-workspace"
            style={
              { "--rw-file-width": fileWidth + "px" } as React.CSSProperties
            }
          >
            <section
              className="rw-files"
              ref={filePaneRef}
              onDragOver={(e) => {
                if (connected) {
                  e.preventDefault();
                  setDragging(true);
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node))
                  setDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (connected && e.dataTransfer.files.length)
                  void upload(e.dataTransfer.files);
              }}
            >
              <div className="rw-pane-heading">
                <span>
                  <FolderOpen size={15} />
                  远程文件
                </span>
                <div>
                  <button
                    className="rw-icon"
                    aria-label="显示隐藏文件"
                    title="显示隐藏文件"
                    onClick={() => setShowHidden((v) => !v)}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  <button
                    className="rw-icon"
                    disabled={!connected}
                    aria-label="刷新文件"
                    onClick={() => {
                      void loadFiles(hostId, directory);
                    }}
                  >
                    <RefreshCw
                      size={13}
                      className={loadingFiles ? "rw-spin" : ""}
                    />
                  </button>
                </div>
              </div>
              {connected && (
                <div className="rw-file-crumbs">
                  {fileBreadcrumbs.map((crumb, idx) => (
                    <span key={crumb.path}>
                      {idx > 0 && <span className="rw-crumb-sep">/</span>}
                      <button
                        type="button"
                        onClick={() => void loadFiles(hostId, crumb.path)}
                      >
                        {crumb.label}
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <form
                className="rw-path"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (connected) void loadFiles(hostId, pathDraft);
                }}
              >
                <button
                  type="button"
                  className="rw-icon"
                  title="上一级"
                  aria-label="上一级"
                  disabled={!connected || directory === "/"}
                  onClick={() => {
                    void loadFiles(hostId, parentPath(directory));
                  }}
                >
                  <ArrowUp size={13} />
                </button>
                <input
                  aria-label="远程目录"
                  value={pathDraft}
                  disabled={!connected}
                  onChange={(e) => setPathDraft(e.target.value)}
                />
                <span>↵</span>
              </form>
              <div className="rw-file-toolbar">
                <button
                  disabled={!connected}
                  onClick={() => uploadRef.current?.click()}
                >
                  <Upload size={13} />
                  上传
                </button>
                <button
                  className="rw-icon"
                  aria-label="新建文件"
                  title="新建文件"
                  disabled={!connected}
                  onClick={() => {
                    const id = hostId;
                    const cwd = directory;
                    const rev = host?.revision;
                    setDialog({
                      title: "新建文件",
                      input: true,
                      placeholder: "例如 notes.md",
                      confirm: "创建",
                      action: async (name) => {
                        if (!name || /[\/\0]/.test(name))
                          throw new Error("请输入有效的文件名称");
                        await api.post("/files/create", {
                          hostId: id,
                          path: remoteJoin(cwd, name),
                          content: "",
                          hostRevision: rev,
                        });
                        if (selectedHostRef.current === id)
                          await loadFiles(id, cwd);
                      },
                    });
                  }}
                >
                  <FilePlus size={14} />
                </button>
                <button
                  className="rw-icon"
                  aria-label="新建文件夹"
                  title="新建文件夹"
                  disabled={!connected}
                  onClick={() => {
                    const id = hostId;
                    const cwd = directory;
                    setDialog({
                      title: "新建文件夹",
                      input: true,
                      placeholder: "文件夹名称",
                      confirm: "创建",
                      action: async (name) => {
                        if (!name || /[\/\0]/.test(name))
                          throw new Error("请输入有效的目录名称");
                        await api.post("/files/mkdir", {
                          hostId: id,
                          path: remoteJoin(cwd, name),
                        });
                        if (selectedHostRef.current === id)
                          await loadFiles(id, cwd);
                      },
                    });
                  }}
                >
                  <FolderPlus size={14} />
                </button>
                <button
                  className="rw-icon"
                  aria-label="排序"
                  title={`排序：${fileSort.key === "name" ? "名称" : fileSort.key === "size" ? "大小" : "时间"}`}
                  onClick={() =>
                    setFileSort((prev) =>
                      prev.key === "name"
                        ? { key: "modified", direction: -1 }
                        : prev.key === "modified"
                          ? { key: "size", direction: -1 }
                          : { key: "name", direction: 1 },
                    )
                  }
                >
                  <ArrowUpDown size={13} />
                </button>
                <div className="rw-file-search">
                  <Search size={12} />
                  <input
                    aria-label="筛选文件"
                    placeholder="筛选…"
                    value={fileQuery}
                    onChange={(e) => setFileQuery(e.target.value)}
                  />
                </div>
              </div>
              <div
                className="rw-file-list"
                role="listbox"
                aria-label="远程文件列表"
                aria-multiselectable="true"
              >
                {!connected ? (
                  <div className="rw-file-empty">
                    <Folder size={32} />
                    <p>连接后浏览远程文件</p>
                  </div>
                ) : filteredEntries.length === 0 ? (
                  <div className="rw-file-empty">
                    <FolderOpen size={28} />
                    <p>
                      {loadingFiles ? "正在读取目录…" : "这个目录暂时没有文件"}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="rw-file-columns">
                      <span>名称</span>
                      <span>大小</span>
                    </div>
                    {filteredEntries.map((entry) => (
                      <div
                        key={entry.path}
                        role="option"
                        aria-selected={selection.includes(entry.path)}
                        tabIndex={0}
                        className={
                          "rw-file-row " +
                          (selection.includes(entry.path) ? "selected" : "")
                        }
                        onClick={(e) => {
                          if (e.shiftKey && lastAnchor) {
                            const paths = filteredEntries.map((v) => v.path);
                            const a = paths.indexOf(lastAnchor);
                            const b = paths.indexOf(entry.path);
                            if (a >= 0 && b >= 0) {
                              const [from, to] = a < b ? [a, b] : [b, a];
                              setSelection(paths.slice(from, to + 1));
                              return;
                            }
                          }
                          setLastAnchor(entry.path);
                          setSelection((prev) =>
                            e.metaKey || e.ctrlKey
                              ? prev.includes(entry.path)
                                ? prev.filter((p) => p !== entry.path)
                                : [...prev, entry.path]
                              : [entry.path],
                          );
                        }}
                        onDoubleClick={() => openFile(entry)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            openFile(entry);
                          } else if (
                            e.key === "Backspace" &&
                            directory !== "/"
                          ) {
                            e.preventDefault();
                            void loadFiles(hostId, parentPath(directory));
                          } else if (
                            e.key === "ArrowDown" ||
                            e.key === "ArrowUp"
                          ) {
                            e.preventDefault();
                            const rows = Array.from(
                              e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                                "[role='option']",
                              ) ?? [],
                            );
                            const idx = rows.indexOf(e.currentTarget);
                            const nextIdx =
                              e.key === "ArrowDown"
                                ? Math.min(rows.length - 1, idx + 1)
                                : Math.max(0, idx - 1);
                            const nextEl = rows[nextIdx];
                            const nextEntry = filteredEntries[nextIdx];
                            if (nextEl && nextEntry) {
                              nextEl.focus();
                              setSelection([nextEntry.path]);
                              setLastAnchor(nextEntry.path);
                            }
                          } else if (
                            e.key === "ContextMenu" ||
                            (e.shiftKey && e.key === "F10")
                          ) {
                            e.preventDefault();
                            const rect =
                              e.currentTarget.getBoundingClientRect();
                            setContextMenu({
                              x: rect.left + 35,
                              y: rect.bottom,
                              entry,
                            });
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setSelection([entry.path]);
                          setContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            entry,
                          });
                        }}
                      >
                        <span className="rw-file-name">
                          <FileEntryIcon entry={entry} size={15} />
                          <span>{entry.name}</span>
                          {entry.type === "symlink" && <Link2 size={10} />}
                        </span>
                        <span className="rw-file-size">
                          {entry.type === "directory" ? "—" : bytes(entry.size)}
                        </span>
                        {entry.type !== "directory" && (
                          <button
                            className="rw-file-ai"
                            title="在右侧栏打开"
                            aria-label={`在右侧栏打开 ${entry.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              openFile(entry);
                            }}
                          >
                            <ArrowUpRight size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
              <div className="rw-file-footer">
                <span>
                  {entries.length} 个项目
                  {selection.length > 0 ? ` · 已选 ${selection.length}` : ""}
                </span>
              </div>
              {selection.length > 0 && connected && (
                <div className="rw-selection-actions">
                  {selection.length === 1 ? (
                    <>
                      <button
                        onClick={() => {
                          const entry = entries.find(
                            (e) => e.path === selection[0],
                          );
                          if (entry) openFile(entry);
                        }}
                      >
                        <ArrowUpRight size={13} />
                        在右侧栏打开
                      </button>
                      <button
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          const entry = entries.find(
                            (f) => f.path === selection[0],
                          );
                          if (entry)
                            setContextMenu({
                              x: r.left,
                              y: r.bottom,
                              entry,
                            });
                        }}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(selection.join("\n"))
                            .then(() =>
                              toast(`已复制 ${selection.length} 条路径`),
                            )
                            .catch(failure);
                        }}
                      >
                        <Copy size={13} />
                        复制路径
                      </button>
                      <button
                        className="danger"
                        onClick={() => setBulkDelete([...selection])}
                      >
                        <Trash2 size={13} />
                        批量删除 ({selection.length})
                      </button>
                      <button
                        title="取消选择"
                        aria-label="取消选择"
                        onClick={() => setSelection([])}
                      >
                        <X size={13} />
                      </button>
                    </>
                  )}
                </div>
              )}
              {dragging && (
                <div className="rw-drop-overlay">
                  <Upload size={28} />
                  <strong>松开，上传到当前目录</strong>
                  <span>{directory}</span>
                </div>
              )}
              <input
                type="file"
                multiple
                ref={uploadRef}
                hidden
                onChange={(e) => {
                  if (e.target.files) void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </section>
            <div
              className="rw-divider"
              role="separator"
              aria-label="调整文件面板宽度"
              aria-orientation="vertical"
              onPointerDown={resize}
            />
            <section className="rw-editor-terminal">
              <div className="rw-terminal-section">
                <div className="rw-terminal-tabs">
                  <div className="rw-terminal-tab-list">
                    {hostTerminals.length ? (
                      hostTerminals.map((t, n) => {
                        const label =
                          terminalNames[t.id] ||
                          remembered("term-name:" + t.id) ||
                          `终端 ${n + 1}`;
                        return (
                          <div
                            key={t.id}
                            className={
                              "rw-terminal-tab " +
                              (currentTerminal?.id === t.id ? "active" : "")
                            }
                          >
                            {editingTermId === t.id ? (
                              <input
                                className="rw-terminal-rename"
                                autoFocus
                                value={editingTermName}
                                onChange={(e) =>
                                  setEditingTermName(e.target.value)
                                }
                                onBlur={() => {
                                  const next = editingTermName.trim();
                                  if (next) {
                                    setTerminalNames((prev) => ({
                                      ...prev,
                                      [t.id]: next,
                                    }));
                                    remember("term-name:" + t.id, next);
                                  }
                                  setEditingTermId("");
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.currentTarget.blur();
                                  } else if (e.key === "Escape") {
                                    setEditingTermId("");
                                  }
                                }}
                              />
                            ) : (
                              <button
                                onClick={() => {
                                  setActiveTerminal(t.id);
                                  remember("terminal:" + hostId, t.id);
                                }}
                                onDoubleClick={() => {
                                  setEditingTermId(t.id);
                                  setEditingTermName(label);
                                }}
                                title="双击重命名终端标签"
                              >
                                <TerminalSquare size={13} />
                                <span>{label}</span>
                                {t.status === "running" && <i />}
                              </button>
                            )}
                            <button
                              aria-label={`关闭${label}`}
                              onClick={() => {
                                if (t.status === "exited") {
                                  void run(async () => {
                                    await api.post("/terminals/close", {
                                      id: t.id,
                                    });
                                    await refresh();
                                  });
                                  return;
                                }
                                setDialog({
                                  title: "关闭远程终端？",
                                  description:
                                    "关闭会请求结束远端 Shell；收起或切换面板可保留会话。",
                                  confirm: "关闭终端",
                                  action: async () => {
                                    await api.post("/terminals/close", {
                                      id: t.id,
                                    });
                                    await refresh();
                                  },
                                });
                              }}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        );
                      })
                    ) : (
                      <div className="rw-terminal-label">
                        <TerminalSquare size={14} />
                        终端
                      </div>
                    )}
                    <button
                      className="rw-terminal-add"
                      aria-label="新建终端"
                      disabled={!connected}
                      onClick={() => {
                        void run(() => openTerminal());
                      }}
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                  <div className="rw-terminal-tools">
                    {currentTerminal && terminalSelection && (
                      <button
                        type="button"
                        title="复制终端选中文本"
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(terminalSelection)
                            .then(() => toast("已复制终端选中内容"))
                            .catch(failure);
                        }}
                      >
                        <Copy size={12} />
                        复制选中
                      </button>
                    )}
                    {currentTerminal && (
                      <>
                        <button
                          type="button"
                          aria-label="查找终端输出"
                          title="查找终端输出"
                          onClick={() => setTermSearchOpen((v) => !v)}
                        >
                          <Search size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label="清屏"
                          title="清空当前终端屏幕"
                          onClick={() =>
                            terminalRefs.current.get(currentTerminal.id)?.clear()
                          }
                        >
                          <Eraser size={13} />
                        </button>
                      </>
                    )}
                    <span className="rw-terminal-mode">SSH</span>
                  </div>
                </div>
                {termSearchOpen && currentTerminal && (
                  <form
                    className="rw-term-search"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const res = terminalRefs.current
                        .get(currentTerminal.id)
                        ?.find(termSearchQuery, "next");
                      if (res)
                        setTermSearchMatch({
                          current: res.current,
                          total: res.total,
                        });
                    }}
                  >
                    <Search size={12} />
                    <input
                      autoFocus
                      aria-label="搜索终端输出"
                      placeholder="搜索终端缓冲区…"
                      value={termSearchQuery}
                      onChange={(e) => {
                        const q = e.target.value;
                        setTermSearchQuery(q);
                        if (!q) {
                          setTermSearchMatch(undefined);
                          return;
                        }
                        const res = terminalRefs.current
                          .get(currentTerminal.id)
                          ?.find(q, "next");
                        if (res)
                          setTermSearchMatch({
                            current: res.current,
                            total: res.total,
                          });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setTermSearchOpen(false);
                      }}
                    />
                    {termSearchMatch && (
                      <span className="rw-term-search-count">
                        {termSearchMatch.current}/{termSearchMatch.total}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label="上一个匹配"
                      onClick={() => {
                        const res = terminalRefs.current
                          .get(currentTerminal.id)
                          ?.find(termSearchQuery, "prev");
                        if (res)
                          setTermSearchMatch({
                            current: res.current,
                            total: res.total,
                          });
                      }}
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label="下一个匹配"
                      onClick={() => {
                        const res = terminalRefs.current
                          .get(currentTerminal.id)
                          ?.find(termSearchQuery, "next");
                        if (res)
                          setTermSearchMatch({
                            current: res.current,
                            total: res.total,
                          });
                      }}
                    >
                      <ChevronDown size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label="关闭搜索"
                      onClick={() => setTermSearchOpen(false)}
                    >
                      <X size={13} />
                    </button>
                  </form>
                )}
                <div className="rw-terminal-body">
                  {snapshot.terminals.map((t) => (
                    <TerminalView
                      key={t.id}
                      id={t.id}
                      visible={t.id === currentTerminal?.id}
                      ref={(handle) => {
                        if (handle) terminalRefs.current.set(t.id, handle);
                        else terminalRefs.current.delete(t.id);
                      }}
                      onSelection={setTerminalSelection}
                      onRestart={() => void run(() => openTerminal())}
                      onStatus={(status) =>
                        setTerminalStatus((prev) =>
                          prev[status.id]?.state === status.state &&
                          prev[status.id]?.writable === status.writable
                            ? prev
                            : { ...prev, [status.id]: status },
                        )
                      }
                    />
                  ))}
                  {!currentTerminal && (
                    <div className="rw-terminal-empty">
                      <div className="rw-terminal-empty-icon">
                        <TerminalSquare size={32} />
                        <i />
                      </div>
                      <h3>
                        {connected
                          ? "打开一个终端，开始工作"
                          : "你的远程空间，准备就绪"}
                      </h3>
                      <p>
                        {connected
                          ? "Shell 与远程文件使用同一个 SSH 连接"
                          : "连接服务器后，在这里运行命令、查看日志"}
                      </p>
                      <button
                        disabled={!!busyHost}
                        onClick={() => {
                          if (connected) void run(() => openTerminal());
                          else void connectHost(hostId);
                        }}
                      >
                        {busyHost ? (
                          <LoaderCircle size={14} className="rw-spin" />
                        ) : (
                          <PlugZap size={14} />
                        )}{" "}
                        {connected ? "新建终端" : "连接服务器"}
                        <ArrowUpRight size={13} />
                      </button>
                      <span className="rw-terminal-empty-caption">
                        文件与终端共用同一条 SSH 连接，双击文件在右侧栏编辑。
                      </span>
                    </div>
                  )}
                </div>
                {currentTerminal && (
                  <CommandBar
                    hostId={hostId}
                    cwd={directory}
                    state={
                      terminalStatus[currentTerminal.id]?.state ?? "connecting"
                    }
                    writable={
                      terminalStatus[currentTerminal.id]?.writable ?? false
                    }
                    value={commandDraft}
                    onValue={setCommandDraft}
                    onSend={(text) => {
                      const handle = terminalRefs.current.get(
                        currentTerminal.id,
                      );
                      return handle?.send(text) ?? false;
                    }}
                    onOpenLibrary={() => setCommandLibrary(true)}
                    onNotice={toast}
                  />
                )}
                <div className="rw-terminal-footer">
                  <span>
                    <i className={connected ? "on" : ""} />
                    {host.username}@{host.address}
                  </span>
                  <span>
                    UTF-8 <span>·</span> xterm-256color
                  </span>
                </div>
                {commandLibrary && currentTerminal && (
                  <CommandLibraryPanel
                    hostId={hostId}
                    onPick={(command) => {
                      setCommandDraft(command);
                      setCommandLibrary(false);
                      terminalRefs.current.get(currentTerminal.id)?.focus();
                    }}
                    onClose={() => setCommandLibrary(false)}
                    onNotice={toast}
                  />
                )}
              </div>
            </section>
          </div>
        )}
        <div className={"rw-taskbar " + (taskOpen ? "expanded" : "")}>
          <button
            className="rw-taskbar-header"
            onClick={() => setTaskOpen((v) => !v)}
          >
            <div>
              <History size={13} />
              <strong>任务与传输</strong>
              {runningTasks.length > 0 ? (
                <span className="rw-task-count">
                  {runningTasks.length} 进行中
                </span>
              ) : issueTasks.length > 0 ? (
                <span className="rw-task-count issue">
                  {issueTasks.length} 项异常
                </span>
              ) : (
                <span>
                  {snapshot.tasks.length
                    ? `${snapshot.tasks.length} 条记录`
                    : "传输与远程操作，清楚可查"}
                </span>
              )}
            </div>
            <div>
              <span className="rw-taskbar-health">
                <i className={issueTasks.length && !runningTasks.length ? "warn" : ""} />
                {runningTasks.length
                  ? "后台任务运行中"
                  : issueTasks.length
                    ? "有异常任务待查看"
                    : "工作台就绪"}
              </span>
              <ChevronDown
                size={13}
                style={{ transform: taskOpen ? "rotate(180deg)" : "" }}
              />
            </div>
          </button>
          {taskOpen && (
            <div className="rw-tasks">
              {snapshot.tasks.length > 0 && (
                <div className="rw-task-filters">
                  {(
                    [
                      { id: "all", label: `全部 (${snapshot.tasks.length})` },
                      {
                        id: "running",
                        label: `进行中 (${runningTasks.length})`,
                      },
                      { id: "issue", label: `异常 (${issueTasks.length})` },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={taskFilter === item.id ? "active" : ""}
                      onClick={() => setTaskFilter(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
              {filteredTasks.length === 0 ? (
                <div className="rw-task-empty">
                  <CheckCheck size={20} />
                  <span>
                    {snapshot.tasks.length
                      ? "当前筛选下没有任务记录"
                      : "上传、下载和 AI 命令会显示在这里"}
                  </span>
                </div>
              ) : (
                filteredTasks.slice(0, 25).map((task) => (
                  <div className="rw-task-row" key={task.id}>
                    <span className={"rw-task-status " + task.status}>
                      {task.status === "running" ? (
                        <LoaderCircle size={14} className="rw-spin" />
                      ) : task.status === "completed" ? (
                        <Check size={14} />
                      ) : (
                        <Circle size={12} />
                      )}
                    </span>
                    <button
                      className="rw-task-name"
                      onClick={() => {
                        void api
                          .get<Task>("/task", { id: task.id })
                          .then(setTaskDetail)
                          .catch(failure);
                      }}
                    >
                      <strong>{task.label}</strong>
                      <small>
                        {task.hostName} ·{" "}
                        {task.kind === "command"
                          ? "远程命令"
                          : task.kind === "upload"
                            ? "上传"
                            : task.kind === "download"
                              ? "下载"
                              : "文件操作"}
                      </small>
                    </button>
                    {task.status === "running" && (
                      <div className="rw-progress">
                        <i style={{ width: task.progress + "%" }} />
                      </div>
                    )}
                    <span className="rw-task-result">
                      {statusLabel[task.status]}
                    </span>
                    <span className="rw-task-time">
                      {new Date(task.createdAt).toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    {task.status === "running" && (
                      <button
                        className="rw-icon"
                        aria-label="取消任务"
                        onClick={() => {
                          void api
                            .post("/tasks/cancel", { id: task.id })
                            .then(refresh)
                            .catch(failure);
                        }}
                      >
                        <Square size={11} />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </main>
      {hostDialog && (
        <HostDialog
          host={hostDialog.host}
          hosts={snapshot.hosts}
          onClose={() => setHostDialog(undefined)}
          onSave={saveHost}
          onForgetCredentials={
            hostDialog.host?.id
              ? async () => {
                  try {
                    await api.post("/credentials/forget", {
                      hostId: hostDialog.host!.id,
                    });
                    toast("已删除保存在 DSH 凭据库中的凭据");
                  } catch (error) {
                    failure(error);
                  }
                }
              : undefined
          }
          onDelete={
            hostDialog.host?.id
              ? () => {
                  const value = hostDialog.host!;
                  setHostDialog(undefined);
                  setDialog({
                    title: "删除这条连接？",
                    description: `${value.name} · ${value.address}\n该连接的终端与隧道将一并关闭。`,
                    danger: true,
                    confirm: "删除连接",
                    action: async () => {
                      await api.post("/hosts/delete", { hostId: value.id });
                      const next = await refresh();
                      if (selectedHostRef.current === value.id)
                        setHostId(next.hosts[0]?.id ?? "");
                    },
                  });
                }
              : undefined
          }
        />
      )}
      {sshImport && (
        <SshImportDialog
          hosts={sshImport.hosts}
          skipped={sshImport.skipped}
          onClose={() => setSshImport(undefined)}
          onImportSelected={async (items) => {
            let firstId = "";
            for (const item of items) {
              const saved = await api.post<Host>("/hosts/save", item);
              if (!firstId) firstId = saved.id;
            }
            await refresh();
            if (firstId) chooseHost(firstId);
            toast(`已导入 ${items.length} 个主机配置`);
          }}
          onEditOne={(candidate) => {
            setSshImport(undefined);
            setHostDialog({ host: candidate });
          }}
        />
      )}
      {bulkDelete && (
        <ConfirmDialog
          title={`批量删除 ${bulkDelete.length} 个远程项目？`}
          description={`将删除所选的 ${bulkDelete.length} 个文件/空目录，删除后无法恢复。`}
          confirm="全部删除"
          danger
          onClose={() => setBulkDelete(undefined)}
          onConfirm={async () => {
            const targets = bulkDelete;
            const boundId = hostId;
            setBulkDelete(undefined);
            for (const p of targets) {
              try {
                await api.post("/files/remove", { hostId: boundId, path: p });
              } catch (e) {
                failure(e);
              }
            }
            if (selectedHostRef.current === boundId)
              await loadFiles(boundId, directory);
          }}
        />
      )}
      {dialog && (
        <ActionDialog dialog={dialog} onClose={() => setDialog(undefined)} />
      )}
      {trust && (
        <Modal
          ariaLabel="核对服务器指纹"
          className="rw-trust"
          onClose={() => setTrust(undefined)}
        >
          <div className="rw-modal-icon">
            <ShieldCheck size={25} />
          </div>
          <h2>核对这台服务器的身份</h2>
          <p>
            首次连接 {trust.address}。请与服务器管理者提供的指纹核对后保存。
          </p>
          <div className="rw-fingerprint">
            <small>{trust.algorithm}</small>
            <code>{trust.fingerprint}</code>
          </div>
          <footer>
            <button
              type="button"
              className="rw-button"
              onClick={() => setTrust(undefined)}
            >
              取消连接
            </button>
            <button
              type="button"
              className="rw-button primary"
              onClick={() => {
                const value = trust;
                setTrust(undefined);
                void run(async () => {
                  await api.post("/trust", value);
                  await connectHost(value.resumeHostId ?? value.hostId);
                });
              }}
            >
              信任并连接
            </button>
          </footer>
        </Modal>
      )}
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(undefined)}
        >
          {fileActions(contextMenu.entry)}
        </FileContextMenu>
      )}
      {notice && (
        <div
          className={"rw-toast " + (notice.error ? "error" : "")}
          role="status"
        >
          {notice.error ? <Circle size={14} /> : <Check size={14} />}
          <span>{notice.text}</span>
          <button aria-label="关闭提示" onClick={() => setNotice(undefined)}>
            <X size={13} />
          </button>
        </div>
      )}
      {taskDetail && (
        <Modal
          ariaLabel="任务详情"
          className="rw-task-detail"
          onClose={() => setTaskDetail(undefined)}
        >
          <header>
            <TerminalSquare size={18} />
            <h2>操作记录</h2>
            <button
              type="button"
              className="rw-icon"
              aria-label="关闭任务详情"
              onClick={() => setTaskDetail(undefined)}
            >
              <X size={17} />
            </button>
          </header>
          <p>
            {taskDetail.hostName} · {statusLabel[taskDetail.status]}
          </p>
          {taskDetail.status === "unknown" && (
            <div className="rw-unknown-callout">
              <ShieldAlert size={14} />
              <span>
                连接中断或超时导致结果未知：远端操作可能已生效，请核对后再重试。
              </span>
            </div>
          )}
          <code>{taskDetail.command ?? taskDetail.label}</code>
          <pre>
            {taskDetail.output ||
              taskDetail.error ||
              "操作已完成，无文本输出。"}
          </pre>
          {taskDetail.error && taskDetail.output && (
            <div className="rw-error">{taskDetail.error}</div>
          )}
        </Modal>
      )}
      {tunnelOpen && host && (
        <TunnelDialog
          host={host}
          snapshot={snapshot}
          onClose={() => setTunnelOpen(false)}
          onChange={refresh}
        />
      )}
    </div>
  );
}

function ActionDialog({
  dialog,
  onClose,
}: {
  dialog: Dialog;
  onClose(): void;
}) {
  const [value, setValue] = useState(dialog.initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      form
      ariaLabel={dialog.title}
      className="rw-action-dialog"
      busy={busy}
      onClose={onClose}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await dialog.action(value);
          onClose();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>{dialog.title}</h2>
      {dialog.description && <p>{dialog.description}</p>}
      {dialog.input && (
        <input
          autoFocus
          type={dialog.password ? "password" : "text"}
          required
          value={value}
          placeholder={dialog.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      {error && <div className="rw-error">{error}</div>}
      <footer>
        <button
          type="button"
          className="rw-button"
          disabled={busy}
          onClick={onClose}
        >
          取消
        </button>
        <button
          type="submit"
          className={
            "rw-button " + (dialog.danger ? "destructive" : "primary")
          }
          disabled={busy}
        >
          {busy ? "处理中…" : dialog.confirm}
        </button>
      </footer>
    </Modal>
  );
}
function TunnelDialog({
  host,
  snapshot,
  onClose,
  onChange,
}: {
  host: Host;
  snapshot: Snapshot;
  onClose(): void;
  onChange(): Promise<unknown>;
}) {
  const [local, setLocal] = useState(8080);
  const [target, setTarget] = useState("127.0.0.1");
  const [port, setPort] = useState(80);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      ariaLabel="端口隧道"
      className="rw-tunnel-dialog"
      busy={busy}
      onClose={onClose}
    >
      <header>
        <Link2 size={20} />
        <h2>端口隧道</h2>
        <button
          type="button"
          className="rw-icon"
          onClick={onClose}
          aria-label="关闭端口隧道"
        >
          <X size={17} />
        </button>
      </header>
      <p>通过 {host.name} 访问内网服务。监听地址为 DSH 宿主的 127.0.0.1。</p>
      {snapshot.tunnels
        .filter((t) => t.hostId === host.id)
        .map((t) => (
          <div className="rw-tunnel-row" key={t.id}>
            <span>
              :{t.localPort} <ArrowRight size={12} /> {t.targetHost}:
              {t.targetPort}
            </span>
            <button
              type="button"
              onClick={() => {
                void api
                  .post("/tunnels/close", { id: t.id })
                  .then(onChange)
                  .catch((e) => setError(e.message));
              }}
            >
              停止
            </button>
          </div>
        ))}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api.post("/tunnels/create", {
              hostId: host.id,
              localPort: local,
              targetHost: target,
              targetPort: port,
            });
            await onChange();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="rw-form-row">
          <label>
            本机端口
            <input
              type="number"
              min="1024"
              max="65535"
              required
              value={local}
              onChange={(e) => setLocal(Number(e.target.value))}
            />
          </label>
          <label>
            远程目标
            <input
              required
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </label>
          <label>
            目标端口
            <input
              type="number"
              min="1"
              max="65535"
              required
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </label>
        </div>
        {error && <div className="rw-error">{error}</div>}
        <footer>
          <button className="rw-button primary" disabled={busy}>
            {busy ? "创建中…" : "创建隧道"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
