import { useEffect, useMemo, useRef, useState } from "react";
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { sql } from "@codemirror/legacy-modes/mode/sql";
import { go } from "@codemirror/legacy-modes/mode/go";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { ChevronDown, ChevronUp, Replace, Search, X } from "lucide-react";

const dshHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.moduleKeyword],
    color: "var(--rw-syn-keyword)",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: "var(--rw-syn-string)",
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--rw-syn-comment)",
    fontStyle: "italic",
  },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom],
    color: "var(--rw-syn-number)",
  },
  {
    tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
    color: "var(--rw-syn-fn)",
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace],
    color: "var(--rw-syn-type)",
  },
  {
    tag: [tags.propertyName, tags.attributeName, tags.tagName],
    color: "var(--rw-syn-prop)",
  },
  {
    tag: [tags.operator, tags.punctuation],
    color: "var(--rw-syn-op)",
  },
  {
    tag: [tags.meta, tags.processingInstruction],
    color: "var(--rw-syn-meta)",
  },
  {
    tag: tags.heading,
    color: "var(--rw-syn-heading)",
    fontWeight: "600",
  },
  {
    tag: tags.emphasis,
    fontStyle: "italic",
  },
  {
    tag: tags.strong,
    fontWeight: "600",
  },
  {
    tag: tags.link,
    color: "var(--rw-link)",
    textDecoration: "underline",
  },
  {
    tag: tags.invalid,
    color: "var(--rw-danger)",
    textDecoration: "underline wavy",
  },
]);

export function languageLabel(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  if (name === "dockerfile") return "Dockerfile";
  if (name.endsWith(".nginx") || name === "nginx.conf") return "Nginx";
  const map: Record<string, string> = {
    ts: "TypeScript",
    mts: "TypeScript",
    cts: "TypeScript",
    tsx: "TSX",
    js: "JavaScript",
    mjs: "JavaScript",
    cjs: "JavaScript",
    jsx: "JSX",
    json: "JSON",
    jsonc: "JSONC",
    md: "Markdown",
    markdown: "Markdown",
    html: "HTML",
    htm: "HTML",
    vue: "Vue",
    css: "CSS",
    scss: "SCSS",
    less: "Less",
    py: "Python",
    sh: "Shell",
    bash: "Bash",
    zsh: "Zsh",
    fish: "Fish",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    sql: "SQL",
    go: "Go",
    lua: "Lua",
    rb: "Ruby",
    pl: "Perl",
    diff: "Diff",
    patch: "Patch",
    conf: "Config",
    ini: "INI",
    properties: "Properties",
    env: "Env",
  };
  return map[ext] ?? "文本";
}

/** Legacy stream modes are typed with their own state; CM accepts them as unknown. */
const legacyMode = (mode: unknown) => StreamLanguage.define(mode as never);

export function languageFor(path: string): Extension | null {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
    case "jsonc":
      return json();
    case "md":
    case "markdown":
      return markdown();
    case "html":
    case "htm":
    case "vue":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    case "py":
      return python();
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return legacyMode(shell);
    case "yaml":
    case "yml":
      return legacyMode(yaml);
    case "toml":
      return legacyMode(toml);
    case "sql":
      return legacyMode(sql);
    case "go":
      return legacyMode(go);
    case "lua":
      return legacyMode(lua);
    case "rb":
      return legacyMode(ruby);
    case "pl":
      return legacyMode(perl);
    case "diff":
    case "patch":
      return legacyMode(diff);
    case "conf":
    case "ini":
    case "properties":
    case "env":
      return legacyMode(properties);
    default:
      if (name === "dockerfile") return legacyMode(dockerFile);
      if (name.endsWith(".nginx")) return legacyMode(nginx);
      return null;
  }
}

function matchRanges(
  text: string,
  query: string,
  caseSensitive: boolean,
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  if (!query) return out;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  let index = haystack.indexOf(needle);
  while (index !== -1 && out.length < 5000) {
    out.push({ from: index, to: index + query.length });
    index = haystack.indexOf(needle, index + Math.max(1, needle.length));
  }
  return out;
}

