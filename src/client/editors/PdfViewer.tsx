import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  LoaderCircle,
  RotateCcw,
  RotateCw,
  Save,
  TextCursorInput,
  Trash2,
  X,
} from "lucide-react";
import workerSource from "pdfjs-dist/build/pdf.worker.min.mjs?raw";
import { API_PREFIX } from "../../shared/types.ts";
import { api, ApiError, downloadUrl } from "../api.ts";

export interface PdfAnnotation {
  id: string;
  page: number;
  /** PDF user-space coordinates (origin bottom-left). */
  x: number;
  y: number;
  text: string;
  fontSize: number;
}
/** Everything the user changed in a PDF; lives on the tab so it survives switches. */
export interface PdfDraft {
  annotations: PdfAnnotation[];
  rotateBy: number;
  values: Record<string, string>;
  page: number;
  zoom: number;
  /** Default in the narrow sidebar: scale each page to the available width. */
  fitWidth: boolean;
}
export const emptyPdfDraft = (): PdfDraft => ({
  annotations: [],
  rotateBy: 0,
  values: {},
  page: 1,
  zoom: 1,
  fitWidth: true,
});
export const pdfDraftDirty = (draft?: PdfDraft): boolean =>
  !!draft &&
  (draft.annotations.length > 0 ||
    draft.rotateBy !== 0 ||
    Object.keys(draft.values).length > 0);

interface FormField {
  name: string;
  type: "text" | "checkbox" | "radio" | "dropdown" | "option";
  value: string;
  checked: boolean;
  options: string[];
}
type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | undefined;
let workerUrl: string | undefined;

/**
 * pdf.js with a module worker built from the raw worker source. The worker runs
 * in its own context, so it neither blocks the conversation nor touches the
 * host page's globals (DSH may run its own pdf.js).
 */
function loadPdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import("pdfjs-dist");
    if (!workerUrl) {
      workerUrl = URL.createObjectURL(
        new Blob([workerSource], { type: "text/javascript" }),
      );
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    }
    return pdfjs;
  })();
  return pdfjsPromise;
}

/** Base for bundled cMap/font/wasm/icc assets, served by the host (no CDN). */
function assetBase(): string {
  const transport = (
    globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }
  ).__DSH_TRANSPORT__;
  const relative = API_PREFIX + "/assets/pdfjs/";
  if (location.protocol === "http:" || location.protocol === "https:")
    return new URL(relative, location.origin).toString();
  // Desktop renders from dsh-app://; the loopback stream URL is reachable from
  // the worker and the asset route allows the dsh-app origin.
  if (transport?.streamBaseUrl)
    return new URL(relative, transport.streamBaseUrl).toString();
  return relative;
}

const ZOOMS = [0.75, 1, 1.25, 1.5, 2];
const CJK = /[^\x00-\x7F]/;

/**
 * PDF preview and annotation editor. pdf.js renders pages; pdf-lib applies
 * rotations, text annotations and existing form values, then the host saves the
 * bytes with the original etag so concurrent edits are never overwritten.
 * Rotation/annotation/form state is owned by the caller (the file tab), so it
 * survives tab, mode and sidebar switches.
 */
