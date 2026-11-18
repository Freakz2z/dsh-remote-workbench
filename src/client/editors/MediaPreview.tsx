import { Download, FileQuestion, ImageOff } from "lucide-react";
import { bytes } from "../api.ts";
import type { RemoteFileKind } from "../../shared/workstation.ts";

/** Inline preview for image/audio/video; unknown binaries only offer download. */
export function MediaPreview({
  kind,
  url,
  name,
  size,
  mime,
  onDownload,
}: {
  kind: RemoteFileKind;
  url?: string;
  name: string;
  size: number;
  mime: string;
  onDownload(): void;
}) {
  if (kind === "image")
    return (
      <div className="rw-media rw-media-image">
        {url ? (
          <img src={url} alt={name} loading="lazy" />
        ) : (
          <ImageOff size={22} />
        )}
        <span className="rw-media-meta">
          {mime} · {bytes(size)}
        </span>
      </div>
    );
  if (kind === "audio")
    return (
      <div className="rw-media rw-media-audio">
        {url ? (
          <audio controls src={url}>
            当前浏览器不支持音频播放。
          </audio>
        ) : (
          <FileQuestion size={22} />
        )}
        <span className="rw-media-meta">
          {name} · {mime} · {bytes(size)}
        </span>
      </div>
    );
  if (kind === "video")
    return (
      <div className="rw-media rw-media-video">
        {url ? (
          <video controls src={url} preload="metadata" />
        ) : (
          <FileQuestion size={22} />
        )}
        <span className="rw-media-meta">
          {mime} · {bytes(size)}
        </span>
      </div>
    );
  return (
    <div className="rw-media rw-media-binary">
      <FileQuestion size={26} />
      <strong>{name}</strong>
      <span>
        {mime} · {bytes(size)}
      </span>
      <p>这个类型不在浏览范围内，可以下载到本地后查看。</p>
      <button className="rw-button" onClick={onDownload}>
        <Download size={13} />
        下载文件
      </button>
    </div>
  );
}
