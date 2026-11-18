import { useState } from "react";
import {
  X,
  KeyRound,
  LockKeyhole,
  Fingerprint,
  Server,
  ChevronDown,
} from "lucide-react";
import type { Credentials, Host, HostInput } from "../shared/types.ts";

export function HostDialog({
  host,
  hosts,
  onClose,
  onSave,
  onDelete,
  onForgetCredentials,
}: {
  host?: Host | Partial<HostInput>;
  hosts: Host[];
  onClose(): void;
  onSave(value: HostInput, credentials: Credentials): Promise<void>;
  onDelete?: () => void;
  /** Remove the durable credential record for this host. */
  onForgetCredentials?: () => Promise<void>;
}) {
  const [form, setForm] = useState<HostInput>({
    name: "",
    address: "",
    port: 22,
    username: "root",
    group: "开发环境",
    rootPath: "/",
    auth: "agent",
    favorite: false,
    ...host,
  });
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof HostInput>(key: K, value: HostInput[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));
  return (
    <div
      className="rw-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="rw-modal rw-host-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={host ? "编辑连接" : "新建连接"}
      >
        <header>
          <div className="rw-modal-icon">
            <Server size={21} />
          </div>
          <div>
            <h2>{host ? "编辑连接" : "连接一台服务器"}</h2>
            <p>配置一次，文件、终端与 AI 共用这条连接</p>
          </div>
          <button
            className="rw-icon"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const {
                revision: _revision,
                note: _note,
                ...clean
              } = form as HostInput & { revision?: number; note?: string };
              await onSave(clean, {
                password: password || undefined,
                passphrase: passphrase || undefined,
              });
              onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            连接名称
            <input
              autoFocus
              required
              placeholder="例如：测试服务器"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </label>
          <div className="rw-form-row">
            <label className="rw-grow">
              主机地址
              <input
                required
                placeholder="192.168.1.10 或 server.example.com"
                value={form.address}
                onChange={(e) => set("address", e.target.value)}
              />
            </label>
            <label className="rw-port">
              端口
              <input
                required
                type="number"
                min="1"
                max="65535"
                value={form.port}
                onChange={(e) => set("port", Number(e.target.value))}
              />
            </label>
          </div>
          <div className="rw-form-row">
            <label className="rw-grow">
              用户名
              <input
                required
                value={form.username}
                onChange={(e) => set("username", e.target.value)}
              />
            </label>
            <label className="rw-grow">
              分组
              <input
                value={form.group}
                onChange={(e) => set("group", e.target.value)}
              />
            </label>
          </div>
          <label>认证方式</label>
          <div className="rw-auth-options">
            {(
              [
                { id: "key", icon: KeyRound, label: "私钥文件" },
                { id: "password", icon: LockKeyhole, label: "密码" },
                // Legacy rows that already use SSH Agent keep their option so an
                // existing connection never changes silently; new ones cannot pick it.
                ...(form.auth === "agent"
                  ? [
                      {
                        id: "agent" as const,
                        icon: Fingerprint,
                        label: "SSH Agent（旧配置）",
                      },
                    ]
                  : []),
              ] as const
            ).map((o) => (
              <button
                key={o.id}
                type="button"
                className={form.auth === o.id ? "active" : ""}
                onClick={() => set("auth", o.id)}
              >
                <o.icon size={15} />
                {o.label}
              </button>
            ))}
          </div>
          {form.auth === "agent" && (
            <p className="rw-auth-hint">
              新连接不再提供 SSH Agent 认证。请改选私钥或密码后保存，凭据会记入
              DSH 凭据库。
            </p>
          )}
          {form.auth === "key" && (
            <>
              <label>
                宿主上的私钥路径
                <input
                  required
                  placeholder="~/.ssh/id_ed25519"
                  value={form.privateKeyPath ?? ""}
                  onChange={(e) => set("privateKeyPath", e.target.value)}
                />
              </label>
              <label>
                私钥口令（可选）
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="保存一次，之后自动复用"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </label>
            </>
          )}
          {form.auth === "password" && (
            <label>
              连接密码
              <input
                type="password"
                autoComplete="off"
                placeholder="保存一次，之后自动复用"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          )}
          <label>
            默认远程目录
            <input
              required
              placeholder="/var/www/app"
              value={form.rootPath}
              onChange={(e) => set("rootPath", e.target.value)}
            />
          </label>
          <label>
            跳板机
            <select
              value={form.jumpHostId ?? ""}
              onChange={(e) => set("jumpHostId", e.target.value || undefined)}
            >
              <option value="">直接连接</option>
              {hosts
                .filter((h) => h.id !== form.id)
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} · {h.address}
                  </option>
                ))}
            </select>
          </label>
          {error && <div className="rw-error">{error}</div>}
          <footer>
            {onDelete ? (
              <button
                type="button"
                className="rw-delete-connection"
                disabled={busy}
                onClick={onDelete}
              >
                删除连接
              </button>
            ) : (
              <span>凭据保存在 DSH 凭据库</span>
            )}
            {onForgetCredentials && (
              <button
                type="button"
                className="rw-forget-credentials"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onForgetCredentials();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                忘记已保存凭据
              </button>
            )}
            <button
              type="button"
              className="rw-button"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button type="submit" className="rw-button primary" disabled={busy}>
              {busy ? "正在保存…" : "保存连接"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
