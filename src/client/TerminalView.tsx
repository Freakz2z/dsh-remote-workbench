import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { RotateCw, Hand, TerminalSquare } from "lucide-react";
import { api } from "./api.ts";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHandle {
  /** Write literal input to the PTY. Returns false when this view cannot write. */
  send(text: string): boolean;
  focus(): void;
  /** Whether this display currently holds the input right. */
  writable(): boolean;
  clear(): void;
  getSelection(): string;
  find(
    query: string,
    direction?: "next" | "prev",
  ): { found: boolean; current: number; total: number };
}
export interface TerminalStatus {
  id: string;
  state: "connecting" | "ready" | "closed";
  writable: boolean;
}

function isDarkColor(color: string): boolean {
  const m = color.match(/\d+/g);
  if (!m || m.length < 3)
    return document.body.hasAttribute("data-ds-dark-theme");
  const [r, g, b] = m.map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

const LIGHT_ANSI = {
  black: "#1f2328",
  red: "#cf222e",
  green: "#116329",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#7d4e00",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

const DARK_ANSI = {
  black: "#2c2e33",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e5e7eb",
  brightBlack: "#6b7280",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f9fafb",
};

/**
 * Read the live DSH theme from the surrounding workbench. Every value comes
 * from a host token bridged onto `.rw-workbench`, so the terminal follows the
 * DSH light/dark palette and the terminal font-size setting.
 */
function readTerminalPalette(node: HTMLElement | null) {
  const shell =
    (node?.closest(".rw-workbench") as HTMLElement | null) ?? document.body;
  const style = getComputedStyle(shell);
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  const background = read("--rw-term-bg", "#ffffff");
  const foreground = read("--rw-term-fg", "#0f1115");
  const dark =
    document.body.hasAttribute("data-ds-dark-theme") || isDarkColor(background);
  const chosen = read("--dsh-font-family-terminal", "");
  const codeFamily = read(
    "--ds-font-family-code",
    '"SF Mono", Consolas, "Liberation Mono", monospace',
  );
  const fontSize =
    Number.parseFloat(read("--dsh-terminal-font-size", "13px")) || 13;
  return {
    theme: {
      background,
      foreground,
      cursor: foreground,
      cursorAccent: background,
      selectionBackground: dark
        ? "rgba(96, 165, 250, 0.28)"
        : "rgba(65, 118, 230, 0.2)",
      selectionInactiveBackground: dark
        ? "rgba(96, 165, 250, 0.16)"
        : "rgba(65, 118, 230, 0.12)",
      ...(dark ? DARK_ANSI : LIGHT_ANSI),
    },
    fontFamily: chosen ? `${chosen}, ${codeFamily}` : codeFamily,
    fontSize,
  };
}

export const TerminalView = forwardRef<
  TerminalHandle,
  {
    id: string;
    visible: boolean;
    onSelection(text: string): void;
    onStatus?(status: TerminalStatus): void;
    onRestart?(): void;
  }
>(function TerminalView(
  { id, visible, onSelection, onStatus, onRestart },
  ref,
) {
  const element = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"connecting" | "ready" | "closed">(
    "connecting",
  );
  const [writable, setWritable] = useState(true);
  const [exited, setExited] = useState(false);
  const [message, setMessage] = useState("");
  const [generation, setGeneration] = useState(0);
  const socket = useRef<WebSocket>();
  const termRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();
  const selectRef = useRef(onSelection);
  selectRef.current = onSelection;
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const writableRef = useRef(true);
  const stateRef = useRef<"connecting" | "ready" | "closed">("connecting");
  const searchRef = useRef<{ query: string; index: number }>({
    query: "",
    index: -1,
  });
  writableRef.current = writable;
  stateRef.current = state;

  const publish = () => {
    statusRef.current?.({
      id,
      state: stateRef.current,
      writable: writableRef.current,
    });
  };

  useImperativeHandle(
    ref,
    () => ({
      send(text: string) {
        const ws = socket.current;
        if (!ws || ws.readyState !== WebSocket.OPEN || !writableRef.current)
          return false;
        ws.send(JSON.stringify({ type: "input", data: text }));
        termRef.current?.focus();
        return true;
      },
      focus() {
        termRef.current?.focus();
      },
      writable: () => writableRef.current,
      clear() {
        termRef.current?.clear();
        searchRef.current = { query: "", index: -1 };
      },
      getSelection() {
        return termRef.current?.getSelection() ?? "";
      },
      find(query: string, direction: "next" | "prev" = "next") {
        const terminal = termRef.current;
        if (!terminal || !query) {
          searchRef.current = { query: "", index: -1 };
          return { found: false, current: 0, total: 0 };
        }
        const buf = terminal.buffer.active;
        const needle = query.toLowerCase();
        const hits: { row: number; col: number }[] = [];
        for (let row = 0; row < buf.length; row++) {
          const text = buf.getLine(row)?.translateToString(true) ?? "";
          if (!text) continue;
          const lower = text.toLowerCase();
          let col = lower.indexOf(needle);
          while (col !== -1) {
            hits.push({ row, col });
            col = lower.indexOf(needle, col + Math.max(1, needle.length));
          }
        }
        if (!hits.length) {
          searchRef.current = { query, index: -1 };
          return { found: false, current: 0, total: 0 };
        }
        let nextIdx: number;
        if (searchRef.current.query !== query || searchRef.current.index < 0) {
          nextIdx = direction === "prev" ? hits.length - 1 : 0;
        } else {
          nextIdx =
            direction === "prev"
              ? (searchRef.current.index - 1 + hits.length) % hits.length
              : (searchRef.current.index + 1) % hits.length;
        }
        searchRef.current = { query, index: nextIdx };
        const hit = hits[nextIdx]!;
        terminal.select(hit.col, hit.row, query.length);
        terminal.scrollToLine(Math.max(0, hit.row - 3));
        return { found: true, current: nextIdx + 1, total: hits.length };
      },
    }),
    [],
  );

  useEffect(() => {
    if (!element.current) return;
    const palette = readTerminalPalette(element.current);
    const terminal = new Terminal({
      fontFamily: palette.fontFamily,
      fontSize: palette.fontSize,
      cursorBlink: true,
      scrollback: 5000,
      minimumContrastRatio: 4.5,
      allowProposedApi: false,
      theme: palette.theme,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current);
    termRef.current = terminal;
    fitRef.current = fit;
    let disposed = false;
    setState("connecting");
    setMessage("");
    let ws: WebSocket;
    try {
      ws = api.socket(id);
      socket.current = ws;
    } catch (error) {
      setState("closed");
      setMessage((error as Error).message);
      terminal.dispose();
      return;
    }
    const resize = () => {
      if (!element.current?.clientWidth || !element.current?.clientHeight)
        return;
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: terminal.cols,
              rows: terminal.rows,
            }),
          );
      } catch {}
    };
    ws.onopen = () => {
      if (!disposed) {
        setState("ready");
        resize();
        terminal.focus();
      }
    };
    ws.onmessage = (event) => {
      const v = JSON.parse(event.data);
      if (v.type === "replay") {
        terminal.reset();
        terminal.write(v.data);
        if (v.status === "exited") {
          setExited(true);
          setState("closed");
          setMessage("远端 Shell 已退出，历史输出保留在此处");
        }
      }
      if (v.type === "output") terminal.write(v.data);
      if (v.type === "exit") {
        setExited(true);
        setState("closed");
        setMessage(`Shell 已退出${v.code !== undefined ? " · " + v.code : ""}`);
      }
      if (v.type === "error") setMessage(v.message);
      if (v.type === "ownership") setWritable(v.writable);
      if (v.type === "ownershipChanged") setWritable(false);
    };
    ws.onclose = () => {
      if (!disposed) {
        setState("closed");
        setMessage(
          (prev) => prev || "显示连接已断开，宿主中的终端会话仍可尝试重新连接",
        );
      }
    };
    ws.onerror = () => {
      if (!disposed) setMessage("终端连接失败，请检查 DSH 流通道");
    };
    const input = terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "input", data }));
    });
    const selection = terminal.onSelectionChange(() =>
      selectRef.current(terminal.getSelection()),
    );
    const observer = new ResizeObserver(resize);
    observer.observe(element.current);
    resize();
    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      selection.dispose();
      ws.close();
      terminal.dispose();
      termRef.current = undefined;
    };
  }, [id, generation]);
  useEffect(() => {
    const node = element.current;
    const terminal = termRef.current;
    if (!node || !terminal) return;
    const apply = () => {
      const next = readTerminalPalette(node);
      terminal.options.theme = next.theme;
      if (
        terminal.options.fontFamily !== next.fontFamily ||
        terminal.options.fontSize !== next.fontSize
      ) {
        terminal.options.fontFamily = next.fontFamily;
        terminal.options.fontSize = next.fontSize;
      }
      try {
        fitRef.current?.fit();
      } catch {}
    };
    apply();
    const observer = new MutationObserver(apply);
    const options = { attributes: true as const };
    observer.observe(document.body, {
      ...options,
      attributeFilter: ["data-ds-dark-theme", "style", "class"],
    });
    observer.observe(document.documentElement, {
      ...options,
      attributeFilter: ["data-ds-theme-source", "style", "class"],
    });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", apply);
    };
  }, [id, generation]);
  useEffect(() => {
    publish();
  }, [state, writable, id]);
  useEffect(() => {
    if (visible)
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch {}
      });
  }, [visible]);
  return (
    <div
      className="rw-terminal-instance"
      style={{ display: visible ? "flex" : "none" }}
    >
      {(!writable || state === "closed") && (
        <div className="rw-terminal-notice">
          <span>
            {!writable ? "当前为只读显示，另一窗口拥有输入权" : message}
          </span>
          {!writable ? (
            <button
              onClick={() =>
                socket.current?.send(JSON.stringify({ type: "takeover" }))
              }
            >
              <Hand size={12} />
              接管输入
            </button>
          ) : exited ? (
            onRestart && (
              <button type="button" onClick={onRestart}>
                <RotateCw size={12} />
                新建终端
              </button>
            )
          ) : (
            <button
              type="button"
              onClick={() => setGeneration((n) => n + 1)}
            >
              <RotateCw size={12} />
              重新连接显示
            </button>
          )}
        </div>
      )}
      {state === "connecting" && (
        <div className="rw-terminal-connecting">
          <TerminalSquare size={16} />
          <span>正在连接远程终端…</span>
        </div>
      )}
      <div className="rw-xterm" ref={element} />
    </div>
  );
});
