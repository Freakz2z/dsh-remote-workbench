import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { previewUrl } from "../api.ts";

/** POSIX-style path join/normalise for remote paths (no node:path in browser). */
export function resolveRemotePath(directory: string, relative: string): string {
  if (relative.startsWith("/")) return normalise(relative);
  const parts = (directory.replace(/\/+$/, "") + "/" + relative).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}
function normalise(path: string): string {
  return resolveRemotePath("/", path.replace(/^\/+/, ""));
}

const SAFE_PROTOCOL = /^(https?:|mailto:)/i;

/**
 * Sanitised Markdown preview. HTML is rendered by marked, scrubbed by
 * DOMPurify with scripts/styles/forms removed, then relative images are
 * rewritten to the host preview route so remote assets load from the same
 * server without executing anything.
 */
export function MarkdownPreview({
  source,
  hostId,
  hostRevision,
  directory,
  onOpenPath,
}: {
  source: string;
  hostId: string;
  /** Revision of the connection the document was opened against. */
  hostRevision?: number;
  directory: string;
  onOpenPath?(path: string): void;
}) {
  const html = useMemo(() => {
    const raw = marked.parse(source, { async: false, gfm: true });
    const clean = DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: [
        "style",
        "form",
        "input",
        "button",
        "iframe",
        "object",
        "embed",
        "script",
      ],
      FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
    });
    const doc = new DOMParser().parseFromString(clean, "text/html");
    for (const image of doc.querySelectorAll("img")) {
      const src = image.getAttribute("src") ?? "";
      if (!src) {
        image.remove();
        continue;
      }
      if (/^data:image\//i.test(src)) continue;
      if (/^https?:/i.test(src)) {
        // External assets need a user gesture: reading a remote document must
        // not silently phone the internet from the DSH page.
        const holder = doc.createElement("span");
        holder.className = "rw-md-external";
        holder.setAttribute("data-rw-external", src);
        holder.setAttribute("role", "button");
        holder.setAttribute("tabindex", "0");
        holder.setAttribute(
          "title",
          image.getAttribute("alt") || "加载外部图片",
        );
        let host = "外部";
        try {
          host = new URL(src).host;
        } catch {}
        holder.textContent = `加载外部图片 · ${host}`;
        image.replaceWith(holder);
        continue;
      }
      image.setAttribute(
        "src",
        previewUrl(hostId, resolveRemotePath(directory, src), hostRevision),
      );
      image.setAttribute("loading", "lazy");
      image.setAttribute("alt", image.getAttribute("alt") ?? "");
    }
    for (const anchor of doc.querySelectorAll("a")) {
      const href = anchor.getAttribute("href") ?? "";
      if (!href) continue;
      if (href.startsWith("#")) continue;
      if (SAFE_PROTOCOL.test(href)) {
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
        continue;
      }
      // Relative links stay inside the remote host: open them in the editor.
      const target = resolveRemotePath(directory, href);
      anchor.removeAttribute("target");
      anchor.setAttribute("href", "#");
      anchor.setAttribute("data-rw-path", target);
    }
    return doc.body.innerHTML;
  }, [source, hostId, hostRevision, directory]);

  return (
    <div
      className="rw-markdown"
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const external = target.closest("[data-rw-external]");
        if (external) {
          const image = document.createElement("img");
          image.src = external.getAttribute("data-rw-external")!;
          image.setAttribute("referrerpolicy", "no-referrer");
          image.setAttribute("loading", "lazy");
          image.alt = "";
          external.replaceWith(image);
          return;
        }
        const anchor = target.closest("a[data-rw-path]");
        if (!anchor) return;
        e.preventDefault();
        onOpenPath?.(anchor.getAttribute("data-rw-path")!);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const external = (e.target as HTMLElement).closest(
          "[data-rw-external]",
        );
        if (!external) return;
        e.preventDefault();
        const image = document.createElement("img");
        image.src = external.getAttribute("data-rw-external")!;
        image.setAttribute("referrerpolicy", "no-referrer");
        image.alt = "";
        external.replaceWith(image);
      }}
      // Content is sanitised above; scripts and event handlers are removed.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
