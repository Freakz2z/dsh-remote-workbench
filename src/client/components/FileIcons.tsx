import { useEffect, useRef, type ReactNode } from "react";
import {
  File,
  FileArchive,
  FileCode2,
  FileCog,
  FileText,
  Film,
  Folder,
  Image as ImageIcon,
  Music,
} from "lucide-react";
import type { FileEntry } from "../../shared/types.ts";

const CODE_EXT =
  /\.(tsx?|jsx?|py|go|rs|java|c|cpp|h|hpp|rb|php|sh|bash|zsh|fish|sql|lua|pl|css|scss|less|html?|vue|svelte)$/i;
const CONFIG_EXT =
  /\.(jsonc?|ya?ml|toml|ini|conf|env|properties|lock|nginx)$/i;
const CONFIG_NAME = /^(dockerfile|makefile|\.env.*|\.gitignore|nginx\.conf)$/i;
const MD_EXT = /\.(md|markdown|txt|log|csv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi)$/i;
const ARCHIVE_EXT = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;

/** Semantic file/folder icon shared by the workbench and the right sidebar. */
export function FileEntryIcon({
  entry,
  size = 15,
}: {
  entry: Pick<FileEntry, "name" | "type">;
  size?: number;
}) {
  if (entry.type === "directory")
    return <Folder size={size} className="rw-ico-folder" />;
  const name = entry.name.toLowerCase();
  if (name.endsWith(".pdf"))
    return <FileText size={size} className="rw-ico-pdf" />;
  if (IMAGE_EXT.test(name))
    return <ImageIcon size={size} className="rw-ico-image" />;
  if (AUDIO_EXT.test(name))
    return <Music size={size} className="rw-ico-media" />;
  if (VIDEO_EXT.test(name))
    return <Film size={size} className="rw-ico-media" />;
  if (ARCHIVE_EXT.test(name))
    return <FileArchive size={size} className="rw-ico-archive" />;
  if (CONFIG_NAME.test(name) || CONFIG_EXT.test(name))
    return <FileCog size={size} className="rw-ico-config" />;
  if (CODE_EXT.test(name))
    return <FileCode2 size={size} className="rw-ico-code" />;
  if (MD_EXT.test(name))
    return <FileText size={size} className="rw-ico-text" />;
  return <File size={size} className="rw-ico-file" />;
}

/**
 * Viewport-clamped context menu for remote files/directories, dismissed on
 * Escape or outside pointerdown.
 */
export function FileContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose(): void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const left =
    typeof window !== "undefined" ? Math.max(8, Math.min(x, window.innerWidth - 208)) : x;
  const top =
    typeof window !== "undefined" ? Math.max(8, Math.min(y, window.innerHeight - 280)) : y;

  return (
    <div
      ref={menuRef}
      className="rw-context-menu"
      role="menu"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => onClose()}
    >
      {children}
    </div>
  );
}
