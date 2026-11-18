import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Copy,
  Files,
  LoaderCircle,
  PlugZap,
  Search,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Unplug,
  X,
  Activity,
  AlertTriangle,
} from "lucide-react";
import { api, ApiError } from "./api.ts";
import type {
  Credentials,
  ConnectionState,
  Host,
  Snapshot,
} from "../shared/types.ts";
import type { Grant } from "../shared/types.ts";
import { MonitorView } from "./MonitorView.tsx";
import { AgentFiles } from "./AgentFiles.tsx";
import { HostDialog } from "./HostDialog.tsx";
import type { HostInput } from "../shared/types.ts";

interface NavigationParams {
  hostId?: string;
  path?: string;
}
interface TabInfoLike {
  tab?: {
    visible?: boolean;
    navigation?: { params?: NavigationParams; revision?: number };
  };
}
export interface OpenFileRequest extends NavigationParams {
  nonce: number;
}
type AgentProps = {
  sessionId?: string;
  useTabInfo?: () => TabInfoLike;
  /** Development preview / direct mount: open a file without the native tab. */
  openRequest?: OpenFileRequest;
};

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

export function AgentTitle({ hostName }: { hostName?: string }) {
  return <span title="远程 Agent">{hostName || "远程 Agent"}</span>;
}

/**
 * The Agent workspace inside DSH's native right sidebar. It binds to the
 * Session it was opened in: no second session picker, no chat, no terminal.
 * Monitoring and remote files/editors only, plus an explicit hand-off of the
 * current selection to the bound Session.
 */
export function AgentPanel(props: AgentProps) {
  if (props.useTabInfo) return <AgentPanelVisible {...props} />;
  return <AgentPanelBody {...props} visible />;
}

function AgentPanelVisible(props: AgentProps) {
  const info = props.useTabInfo?.();
  const navigation = info?.tab?.navigation;
  // Opening `remote-agent` from the workbench carries the file to show.
  const request: OpenFileRequest | undefined =
    navigation?.params?.path && navigation.params.hostId
      ? {
          hostId: navigation.params.hostId,
          path: navigation.params.path,
          nonce: navigation.revision ?? 0,
        }
      : undefined;
  return (
    <AgentPanelBody
      {...props}
      visible={info?.tab?.visible !== false}
      openRequest={props.openRequest ?? request}
    />
  );
}

