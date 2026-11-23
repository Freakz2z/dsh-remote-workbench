import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  HardDrive,
  Link2,
  PlugZap,
  Plus,
  Search,
  Server,
  Settings2,
  X,
} from "lucide-react";
import type { ConnectionState, Host } from "../../shared/types.ts";

/**
 * Unified server switcher popover shared by the standalone workbench and the
 * DSH right-sidebar Agent pane. Supports search, collapsible groups, arrow-key
 * navigation, quick connect, and per-host editing.
 */
export function HostSwitcher({
  id = "rw-host-switcher",
  ariaLabel = "切换服务器",
  compact = false,
  hosts,
  connections,
  currentHostId,
  importing = false,
  onSelect,
  onConnect,
  onNew,
  onImport,
  onEditHost,
  onEditCurrent,
  onTunnel,
  onClose,
}: {
  id?: string;
  ariaLabel?: string;
  compact?: boolean;
  hosts: Host[];
  connections: ConnectionState[];
  currentHostId: string;
  importing?: boolean;
  onSelect(host: Host): void;
  onConnect(host: Host): void;
  onNew(): void;
  onImport(): void;
  onEditHost?(host: Host): void;
  onEditCurrent?(): void;
  onTunnel?(): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const normalized = query.trim().toLowerCase();
  const matched = hosts.filter((h) =>
    `${h.name} ${h.address} ${h.username} ${h.group}`
      .toLowerCase()
      .includes(normalized),
  );
  const groups = [...new Set(hosts.map((h) => h.group || "未分组"))];
  const stateOf = (hostId: string) =>
    connections.find((c) => c.hostId === hostId)?.status ?? "disconnected";

  return (
    <>
      <div className="rw-switcher-scrim" onClick={onClose} />
      <section
        className={"rw-switcher" + (compact ? " compact" : "")}
        id={id}
        role="dialog"
        aria-label={ariaLabel}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
            return;
          }
          if (
            e.key !== "ArrowDown" &&
            e.key !== "ArrowUp" &&
            e.key !== "Home" &&
            e.key !== "End"
          )
            return;
          const items = Array.from(
            e.currentTarget.querySelectorAll<HTMLButtonElement>(
              "[data-rw-switch-row]",
            ),
          );
          if (!items.length) return;
          e.preventDefault();
          const index = items.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? items.length - 1
                : e.key === "ArrowDown"
                  ? (index + 1) % items.length
                  : (index - 1 + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        <div className="rw-switcher-head">
          <div className="rw-switcher-search">
            <Search size={14} aria-hidden="true" />
            <input
              autoFocus
              aria-label="搜索主机"
              placeholder="搜索主机、地址或用户名"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => setQuery("")}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <button
            type="button"
            className="rw-icon"
            aria-label="关闭服务器列表"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        <div className="rw-switcher-list">
          {hosts.length === 0 ? (
            <div className="rw-switcher-empty">
              <Server size={22} />
              <p>还没有服务器连接</p>
              <span>新建一条 SSH 连接，文件、终端与 Agent 共用它。</span>
            </div>
          ) : matched.length === 0 ? (
            <div className="rw-switcher-empty">
              <Search size={20} />
              <p>没有匹配 “{query.trim()}” 的服务器</p>
            </div>
          ) : (
            groups.map((group) => {
              const items = matched.filter(
                (h) => (h.group || "未分组") === group,
              );
              if (!items.length) return null;
              const closed = normalized ? false : collapsed[group];
              return (
                <div className="rw-switcher-group" key={group}>
                  <button
                    type="button"
                    className="rw-switcher-group-label"
                    aria-expanded={!closed}
                    onClick={() =>
                      setCollapsed((prev) => ({
                        ...prev,
                        [group]: !prev[group],
                      }))
                    }
                  >
                    {closed ? (
                      <ChevronRight size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    )}
                    <span>{group}</span>
                    <small>{items.length}</small>
                  </button>
                  {!closed &&
                    items.map((h) => {
                      const state = stateOf(h.id);
                      const current = h.id === currentHostId;
                      return (
                        <div
                          className={
                            "rw-switcher-row" + (current ? " active" : "")
                          }
                          key={h.id}
                        >
                          <button
                            type="button"
                            data-rw-switch-row=""
                            className="rw-switcher-main"
                            title={`切换到 ${h.name}`}
                            onClick={() => onSelect(h)}
                          >
                            <span className="rw-switcher-host-icon">
                              <Server size={14} />
                              <i data-status={state} />
                            </span>
                            <span className="rw-switcher-host-text">
                              <strong>{h.name}</strong>
                              <small>
                                {h.username}@{h.address}:{h.port}
                              </small>
                            </span>
                          </button>
                          {onEditHost && (
                            <button
                              type="button"
                              className="rw-switcher-edit"
                              aria-label={`编辑 ${h.name}`}
                              title="编辑连接"
                              onClick={(e) => {
                                e.stopPropagation();
                                onEditHost(h);
                              }}
                            >
                              <Settings2 size={12} />
                            </button>
                          )}
                          {current ? (
                            <span className="rw-switcher-tag">
                              <Check size={11} />
                              当前
                            </span>
                          ) : state === "connected" ? (
                            <span className="rw-switcher-tag connected">
                              已连接
                            </span>
                          ) : (
                            <button
                              type="button"
                              data-rw-switch-row=""
                              className="rw-switcher-connect"
                              aria-label={`连接 ${h.name}`}
                              title={`连接 ${h.name}`}
                              onClick={() => onConnect(h)}
                            >
                              <PlugZap size={13} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })
          )}
        </div>

        <div className="rw-switcher-actions">
          <button type="button" data-rw-switch-row="" onClick={onNew}>
            <Plus size={14} />
            新建连接
          </button>
          <button
            type="button"
            data-rw-switch-row=""
            disabled={importing}
            onClick={onImport}
          >
            <HardDrive size={14} />
            从 SSH Config 导入
          </button>
          {onEditCurrent && (
            <button type="button" data-rw-switch-row="" onClick={onEditCurrent}>
              <Settings2 size={14} />
              编辑当前连接
            </button>
          )}
          {onTunnel && (
            <button type="button" data-rw-switch-row="" onClick={onTunnel}>
              <Link2 size={14} />
              端口隧道
            </button>
          )}
        </div>
        <div className="rw-switcher-note">
          <span className="rw-status-dot" />
          本机宿主
          <span className="rw-switcher-hint">Esc 关闭</span>
        </div>
      </section>
    </>
  );
}