export function PdfViewer({
  hostId,
  path,
  name,
  bytes,
  etag,
  hostRevision,
  draft,
  onDraft,
  onSaved,
  onNotice,
}: {
  hostId: string;
  path: string;
  name: string;
  bytes: Uint8Array;
  etag?: string;
  hostRevision?: number;
  draft: PdfDraft;
  onDraft(next: PdfDraft): void;
  onSaved(result: { etag: string; size: number; hostRevision: number }): void;
  onNotice(text: string, error?: boolean): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const document =
    useRef<Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>>();
  const loading = useRef<ReturnType<PdfJs["getDocument"]>>();
  const viewportRef = useRef<{
    convertToPdfPoint(x: number, y: number): number[];
    convertToViewportPoint(x: number, y: number): number[];
  }>();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [renderError, setRenderError] = useState("");
  const renderTask = useRef<{ cancel(): void; promise: Promise<unknown> }>();
  const stage = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [fields, setFields] = useState<FormField[]>([]);
  const [saving, setSaving] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [composer, setComposer] = useState<{ x: number; y: number }>();
  const [composerText, setComposerText] = useState("");
  const [showForms, setShowForms] = useState(false);
  const [tick, setTick] = useState(0);
  const page = draft.page;

  const setDraft = (patch: Partial<PdfDraft>) =>
    onDraft({ ...draft, ...patch });

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError("");
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const base = assetBase();
        const task = pdfjs.getDocument({
          data: bytes.slice(),
          cMapUrl: base + "cmaps/",
          cMapPacked: true,
          standardFontDataUrl: base + "standard_fonts/",
          wasmUrl: base + "wasm/",
          iccUrl: base + "iccs/",
        });
        loading.current = task;
        const loaded = await task.promise;
        if (cancelled) {
          void task.destroy();
          return;
        }
        document.current = loaded;
        setPageCount(loaded.numPages);
        if (draft.page > loaded.numPages)
          onDraft({ ...draft, page: loaded.numPages });
        try {
          const {
            PDFDocument,
            PDFTextField,
            PDFCheckBox,
            PDFRadioGroup,
            PDFDropdown,
            PDFOptionList,
          } = await import("pdf-lib");
          const lib = await PDFDocument.load(bytes.slice(), {
            ignoreEncryption: true,
          });
          const form = lib.getForm();
          const list: FormField[] = [];
          for (const field of form.getFields()) {
            if (field instanceof PDFTextField)
              list.push({
                name: field.getName(),
                type: "text",
                value: field.getText() ?? "",
                checked: false,
                options: [],
              });
            else if (field instanceof PDFCheckBox)
              list.push({
                name: field.getName(),
                type: "checkbox",
                value: "",
                checked: field.isChecked(),
                options: [],
              });
            else if (field instanceof PDFRadioGroup)
              list.push({
                name: field.getName(),
                type: "radio",
                value: field.getSelected() ?? "",
                checked: false,
                options: field.getOptions(),
              });
            else if (
              field instanceof PDFDropdown ||
              field instanceof PDFOptionList
            )
              list.push({
                name: field.getName(),
                type: field instanceof PDFDropdown ? "dropdown" : "option",
                value: field.getSelected()[0] ?? "",
                checked: false,
                options: field.getOptions(),
              });
          }
          if (!cancelled) setFields(list);
        } catch {
          if (!cancelled) setFields([]);
        }
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || "无法读取这个 PDF");
      }
    })();
    return () => {
      cancelled = true;
      void loading.current?.destroy();
      loading.current = undefined;
      document.current = undefined;
    };
    // Re-parse only when the bytes change; the draft lives outside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  const render = useCallback(async () => {
    const pdf = document.current;
    const target = canvas.current;
    if (!pdf || !target || !pageCount) return;
    try {
      const pdfPage = await pdf.getPage(page);
      const baseRotation = pdfPage.rotate ?? 0;
      const rotated = (((baseRotation + draft.rotateBy) % 360) + 360) % 360;
      let scale = draft.zoom;
      if (draft.fitWidth) {
        const unit = pdfPage.getViewport({ scale: 1, rotation: rotated });
        const available = (stageWidth || stage.current?.clientWidth || 0) - 20;
        scale =
          available > 0 ? Math.max(0.2, available / unit.width) : draft.zoom;
      }
      const viewport = pdfPage.getViewport({ scale, rotation: rotated });
      // Coordinates are valid before the pixels land; clicks can use them.
      viewportRef.current = viewport;
      const ratio = window.devicePixelRatio || 1;
      target.width = Math.floor(viewport.width * ratio);
      target.height = Math.floor(viewport.height * ratio);
      target.style.width = `${Math.floor(viewport.width)}px`;
      target.style.height = `${Math.floor(viewport.height)}px`;
      setSize({ width: viewport.width, height: viewport.height });
      const context = target.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, viewport.width, viewport.height);
      // A newer render cancels the old one; that rejection is expected.
      renderTask.current?.cancel();
      const task = pdfPage.render({
        canvas: target,
        canvasContext: context,
        viewport,
      });
      renderTask.current = task;
      try {
        await task.promise;
      } catch (e) {
        const name = (e as { name?: string }).name;
        if (
          name === "RenderingCancelledException" ||
          /cancelled|canceled/i.test((e as Error).message ?? "")
        )
          return;
        throw e;
      }
      if (renderTask.current !== task) return;
      viewportRef.current = viewport;
      setRenderError("");
      setTick((n) => n + 1);
    } catch (e) {
      setRenderError((e as Error).message || "PDF 渲染失败");
    }
  }, [page, draft.zoom, draft.rotateBy, draft.fitWidth, pageCount, stageWidth]);

  useEffect(() => {
    if (ready) void render();
  }, [ready, render]);

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setStageWidth(node.clientWidth));
    observer.observe(node);
    setStageWidth(node.clientWidth);
    return () => observer.disconnect();
  }, [ready]);

  const dirty = pdfDraftDirty(draft);

  const save = async () => {
    if (!etag || hostRevision === undefined) {
      onNotice("缺少文件版本信息，无法保存批注", true);
      return;
    }
    setSaving(true);
    try {
      const { PDFDocument, StandardFonts, degrees } = await import("pdf-lib");
      const lib = await PDFDocument.load(bytes.slice(), {
        ignoreEncryption: true,
      });
      const Helvetica = await lib.embedFont(StandardFonts.Helvetica);
      const libPages = lib.getPages();
      if (draft.rotateBy !== 0)
        for (const item of libPages) {
          const current = item.getRotation().angle;
          item.setRotation(
            degrees((((current + draft.rotateBy) % 360) + 360) % 360),
          );
        }
      for (const annotation of draft.annotations) {
        const item = libPages[annotation.page - 1];
        if (!item) continue;
        if (!CJK.test(annotation.text)) {
          item.drawText(annotation.text, {
            x: annotation.x,
            y: annotation.y,
            size: annotation.fontSize,
            font: Helvetica,
          });
          continue;
        }
        // CJK text is rasterised locally: no network font, no CDN.
        const raster = window.document.createElement("canvas");
        const scale = 3;
        const font = `${annotation.fontSize * scale}px ${getComputedStyle(documentBody()).fontFamily}`;
        const probe = raster.getContext("2d")!;
        probe.font = font;
        raster.width = Math.max(
          1,
          Math.ceil(probe.measureText(annotation.text).width) + 8,
        );
        raster.height = Math.ceil(annotation.fontSize * scale * 1.5);
        const context = raster.getContext("2d")!;
        context.font = font;
        context.fillStyle = "#000000";
        context.textBaseline = "alphabetic";
        context.fillText(annotation.text, 4, annotation.fontSize * scale);
        const png = await lib.embedPng(raster.toDataURL("image/png"));
        const heightPt = raster.height / scale;
        const widthPt = raster.width / scale;
        item.drawImage(png, {
          x: annotation.x,
          y: annotation.y - heightPt * 0.25,
          width: widthPt,
          height: heightPt,
        });
      }
      if (fields.length && Object.keys(draft.values).length) {
        const form = lib.getForm();
        for (const field of fields) {
          const next = draft.values[field.name];
          if (next === undefined) continue;
          try {
            if (field.type === "text")
              form.getTextField(field.name).setText(next);
            else if (field.type === "checkbox")
              next === "true"
                ? form.getCheckBox(field.name).check()
                : form.getCheckBox(field.name).uncheck();
            else if (field.type === "radio")
              form.getRadioGroup(field.name).select(next);
            else if (field.type === "dropdown")
              form.getDropdown(field.name).select(next);
            else if (field.type === "option")
              form.getOptionList(field.name).select(next);
          } catch (e) {
            onNotice(`${field.name}：${(e as Error).message}`, true);
          }
        }
      }
      const out = await lib.save({
        updateFieldAppearances: fields.length > 0,
      });
      const result = await api.saveBinary(
        { hostId, path, etag, hostRevision: String(hostRevision) },
        new Blob([out as unknown as BlobPart], { type: "application/pdf" }),
      );
      onDraft(emptyPdfDraft());
      setComposer(undefined);
      onSaved(result);
      onNotice("PDF 批注已保存");
    } catch (e) {
      const apiError = e as ApiError;
      if (apiError.code === "FILE_CONFLICT")
        onNotice(
          "文件已被外部修改，保存被拒绝。本地批注与表单修改仍保留。",
          true,
        );
      else onNotice(apiError.message || "保存 PDF 失败", true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rw-pdf">
      <div className="rw-pdf-toolbar">
        <div className="rw-pdf-pages">
          <button
            aria-label="上一页"
            disabled={page <= 1}
            onClick={() => setDraft({ page: Math.max(1, page - 1) })}
          >
            <ChevronLeft size={14} />
          </button>
          <span>
            <input
              aria-label="页码"
              type="number"
              min={1}
              max={pageCount || 1}
              value={page}
              onChange={(e) =>
                setDraft({
                  page: Math.min(
                    pageCount || 1,
                    Math.max(1, Number(e.target.value)),
                  ),
                })
              }
            />{" "}
            / {pageCount || "—"}
          </span>
          <button
            aria-label="下一页"
            disabled={page >= pageCount}
            onClick={() => setDraft({ page: Math.min(pageCount, page + 1) })}
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <label className="rw-pdf-zoom">
          缩放
          <select
            aria-label="PDF 缩放"
            value={draft.fitWidth ? "fit" : String(draft.zoom)}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "fit") setDraft({ fitWidth: true });
              else setDraft({ fitWidth: false, zoom: Number(value) });
            }}
          >
            <option value="fit">适应宽度</option>
            {ZOOMS.map((value) => (
              <option key={value} value={String(value)}>
                {Math.round(value * 100)}%
              </option>
            ))}
          </select>
        </label>
        <button
          className="rw-icon"
          aria-label="逆时针旋转"
          title="整份 PDF 逆时针旋转 90°（保存时写入）"
          onClick={() => setDraft({ rotateBy: draft.rotateBy - 90 })}
        >
          <RotateCcw size={14} />
        </button>
        <button
          className="rw-icon"
          aria-label="顺时针旋转"
          title="整份 PDF 顺时针旋转 90°（保存时写入）"
          onClick={() => setDraft({ rotateBy: draft.rotateBy + 90 })}
        >
          <RotateCw size={14} />
        </button>
        <button
          className={"rw-button" + (showForms ? " active" : "")}
          aria-pressed={showForms}
          aria-label="表单字段"
          onClick={() => setShowForms((v) => !v)}
        >
          <TextCursorInput size={13} />
          表单 {fields.length}
        </button>
        <button
          className="rw-icon"
          aria-label="下载 PDF"
          title="下载原文件"
          onClick={() =>
            window.open(downloadUrl(hostId, path, hostRevision), "_blank")
          }
        >
          <Download size={14} />
        </button>
        <button
          className="rw-button primary"
          aria-label="保存 PDF"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? (
            <LoaderCircle size={13} className="rw-spin" />
          ) : (
            <Save size={13} />
          )}
          保存
        </button>
      </div>
      {error && <div className="rw-pdf-error">{error}</div>}
      {renderError && <div className="rw-pdf-error">{renderError}</div>}
      {!ready ? (
        <div className="rw-pdf-state">
          <LoaderCircle size={20} className="rw-spin" />
          正在解析 PDF…
        </div>
      ) : (
        <div className="rw-pdf-stage" ref={stage}>
          <div
            className="rw-pdf-page"
            style={
              size ? { width: size.width, height: size.height } : undefined
            }
            onMouseDown={(e) => {
              if (e.target !== canvas.current) return;
              const rect = (
                e.target as HTMLCanvasElement
              ).getBoundingClientRect();
              const viewport = viewportRef.current;
              if (!viewport) return;
              const [x, y] = viewport.convertToPdfPoint(
                e.clientX - rect.left,
                e.clientY - rect.top,
              );
              setComposer({ x, y });
              setComposerText("");
            }}
          >
            <canvas ref={canvas} className="rw-pdf-canvas" />
            {composer &&
              size &&
              viewportRef.current &&
              (() => {
                const [vx, vy] = viewportRef.current.convertToViewportPoint(
                  composer.x,
                  composer.y,
                );
                return (
                  <form
                    className="rw-pdf-annotation-draft"
                    style={{ left: vx, top: vy }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!composerText.trim()) return;
                      setDraft({
                        annotations: [
                          ...draft.annotations,
                          {
                            id: crypto.randomUUID(),
                            page,
                            x: composer.x,
                            y: composer.y,
                            text: composerText.trim(),
                            fontSize: 12,
                          },
                        ],
                      });
                      setComposer(undefined);
                      setComposerText("");
                    }}
                  >
                    <input
                      autoFocus
                      aria-label="批注内容"
                      placeholder="输入批注，Enter 添加"
                      value={composerText}
                      onChange={(e) => setComposerText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setComposer(undefined);
                      }}
                    />
                    <button type="submit">添加</button>
                    <button
                      type="button"
                      aria-label="取消批注"
                      onClick={() => setComposer(undefined)}
                    >
                      <X size={12} />
                    </button>
                  </form>
                );
              })()}
            {tick >= 0 &&
              size &&
              viewportRef.current &&
              draft.annotations
                .filter((item) => item.page === page)
                .map((item) => {
                  const [vx, vy] = viewportRef.current!.convertToViewportPoint(
                    item.x,
                    item.y,
                  );
                  return (
                    <span
                      key={item.id}
                      className="rw-pdf-annotation"
                      style={{ left: vx, top: vy }}
                      title={item.text}
                    >
                      {item.text}
                      <button
                        aria-label={`删除批注 ${item.text}`}
                        onClick={() =>
                          setDraft({
                            annotations: draft.annotations.filter(
                              (entry) => entry.id !== item.id,
                            ),
                          })
                        }
                      >
                        <X size={10} />
                      </button>
                    </span>
                  );
                })}
          </div>
        </div>
      )}
      {showForms && (
        <aside className="rw-pdf-forms" aria-label="PDF 表单">
          <header>
            <strong>表单字段</strong>
            <span>{fields.length} 个</span>
          </header>
          {fields.length ? (
            <div className="rw-pdf-forms-list">
              {fields.map((field) => (
                <label key={field.name}>
                  <span>{field.name}</span>
                  {field.type === "checkbox" ? (
                    <input
                      type="checkbox"
                      checked={
                        draft.values[field.name] === "true" ||
                        (draft.values[field.name] === undefined &&
                          field.checked)
                      }
                      onChange={(e) =>
                        setDraft({
                          values: {
                            ...draft.values,
                            [field.name]: String(e.target.checked),
                          },
                        })
                      }
                    />
                  ) : field.type === "dropdown" ||
                    field.type === "radio" ||
                    field.type === "option" ? (
                    <select
                      value={draft.values[field.name] ?? field.value}
                      onChange={(e) =>
                        setDraft({
                          values: {
                            ...draft.values,
                            [field.name]: e.target.value,
                          },
                        })
                      }
                    >
                      <option value="">（未选择）</option>
                      {field.options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={draft.values[field.name] ?? field.value}
                      onChange={(e) =>
                        setDraft({
                          values: {
                            ...draft.values,
                            [field.name]: e.target.value,
                          },
                        })
                      }
                    />
                  )}
                </label>
              ))}
            </div>
          ) : (
            <p className="rw-pdf-forms-empty">
              这个 PDF 没有可填写的表单字段。
            </p>
          )}
        </aside>
      )}
      <footer className="rw-pdf-footer">
        <span>
          {name} · 点击页面添加文字批注
          {dirty ? " · 有未保存修改" : ""}
        </span>
        {draft.annotations.length > 0 && (
          <button
            className="rw-pdf-clear"
            onClick={() => setDraft({ annotations: [] })}
            title="移除本次全部批注"
          >
            <Trash2 size={12} />
            清除批注 ({draft.annotations.length})
          </button>
        )}
        {draft.rotateBy !== 0 && (
          <span className="rw-pdf-rotate">
            旋转 {((draft.rotateBy % 360) + 360) % 360}°
          </span>
        )}
      </footer>
    </div>
  );
}

function documentBody() {
  return globalThis.document?.body ?? globalThis.document?.documentElement;
}