function AgentPanelBody({
  sessionId,
  visible,
  openRequest,
}: {
  sessionId?: string;
  visible: boolean;
  openRequest?: OpenFileRequest;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [loaded, setLoaded] = useState(false);
  const [hostId, setHostId] = useState(() => remembered("agent-host"));
  const [mode, setMode] = useState<"files" | "monitor">("files");
  const [switcher, setSwitcher] = useState(false);
  const [query, setQuery] = useState("");
  const [busyHost, setBusyHost] = useState("");
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [trust, setTrust] = useState<{
    hostId: string;
    address: string;
    fingerprint: string;
    algorithm: string;
  }>();
  const [passwordFor, setPasswordFor] = useState<Host>();
  const [password, setPassword] = useState("");
  const [handoff, setHandoff] = useState<{ text: string; label: string }>();
  const [sending, setSending] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantWrite, setGrantWrite] = useState(false);
  const [grantExec, setGrantExec] = useState(false);
  const [filesDirty, setFilesDirty] = useState(false);
  const [fileRequest, setFileRequest] = useState<OpenFileRequest>();
  const [hostDialog, setHostDialog] = useState<{
    host?: Host | Partial<HostInput>;
  }>();
  const [importing, setImporting] = useState(false);

  const host = snapshot.hosts.find((item) => item.id === hostId);
  const connection: ConnectionState | undefined = snapshot.connections.find(
    (item) => item.hostId === hostId,
  );
  const connected = connection?.status === "connected";
  const grant: Grant | undefined = snapshot.grants.find(
    (item) => item.hostId === hostId && item.sessionId === sessionId,
  );

  const refresh = useCallback(async () => {
    const value = await api.get<Snapshot>("/snapshot");
    setSnapshot(value);
    return value;
  }, []);

  const toast = useCallback((text: string, error = false) => {
    setNotice({ text, error });
  }, []);

  useEffect(() => {
    let disposed = false;
    api
      .init()
      .then((value) => {
        if (disposed) return;
        setSnapshot(value);
        setLoaded(true);
        if (!value.hosts.some((item) => item.id === hostId))
          setHostId(value.hosts[0]?.id ?? "");
      })
      .catch((error: Error) => toast(error.message, true));
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        void refresh().catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [refresh, visible]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(
      () => setNotice(undefined),
      notice.error ? 8000 : 4000,
    );
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    remember("agent-host", hostId);
  }, [hostId]);

  useEffect(() => {
    if (!openRequest?.path || !openRequest.hostId) return;
    if (openRequest.hostId !== hostId) {
      if (
        filesDirty &&
        !window.confirm(
          "当前打开的文件还有未保存的修改。切换服务器会关闭这些标签，继续？",
        )
      )
        return;
      setFilesDirty(false);
      setHostId(openRequest.hostId);
    }
    setMode("files");
    setFileRequest(openRequest);
    // The nonce changes on every navigation, so reopening the same file works.
  }, [openRequest?.nonce, openRequest?.hostId, openRequest?.path]);

  /** Switching servers closes the open tabs, so unsaved work asks first. */
  const chooseHost = (id: string) => {
    if (id === hostId) {
      setSwitcher(false);
      return;
    }
    if (
      filesDirty &&
      !window.confirm(
        "当前打开的文件还有未保存的修改（含 PDF 批注/表单）。切换服务器会关闭这些标签，继续？",
      )
    )
      return;
    setFilesDirty(false);
    setHostId(id);
    setSwitcher(false);
  };

  const saveHost = async (input: HostInput, credentials: Credentials) => {
    const saved = await api.post<Host>("/hosts/save", input);
    await refresh();
    setHostId(saved.id);
    if (credentials.password || credentials.passphrase)
      await connect(saved.id, credentials);
    toast("连接已保存");
  };

  const importSsh = async () => {
    setImporting(true);
    try {
      const value = await api.post<{
        hosts: (Partial<HostInput> & { note?: string })[];
      }>("/ssh/import", {});
      if (!value.hosts.length) {
        toast("没有找到可导入的明确 Host 配置", true);
        return;
      }
      setHostDialog({ host: value.hosts[0] });
      toast(`发现 ${value.hosts.length} 个配置，先预览第一个`);
    } catch (error) {
      toast((error as Error).message, true);
    } finally {
      setImporting(false);
      setSwitcher(false);
    }
  };

  const connect = async (id: string, credentials?: Credentials) => {
    setBusyHost(id);
    try {
      if (credentials)
        await api.post("/credentials", { hostId: id, credentials });
      await api.post("/connect", { hostId: id });
      await refresh();
      toast("连接已就绪");
    } catch (error) {
      if (error instanceof ApiError && error.code === "HOST_KEY_UNKNOWN")
        setTrust({
          hostId: id,
          address: String(error.details?.address ?? ""),
          fingerprint: String(error.details?.fingerprint ?? ""),
          algorithm: String(error.details?.algorithm ?? ""),
        });
      else if (
        error instanceof ApiError &&
        error.code === "CREDENTIAL_REQUIRED"
      )
        setPasswordFor(snapshot.hosts.find((item) => item.id === id));
      else toast((error as Error).message, true);
      await refresh().catch(() => {});
    } finally {
      setBusyHost("");
    }
  };

  const disconnect = async () => {
    try {
      await api.post("/disconnect", { hostId });
      await refresh();
      toast("已断开连接");
    } catch (error) {
      toast((error as Error).message, true);
    }
  };

  /** Read is always on; write is the only optional capability here, never shell. */
  const applyGrant = async (write: boolean, exec: boolean) => {
    if (!host || !sessionId) return;
    try {
      await api.post("/ai/grant", {
        sessionId,
        hostId: host.id,
        rootPath: host.rootPath,
        read: true,
        write,
        exec,
      });
      await refresh();
      toast(
        `已授权${write ? "读取与修改" : "读取"} ${host.rootPath}${exec ? "，并允许工具级 Shell 执行" : ""}`,
      );
    } catch (error) {
      toast((error as Error).message, true);
    }
    setGrantOpen(false);
  };
  const revokeGrant = async () => {
    if (!host || !sessionId) return;
    try {
      await api.post("/ai/revoke", { hostId: host.id, sessionId });
      await refresh();
      toast("已撤销当前会话的授权");
    } catch (error) {
      toast((error as Error).message, true);
    }
    setGrantOpen(false);
  };

  const sendToAgent = async () => {
    if (!handoff) return;
    if (!sessionId) {
      toast("当前右侧栏没有绑定会话，无法发送；可复制后粘贴", true);
      return;
    }
    setSending(true);
    try {
      await api.post("/ai/send", {
        sessionId,
        text: handoff.text,
        requestId: crypto.randomUUID(),
      });
      toast("已发送到当前会话");
      setHandoff(undefined);
    } catch (error) {
      toast((error as Error).message, true);
    } finally {
      setSending(false);
    }
  };

  const openHandoff = (text: string, label: string) => {
    setHandoff({ text, label });
  };

  const hosts = snapshot.hosts.filter((item) =>
    `${item.name} ${item.address} ${item.username}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const groups = [
    ...new Set(snapshot.hosts.map((item) => item.group || "未分组")),
  ];

  return (
    <div className="rw-workbench rw-agent">
      <div className="rw-agent-bar">
        <div className="rw-agent-host">
          <button
            className="rw-agent-host-button"
            aria-haspopup="dialog"
            aria-expanded={switcher}
            onClick={() => {
              setSwitcher((value) => !value);
              setQuery("");
            }}
          >
            <Server size={13} />
            <span title={host?.name}>{host?.name ?? "选择服务器"}</span>
            {host && (
              <i
                className={
                  connected
                    ? "on"
                    : connection?.status === "connecting"
                      ? "connecting"
                      : ""
                }
              />
            )}
            <ChevronDown size={12} />
          </button>
          {host &&
            (connected ? (
              <button
                className="rw-icon"
                aria-label="断开连接"
                title="断开连接"
                onClick={() => void disconnect()}
              >
                <Unplug size={13} />
              </button>
            ) : (
              <button
                className="rw-icon"
                aria-label="连接服务器"
                title="连接服务器"
                disabled={busyHost === host.id}
                onClick={() => void connect(host.id)}
              >
                {busyHost === host.id ? (
                  <LoaderCircle size={13} className="rw-spin" />
                ) : (
                  <PlugZap size={13} />
                )}
              </button>
            ))}
        </div>
        <div className="rw-agent-modes" role="tablist" aria-label="Agent 视图">
          <button
            role="tab"
            aria-selected={mode === "files"}
            className={mode === "files" ? "active" : ""}
            onClick={() => setMode("files")}
          >
            <Files size={13} />
            文件
          </button>
          <button
            role="tab"
            aria-selected={mode === "monitor"}
            className={mode === "monitor" ? "active" : ""}
            onClick={() => setMode("monitor")}
          >
            <Activity size={13} />
            监控
          </button>
        </div>
        <div className="rw-agent-perm">
          {sessionId ? (
            <button
              className={"rw-agent-granted" + (grant ? " on" : "")}
              aria-label={grant ? "管理当前会话授权" : "授权当前会话读取"}
              aria-haspopup="dialog"
              title={
                grant
                  ? `已授权${grant.write ? "读取与写入" : "读取"} ${grant.rootPath}（Shell 未开启）`
                  : "授权当前会话读取此服务器，Agent 即可用已保存凭据连接（不开启 Shell）"
              }
              disabled={!host}
              onClick={() => {
                setGrantWrite(!!grant?.write);
                setGrantExec(!!grant?.exec);
                setGrantOpen(true);
              }}
            >
              <ShieldCheck size={12} />
              {grant ? (grant.write ? "读+写" : "已授权") : ""}
            </button>
          ) : (
            <span className="rw-agent-nosession" title="未绑定会话">
              <AlertTriangle size={12} />
            </span>
          )}
        </div>
        {switcher && (
          <>
            <div
              className="rw-agent-scrim"
              onClick={() => setSwitcher(false)}
            />
            <div
              className="rw-agent-switcher"
              role="dialog"
              aria-label="选择服务器"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="rw-agent-switcher-search">
                <Search size={13} />
                <input
                  autoFocus
                  aria-label="搜索主机"
                  placeholder="搜索服务器"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setSwitcher(false);
                  }}
                />
              </div>
              <div className="rw-agent-switcher-list">
                {hosts.length ? (
                  hosts.map((item) => {
                    const status = snapshot.connections.find(
                      (state) => state.hostId === item.id,
                    )?.status;
                    return (
                      <button
                        key={item.id}
                        aria-current={item.id === hostId}
                        className={item.id === hostId ? "active" : ""}
                        onClick={() => chooseHost(item.id)}
                      >
                        <Server size={13} />
                        <span>
                          <strong>{item.name}</strong>
                          <small>
                            {item.username}@{item.address}:{item.port}
                          </small>
                        </span>
                        <i
                          className={
                            status === "connected"
                              ? "on"
                              : status === "connecting"
                                ? "connecting"
                                : ""
                          }
                        />
                      </button>
                    );
                  })
                ) : (
                  <p className="rw-agent-switcher-empty">
                    {loaded
                      ? "还没有服务器，请先在工作台新建连接。"
                      : "正在读取…"}
                  </p>
                )}
              </div>
              <footer>
                <button
                  className="rw-agent-switch-action"
                  onClick={() => {
                    setSwitcher(false);
                    setHostDialog({});
                  }}
                >
                  + 新建连接
                </button>
                <button
                  className="rw-agent-switch-action"
                  disabled={importing}
                  onClick={() => void importSsh()}
                >
                  从 SSH Config 导入
                </button>
                {host && (
                  <button
                    className="rw-agent-switch-action"
                    onClick={() => {
                      setSwitcher(false);
                      setHostDialog({ host });
                    }}
                  >
                    编辑当前连接
                  </button>
                )}
              </footer>
            </div>
          </>
        )}
      </div>
      <div className="rw-agent-body">
        {!host ? (
          <div className="rw-agent-state">
            <Server size={22} />
            <h2>还没有可用的服务器</h2>
            <p>
              直接在这里新建 SSH
              连接：首次连接会核对指纹，密码只保存在宿主内存中。
            </p>
            <div className="rw-agent-state-actions">
              <button
                className="rw-button primary"
                onClick={() => setHostDialog({})}
              >
                <PlugZap size={13} />
                新建 SSH 连接
              </button>
              <button
                className="rw-button"
                disabled={importing}
                onClick={() => void importSsh()}
              >
                从 SSH Config 导入
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              className="rw-agent-pane"
              data-active={mode === "files"}
              aria-hidden={mode !== "files"}
            >
              <AgentFiles
                key={host.id}
                host={host}
                sessionId={sessionId}
                connected={connected}
                request={
                  fileRequest?.hostId === host.id &&
                  fileRequest.path &&
                  fileRequest.hostId
                    ? {
                        hostId: fileRequest.hostId,
                        path: fileRequest.path,
                        nonce: fileRequest.nonce,
                      }
                    : undefined
                }
                onSendToAgent={(text, label) => openHandoff(text, label)}
                onNotice={toast}
                onDirtyChange={setFilesDirty}
              />
            </div>
            <div
              className="rw-agent-pane"
              data-active={mode === "monitor"}
              aria-hidden={mode !== "monitor"}
            >
              <MonitorView
                hostId={host.id}
                hostName={host.name}
                connected={connected}
                active={mode === "monitor" && visible}
                onSummary={(text) => openHandoff(text, "监控摘要")}
                onNotice={toast}
              />
            </div>
          </>
        )}
      </div>
      {notice && (
        <div
          className={"rw-agent-toast" + (notice.error ? " error" : "")}
          role="status"
        >
          <span>{notice.text}</span>
          <button aria-label="关闭提示" onClick={() => setNotice(undefined)}>
            <X size={12} />
          </button>
        </div>
      )}
      {grantOpen && host && (
        <div className="rw-modal-backdrop">
          <section
            className="rw-modal rw-agent-grant"
            role="dialog"
            aria-modal="true"
            aria-label="授权当前会话"
          >
            <h2>{grant ? "当前会话的授权" : "授权当前 DSH 会话"}</h2>
            <p>
              {host.name} · {host.rootPath}
              {"\n"}授权后 Agent
              可以在当前会话里直接连接这台服务器（使用已保存的凭据），
              并把监控摘要与文件交给 AI 分析。
            </p>
            <label className="rw-agent-grant-check">
              <input
                type="checkbox"
                checked={grantWrite}
                onChange={(e) => setGrantWrite(e.target.checked)}
              />
              允许修改此目录下的远程文件（写入）
            </label>
            <label className="rw-agent-grant-check">
              <input
                type="checkbox"
                checked={grantExec}
                onChange={(e) => setGrantExec(e.target.checked)}
              />
              允许工具级 Shell 执行（不会在工作台或右栏生成终端）
            </label>
            <footer>
              {grant && (
                <button
                  className="rw-button destructive"
                  onClick={() => void revokeGrant()}
                >
                  撤销授权
                </button>
              )}
              <button className="rw-button" onClick={() => setGrantOpen(false)}>
                取消
              </button>
              <button
                className="rw-button primary"
                onClick={() => void applyGrant(grantWrite, grantExec)}
                disabled={!sessionId}
              >
                {grant
                  ? "更新授权"
                  : grantWrite
                    ? "允许读取与写入"
                    : "允许读取"}
              </button>
            </footer>
          </section>
        </div>
      )}
      {handoff && (
        <div className="rw-modal-backdrop">
          <section
            className="rw-modal rw-agent-handoff"
            role="dialog"
            aria-modal="true"
            aria-label="交给当前 Agent"
          >
            <header>
              <Sparkles size={16} />
              <h2>交给当前 Agent</h2>
              <button
                className="rw-icon"
                aria-label="关闭"
                onClick={() => setHandoff(undefined)}
              >
                <X size={14} />
              </button>
            </header>
            <p>
              目标会话：{sessionId ? sessionId.slice(0, 8) : "未绑定"}
              {host ? ` · ${host.name}` : ""} · 内容：{handoff.label}
            </p>
            <textarea
              aria-label="交给 Agent 的内容"
              value={handoff.text}
              onChange={(e) => setHandoff({ ...handoff, text: e.target.value })}
            />
            <footer>
              <button
                className="rw-button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(handoff.text)
                    .then(() => toast("内容已复制"))
                    .catch((error: Error) => toast(error.message, true));
                }}
              >
                <Copy size={13} />
                复制
              </button>
              <button
                className="rw-button primary"
                disabled={!sessionId || sending}
                onClick={() => void sendToAgent()}
              >
                {sending ? (
                  <LoaderCircle size={13} className="rw-spin" />
                ) : (
                  <Send size={13} />
                )}
                发送到当前会话
              </button>
            </footer>
          </section>
        </div>
      )}
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
                    toast((error as Error).message, true);
                  }
                }
              : undefined
          }
          onDelete={
            hostDialog.host?.id
              ? () => {
                  const target = hostDialog.host!;
                  const name = target.name ?? "这台连接";
                  setHostDialog(undefined);
                  if (
                    !window.confirm(
                      `删除连接“${name}”？该连接的终端与隧道会一并关闭。`,
                    )
                  )
                    return;
                  void (async () => {
                    try {
                      await api.post("/hosts/delete", { hostId: target.id });
                      const next = await refresh();
                      if (target.id === hostId) {
                        setFilesDirty(false);
                        setHostId(next.hosts[0]?.id ?? "");
                      }
                      toast("连接已删除");
                    } catch (error) {
                      toast((error as Error).message, true);
                    }
                  })();
                }
              : undefined
          }
        />
      )}
      {trust && (
        <div className="rw-modal-backdrop">
          <section
            className="rw-modal rw-trust"
            role="dialog"
            aria-modal="true"
            aria-label="核对服务器指纹"
          >
            <h2>核对这台服务器的身份</h2>
            <p>首次连接 {trust.address}，请与服务器管理者提供的指纹核对。</p>
            <div className="rw-fingerprint">
              <small>{trust.algorithm}</small>
              <code>{trust.fingerprint}</code>
            </div>
            <footer>
              <button className="rw-button" onClick={() => setTrust(undefined)}>
                取消
              </button>
              <button
                className="rw-button primary"
                onClick={() => {
                  const value = trust;
                  setTrust(undefined);
                  void (async () => {
                    try {
                      await api.post("/trust", value);
                      await connect(value.hostId);
                    } catch (error) {
                      toast((error as Error).message, true);
                    }
                  })();
                }}
              >
                信任并连接
              </button>
            </footer>
          </section>
        </div>
      )}
      {passwordFor && (
        <div className="rw-modal-backdrop">
          <form
            className="rw-modal rw-action-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="输入连接密码"
            onSubmit={(e) => {
              e.preventDefault();
              const target = passwordFor;
              setPasswordFor(undefined);
              const value = password;
              setPassword("");
              void connect(target.id, { password: value });
            }}
          >
            <h2>输入连接密码</h2>
            <p>{passwordFor.name} · 密码只保存在宿主进程内存中。</p>
            <input
              autoFocus
              required
              type="password"
              aria-label="连接密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <footer>
              <button
                type="button"
                className="rw-button"
                onClick={() => setPasswordFor(undefined)}
              >
                取消
              </button>
              <button type="submit" className="rw-button primary">
                连接
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}

function remembered(key: string, fallback = "") {
  try {
    return localStorage.getItem("rw:" + key) ?? fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem("rw:" + key, value);
  } catch {}
}
