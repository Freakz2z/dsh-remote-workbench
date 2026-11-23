import { useCallback, useEffect, useRef, useState } from "react";
import {
  History,
  Send,
  Sparkles,
  TerminalSquare,
  Trash2,
  X,
  BookMarked,
  Search,
  PauseCircle,
  PlayCircle,
  Plus,
  Pencil,
} from "lucide-react";
import { api, ApiError, remoteJoin } from "./api.ts";
import { ConfirmDialog } from "./components/Modal.tsx";
import type {
  CommandHistoryEntry,
  CommandLibrary,
  CommandSnippet,
  CommandSuggestion,
} from "../shared/workstation.ts";

const suggestionKindLabel: Record<CommandSuggestion["kind"], string> = {
  history: "历史",
  snippet: "片段",
  path: "路径",
  command: "命令",
};

const suggestionIcon = (kind: CommandSuggestion["kind"]) => {
  if (kind === "history") return <History size={13} />;
  if (kind === "snippet") return <BookMarked size={13} />;
  if (kind === "path") return <TerminalSquare size={13} />;
  return <Sparkles size={13} />;
};

/**
 * Command bar docked above the terminal. Suggestions come from the host
 * (`/commands/suggest`); picking one only fills the input, never sends.
 */
export function CommandBar({
  hostId,
  cwd,
  state,
  writable,
  onSend,
  onOpenLibrary,
  onNotice,
  value,
  onValue,
}: {
  hostId: string;
  cwd: string;
  state: "connecting" | "ready" | "closed";
  writable: boolean;
  onSend(text: string): boolean;
  onOpenLibrary(): void;
  onNotice(text: string, error?: boolean): void;
  /** Controlled text, so the command library can fill the bar. */
  value?: string;
  onValue?(next: string): void;
}) {
  const [local, setLocal] = useState("");
  const input = value ?? local;
  const setInput = (next: string) => {
    if (value === undefined) setLocal(next);
    onValue?.(next);
  };
  const [items, setItems] = useState<CommandSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<"history" | "snippets">();
  const [library, setLibrary] = useState<CommandLibrary>();
  const pickerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const ready = state === "ready" && writable;

  useEffect(() => {
    if (!open) return;
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      api
        // Keep trailing spaces: `cd ` must reach the host's path completion.
        .suggest(hostId, cwd, input)
        .then((value) => {
          if (requestId.current !== id) return;
          setItems(value.items.slice(0, 8));
          // Never auto-select item 0 so pressing Enter sends the typed command.
          setActive(-1);
        })
        .catch(() => {
          if (requestId.current === id) setItems([]);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [input, open, hostId, cwd]);

  useEffect(() => {
    if (!picker) return;
    const onPointerDown = (e: PointerEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node))
        setPicker(undefined);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicker(undefined);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [picker]);

  const loadLibrary = useCallback(async () => {
    try {
      setLibrary(await api.commands(hostId));
    } catch (error) {
      onNotice((error as Error).message, true);
    }
  }, [hostId, onNotice]);

  useEffect(() => {
    if (picker) void loadLibrary();
  }, [picker, loadLibrary]);

  const send = () => {
    // Send and record exactly what the user typed: leading spaces stay, because
    // the host uses them to keep sensitive commands out of history.
    const command = input.replace(/\r?\n$/, "");
    if (!command.trim()) return;
    if (!ready) {
      onNotice("当前终端没有输入权，命令未发送", true);
      return;
    }
    if (!onSend(command + "\n")) {
      onNotice("终端连接未就绪，命令未发送", true);
      return;
    }
    setInput("");
    setItems([]);
    setOpen(false);
    api.post("/commands/remember", { hostId, command, cwd }).catch(() => {});
  };

  const fill = (value: string) => {
    setInput(value.replace(/\n/g, " "));
    setItems([]);
    setOpen(false);
    setPicker(undefined);
    inputRef.current?.focus();
  };

  return (
    <div className="rw-cmdbar">
      <div className="rw-cmdbar-main">
        <TerminalSquare size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          aria-label="命令输入"
          aria-autocomplete="list"
          placeholder={
            ready
              ? "命令栏：输入后 Enter 发送，↑↓ 选择建议，Tab 填入"
              : "命令栏：当前终端没有输入权（只读显示）"
          }
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((i) =>
                items.length ? (i < 0 ? 0 : (i + 1) % items.length) : -1,
              );
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              setActive((i) =>
                items.length
                  ? (i <= 0 ? items.length - 1 : i - 1)
                  : -1,
              );
            } else if (e.key === "Tab") {
              if (open && items.length) {
                e.preventDefault();
                fill(items[active >= 0 ? active : 0]!.value);
              }
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (
                open &&
                active >= 0 &&
                items[active] &&
                input !== items[active].value
              ) {
                fill(items[active].value);
                return;
              }
              send();
            } else if (e.key === "Escape") {
              setOpen(false);
              setPicker(undefined);
            }
          }}
        />
        <button
          className="rw-cmdbar-btn"
          aria-label="命令历史"
          aria-pressed={picker === "history"}
          title="命令历史"
          onClick={() =>
            setPicker((p) => (p === "history" ? undefined : "history"))
          }
        >
          <History size={14} />
        </button>
        <button
          className="rw-cmdbar-btn"
          aria-label="命令片段"
          aria-pressed={picker === "snippets"}
          title="命令片段"
          onClick={() =>
            setPicker((p) => (p === "snippets" ? undefined : "snippets"))
          }
        >
          <BookMarked size={14} />
        </button>
        <button
          className="rw-cmdbar-btn rw-cmdbar-manage"
          aria-label="管理命令库"
          title="管理命令历史与片段"
          onClick={onOpenLibrary}
        >
          命令库
        </button>
        <button
          className="rw-cmdbar-send"
          aria-label="发送命令"
          title="发送到当前终端"
          disabled={!input.trim() || !ready}
          onClick={send}
        >
          <Send size={13} />
        </button>
      </div>
      {open && items.length > 0 && (
        <ul className="rw-cmdbar-suggest" role="listbox" aria-label="命令建议">
          {items.map((item, index) => (
            <li key={item.id}>
              <button
                role="option"
                aria-selected={index === active}
                className={index === active ? "active" : ""}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => fill(item.value)}
              >
                <span className="rw-cmdbar-suggest-icon">
                  {suggestionIcon(item.kind)}
                </span>
                <span className="rw-cmdbar-suggest-label">{item.label}</span>
                <span className="rw-cmdbar-suggest-kind">
                  {suggestionKindLabel[item.kind]}
                </span>
                <span className="rw-cmdbar-suggest-desc">
                  {item.description}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {picker && (
        <div
          ref={pickerRef}
          className="rw-cmdbar-picker"
          role="dialog"
          aria-label={picker === "history" ? "命令历史" : "命令片段"}
        >
          <header>
            <strong>{picker === "history" ? "命令历史" : "命令片段"}</strong>
            <span className="rw-cmdbar-picker-hint">
              点击填入命令栏，不自动执行
            </span>
            <button
              aria-label="关闭选择器"
              onClick={() => setPicker(undefined)}
            >
              <X size={13} />
            </button>
          </header>
          <div className="rw-cmdbar-picker-list">
            {!library ? (
              <p className="rw-cmdbar-empty">正在读取…</p>
            ) : picker === "history" ? (
              library.history.length ? (
                library.history.map((entry) => (
                  <button
                    key={entry.id}
                    className="rw-cmdbar-picker-row"
                    onClick={() => fill(entry.command)}
                    title={entry.command}
                  >
                    <code>{entry.command}</code>
                    <small>
                      {entry.uses} 次 · {entry.cwd}
                    </small>
                  </button>
                ))
              ) : (
                <p className="rw-cmdbar-empty">
                  还没有历史。命令栏发送过的命令会出现在这里。
                </p>
              )
            ) : library.snippets.length ? (
              library.snippets.map((snippet) => (
                <button
                  key={snippet.id}
                  className="rw-cmdbar-picker-row"
                  onClick={() => fill(snippet.command)}
                  title={snippet.command}
                >
                  <code>{snippet.name}</code>
                  <small>{snippet.command}</small>
                </button>
              ))
            ) : (
              <p className="rw-cmdbar-empty">还没有片段，可在命令库中新建。</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Full library management: history (search/delete/clear/pause) and snippets. */
export function CommandLibraryPanel({
  hostId,
  onPick,
  onClose,
  onNotice,
}: {
  hostId: string;
  onPick(command: string): void;
  onClose(): void;
  onNotice(text: string, error?: boolean): void;
}) {
  const [library, setLibrary] = useState<CommandLibrary>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState<{
    id?: string;
    name: string;
    command: string;
    group: string;
    global: boolean;
  }>();
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (q = "") => {
      try {
        setLibrary(await api.commands(hostId, q));
        setError("");
      } catch (e) {
        setError((e as ApiError).message);
      }
    },
    [hostId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load(query);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const history: CommandHistoryEntry[] = library?.history ?? [];
  const snippets: CommandSnippet[] = library?.snippets ?? [];
  return (
    <aside className="rw-cmdlib" role="dialog" aria-label="命令库">
      <header>
        <strong>命令库</strong>
        <span>{library?.remember ? "记录已开启" : "记录已暂停"}</span>
        <button aria-label="关闭命令库" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="rw-cmdlib-toolbar">
        <div className="rw-cmdlib-search">
          <Search size={13} />
          <input
            aria-label="搜索命令历史"
            placeholder="搜索历史…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              void load(e.target.value);
            }}
          />
        </div>
        <button
          className="rw-cmdbar-btn"
          aria-label={library?.remember ? "暂停记录" : "恢复记录"}
          title={library?.remember ? "暂停记录新命令" : "恢复记录新命令"}
          disabled={!library || busy}
          onClick={() =>
            void act(() =>
              api.post("/commands/preferences", {
                hostId,
                remember: !library?.remember,
              }),
            )
          }
        >
          {library?.remember ? (
            <PauseCircle size={14} />
          ) : (
            <PlayCircle size={14} />
          )}
        </button>
        <button
          className="rw-cmdbar-btn"
          aria-label="清空历史"
          title="清空此主机历史"
          disabled={!history.length || busy}
          onClick={() => setConfirmClear(true)}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {error && <div className="rw-error">{error}</div>}
      <div className="rw-cmdlib-body">
        <section>
          <h3>
            历史 <small>{history.length}</small>
          </h3>
          {history.length ? (
            <ul>
              {history.map((entry) => (
                <li key={entry.id}>
                  <button
                    className="rw-cmdlib-command"
                    title="填入命令栏"
                    onClick={() => {
                      onPick(entry.command);
                      onNotice("已填入命令栏，Enter 才会发送");
                    }}
                  >
                    <code>{entry.command}</code>
                    <small>
                      {entry.uses} 次 ·{" "}
                      {new Date(entry.lastUsedAt).toLocaleString("zh-CN")}
                    </small>
                  </button>
                  <button
                    className="rw-icon"
                    aria-label={`删除命令 ${entry.command}`}
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api.post("/commands/delete", {
                          hostId,
                          id: entry.id,
                        }),
                      )
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rw-cmdlib-empty">
              还没有历史。用命令栏发送命令后会自动记录（密码类命令不入库）。
            </p>
          )}
        </section>
        <section>
          <h3>
            片段 <small>{snippets.length}</small>
            <button
              className="rw-cmdlib-add"
              aria-label="新建片段"
              onClick={() =>
                setForm({ name: "", command: "", group: "", global: false })
              }
            >
              <Plus size={12} />
              新建
            </button>
          </h3>
          {snippets.length ? (
            <ul>
              {snippets.map((snippet) => (
                <li key={snippet.id}>
                  <button
                    className="rw-cmdlib-command"
                    title="填入命令栏"
                    onClick={() => {
                      onPick(snippet.command);
                      onNotice("已填入命令栏，Enter 才会发送");
                    }}
                  >
                    <strong>{snippet.name}</strong>
                    <code>{snippet.command}</code>
                    <small>
                      {snippet.hostId ? "仅此主机" : "全局"}
                      {snippet.group ? ` · ${snippet.group}` : ""}
                    </small>
                  </button>
                  <button
                    className="rw-icon"
                    aria-label={`编辑片段 ${snippet.name}`}
                    onClick={() =>
                      setForm({
                        id: snippet.id,
                        name: snippet.name,
                        command: snippet.command,
                        group: snippet.group,
                        global: !snippet.hostId,
                      })
                    }
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    className="rw-icon"
                    aria-label={`删除片段 ${snippet.name}`}
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api.post("/commands/snippets/delete", {
                          id: snippet.id,
                        }),
                      )
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rw-cmdlib-empty">还没有片段。</p>
          )}
        </section>
      </div>
      {form && (
        <form
          className="rw-cmdlib-form"
          aria-label="保存命令片段"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api.post("/commands/snippets/save", {
                id: form.id,
                hostId: form.global ? undefined : hostId,
                name: form.name.trim(),
                command: form.command,
                group: form.group.trim() || undefined,
              });
              setForm(undefined);
            });
          }}
        >
          <label>
            名称
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            命令
            <input
              required
              spellCheck={false}
              value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
            />
          </label>
          <div className="rw-cmdlib-form-row">
            <label>
              分组
              <input
                value={form.group}
                onChange={(e) => setForm({ ...form, group: e.target.value })}
              />
            </label>
            <label className="rw-cmdlib-check">
              <input
                type="checkbox"
                checked={form.global}
                onChange={(e) => setForm({ ...form, global: e.target.checked })}
              />
              全局片段
            </label>
          </div>
          <footer>
            <button type="button" onClick={() => setForm(undefined)}>
              取消
            </button>
            <button type="submit" className="rw-button primary" disabled={busy}>
              保存片段
            </button>
          </footer>
        </form>
      )}
      {confirmClear && (
        <ConfirmDialog
          title="清空命令历史？"
          description="清空这台服务器的命令历史？命令片段不受影响。"
          confirm="清空历史"
          danger
          busy={busy}
          onClose={() => setConfirmClear(false)}
          onConfirm={async () => {
            await act(() => api.post("/commands/clear", { hostId }));
            setConfirmClear(false);
          }}
        />
      )}
    </aside>
  );
}

export const commandPath = (cwd: string, name: string) => remoteJoin(cwd, name);