function highlightField(read: () => { query: string; caseSensitive: boolean }) {
  const mark = Decoration.mark({ class: "rw-find-hit" });
  const build = (text: string, query: string, caseSensitive: boolean) => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const range of matchRanges(text, query, caseSensitive))
      builder.add(range.from, range.to, mark);
    return builder.finish();
  };
  return StateField.define({
    create(state) {
      const { query, caseSensitive } = read();
      return build(state.doc.toString(), query, caseSensitive);
    },
    update(value, tr) {
      const { query, caseSensitive } = read();
      if (tr.docChanged)
        return build(tr.state.doc.toString(), query, caseSensitive);
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

/**
 * CodeMirror 6 editor with DSH styling, syntax highlighting and an in-pane
 * find/replace bar. Matches come from editor transactions, so replacing keeps
 * undo/redo and the draft state consistent.
 */
export function CodeEditor({
  value,
  path,
  ariaLabel,
  readOnly,
  wrap = true,
  findTrigger = 0,
  onToggleWrap,
  onChange,
  onSave,
}: {
  value: string;
  path: string;
  ariaLabel: string;
  readOnly?: boolean;
  wrap?: boolean;
  findTrigger?: number;
  onToggleWrap?(): void;
  onChange(next: string): void;
  onSave?(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const findInputRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [localWrap, setLocalWrap] = useState(wrap);
  const [cursor, setCursor] = useState({ line: 1, col: 1, lines: 1 });
  const effectiveWrap = onToggleWrap ? wrap : localWrap;
  const language = useMemo(() => languageFor(path), [path]);
  const langName = useMemo(() => languageLabel(path), [path]);
  const searchCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const queryRef = useRef(query);
  const caseRef = useRef(caseSensitive);
  queryRef.current = query;
  caseRef.current = caseSensitive;

  const matches = useMemo(
    () => (query ? matchRanges(value, query, caseSensitive) : []),
    [value, query, caseSensitive],
  );

  useEffect(() => {
    if (!host.current) return;
    const read = () => ({
      query: queryRef.current,
      caseSensitive: caseRef.current,
    });
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          syntaxHighlighting(dshHighlightStyle, { fallback: true }),
          ...(language ? [language] : []),
          keymap.of([
            {
              key: "Mod-f",
              run: () => {
                setFindOpen(true);
                requestAnimationFrame(() => findInputRef.current?.focus());
                return true;
              },
            },
            {
              key: "Mod-s",
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              onChangeRef.current(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              setCursor({
                line: line.number,
                col: head - line.from + 1,
                lines: update.state.doc.lines,
              });
            }
          }),
          searchCompartment.current.of(highlightField(read)),
          editableCompartment.current.of([
            EditorView.editable.of(!readOnly),
            EditorState.readOnly.of(!!readOnly),
          ]),
          wrapCompartment.current.of(effectiveWrap ? EditorView.lineWrapping : []),
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel,
            "aria-multiline": "true",
            spellcheck: "false",
          }),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": {
              fontFamily: "var(--rw-font-code)",
              fontSize: "var(--rw-code-size)",
              lineHeight: "1.7",
            },
            ".cm-content": {
              padding: "8px 0 24px",
              caretColor: "var(--rw-text)",
            },
            ".cm-cursor, .cm-dropCursor": {
              borderLeftColor: "var(--rw-text)",
            },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
              backgroundColor: "color-mix(in srgb, var(--rw-link) 24%, transparent)",
            },
            ".cm-activeLine": {
              backgroundColor: "color-mix(in srgb, var(--rw-hover) 70%, transparent)",
            },
            ".cm-activeLineGutter": {
              backgroundColor: "transparent",
              color: "var(--rw-text-2)",
            },
            ".cm-matchingBracket": {
              backgroundColor: "color-mix(in srgb, var(--rw-link) 18%, transparent)",
              outline: "1px solid color-mix(in srgb, var(--rw-link) 45%, transparent)",
            },
            ".cm-gutters": {
              background: "var(--rw-layer-2)",
              color: "var(--rw-caption)",
              border: "none",
            },
          }),
        ],
      }),
    });
    const head = editor.state.selection.main.head;
    const line = editor.state.doc.lineAt(head);
    setCursor({
      line: line.number,
      col: head - line.from + 1,
      lines: editor.state.doc.lines,
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = undefined;
    };
  }, [path, ariaLabel]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value)
      editor.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: searchCompartment.current.reconfigure(
        highlightField(() => ({
          query: queryRef.current,
          caseSensitive: caseRef.current,
        })),
      ),
    });
  }, [query, caseSensitive]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editableCompartment.current.reconfigure([
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(!!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({
      effects: wrapCompartment.current.reconfigure(
        effectiveWrap ? EditorView.lineWrapping : [],
      ),
    });
  }, [effectiveWrap]);

  useEffect(() => {
    if (findTrigger > 0) {
      setFindOpen(true);
      requestAnimationFrame(() => findInputRef.current?.focus());
    }
  }, [findTrigger]);

  const jump = (index: number) => {
    const editor = view.current;
    if (!editor || !matches.length) return;
    const target = (index + matches.length) % matches.length;
    setMatchIndex(target);
    const range = matches[target];
    editor.dispatch({
      selection: { anchor: range.from, head: range.to },
      scrollIntoView: true,
    });
    editor.focus();
  };

  const replaceCurrent = () => {
    const editor = view.current;
    if (!editor || !matches.length) return;
    const range = matches[Math.min(matchIndex, matches.length - 1)];
    editor.dispatch({
      changes: { from: range.from, to: range.to, insert: replacement },
      selection: { anchor: range.from + replacement.length },
    });
  };

  const replaceAll = () => {
    const editor = view.current;
    if (!editor || !matches.length) return;
    editor.dispatch({
      changes: matches.map((range) => ({
        from: range.from,
        to: range.to,
        insert: replacement,
      })),
    });
    setMatchIndex(0);
  };

  return (
    <div className="rw-code-editor">
      {findOpen && (
        <div
          className="rw-find"
          role="search"
          aria-label="查找与替换"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setFindOpen(false);
              view.current?.focus();
            }
          }}
        >
          <div className="rw-find-row">
            <Search size={13} aria-hidden="true" />
            <input
              ref={findInputRef}
              autoFocus
              aria-label="查找"
              placeholder="查找"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatchIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  jump(e.shiftKey ? matchIndex - 1 : matchIndex + 1);
                }
              }}
            />
            <span className="rw-find-count" aria-live="polite">
              {query
                ? `${matches.length ? matchIndex + 1 : 0}/${matches.length}`
                : ""}
            </span>
            <button
              aria-label="上一个匹配"
              title="上一个匹配 (Shift+Enter)"
              disabled={!matches.length}
              onClick={() => jump(matchIndex - 1)}
            >
              <ChevronUp size={13} />
            </button>
            <button
              aria-label="下一个匹配"
              title="下一个匹配 (Enter)"
              disabled={!matches.length}
              onClick={() => jump(matchIndex + 1)}
            >
              <ChevronDown size={13} />
            </button>
            <button
              aria-label="区分大小写"
              aria-pressed={caseSensitive}
              title="区分大小写"
              className={caseSensitive ? "active" : ""}
              onClick={() => setCaseSensitive((v) => !v)}
            >
              Aa
            </button>
            <button aria-label="关闭查找" onClick={() => setFindOpen(false)}>
              <X size={13} />
            </button>
          </div>
          <div className="rw-find-row">
            <Replace size={13} aria-hidden="true" />
            <input
              aria-label="替换为"
              placeholder="替换为"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
            />
            <button
              className="rw-find-action"
              disabled={!matches.length}
              onClick={replaceCurrent}
            >
              替换
            </button>
            <button
              className="rw-find-action"
              disabled={!matches.length}
              onClick={replaceAll}
            >
              全部替换
            </button>
          </div>
        </div>
      )}
      <div className="rw-code-host" ref={host} />
      <div className="rw-code-statusbar">
        <span>{langName}</span>
        <span>
          行 {cursor.line}, 列 {cursor.col}
        </span>
        <span>{cursor.lines} 行</span>
        {readOnly && <span className="rw-code-ro">只读</span>}
        <button
          type="button"
          className={effectiveWrap ? "active" : ""}
          aria-pressed={effectiveWrap}
          title="切换自动换行"
          onClick={() =>
            onToggleWrap ? onToggleWrap() : setLocalWrap((v) => !v)
          }
        >
          自动换行
        </button>
        <span>UTF-8</span>
      </div>
    </div>
  );
}
