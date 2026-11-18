import { posix } from "node:path";
import type { RemoteFileKind } from "../shared/workstation.ts";

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
/** HTML and SVG remain source code and never become active same-origin documents. */
export function identifyFile(
  path: string,
  head: Buffer,
): { kind: RemoteFileKind; mime: string } {
  const extension = posix.extname(path).toLowerCase();
  if (head.subarray(0, 5).toString() === "%PDF-")
    return { kind: "pdf", mime: "application/pdf" };
  if (
    head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { kind: "image", mime: "image/png" };
  if (head[0] === 255 && head[1] === 216 && head[2] === 255)
    return { kind: "image", mime: "image/jpeg" };
  if (/^GIF8[79]a/.test(head.subarray(0, 6).toString()))
    return { kind: "image", mime: "image/gif" };
  if (
    head.subarray(0, 4).toString() === "RIFF" &&
    head.subarray(8, 12).toString() === "WEBP"
  )
    return { kind: "image", mime: "image/webp" };
  if (
    head.subarray(4, 8).toString() === "ftyp" &&
    /avif|avis/.test(head.subarray(8, 32).toString())
  )
    return { kind: "image", mime: "image/avif" };
  if (/^\.m(?:d|arkdown|dx)$/.test(extension))
    return { kind: "markdown", mime: "text/plain; charset=utf-8" };
  if (/^\.(?:mp3|wav|ogg|oga|flac|m4a|aac)$/.test(extension)) {
    const types: Record<string, string> = {
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".oga": "audio/ogg",
      ".flac": "audio/flac",
      ".m4a": "audio/mp4",
      ".aac": "audio/aac",
    };
    return { kind: "audio", mime: types[extension] };
  }
  if (/^\.(?:mp4|webm|ogv|mov)$/.test(extension))
    return {
      kind: "video",
      mime:
        extension === ".webm"
          ? "video/webm"
          : extension === ".ogv"
            ? "video/ogg"
            : extension === ".mov"
              ? "video/quicktime"
              : "video/mp4",
    };
  if (head.includes(0))
    return { kind: "binary", mime: "application/octet-stream" };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
  } catch {
    return { kind: "binary", mime: "application/octet-stream" };
  }
  const code =
    /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|ini|conf|config|sh|bash|zsh|fish|py|rb|php|go|rs|java|kt|c|cc|cpp|h|hpp|cs|sql|xml|html?|css|scss|less|svg|vue|svelte|env|dockerfile)$/i.test(
      path,
    ) ||
    /(?:^|\/)(?:Dockerfile|Makefile|\.env(?:\..*)?|\.gitignore)$/.test(path);
  return { kind: code ? "code" : "text", mime: "text/plain; charset=utf-8" };
}
