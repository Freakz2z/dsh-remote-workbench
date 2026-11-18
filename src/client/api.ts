import {
  API_PREFIX,
  type ErrorBody,
  type RemoteFile,
  type Snapshot,
} from "../shared/types.ts";
import type {
  CommandLibrary,
  CommandSuggestion,
  RemoteFileInfo,
  ResourceResponse,
} from "../shared/workstation.ts";

export class ApiError extends Error {
  constructor(
    public code: string,
    public message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export interface BinaryResponse {
  data: ArrayBuffer;
  type: string;
  etag?: string;
  hostRevision?: number;
}
export class Api {
  csrf = "";
  async init(): Promise<Snapshot> {
    const data = await this.get<Snapshot & { csrf: string }>("/bootstrap");
    this.csrf = data.csrf;
    return data;
  }
  async get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return this.request(path + (query ? "?" + new URLSearchParams(query) : ""));
  }
  async post<T = { ok: boolean }>(path: string, value: unknown): Promise<T> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rw-csrf": this.csrf },
      body: JSON.stringify(value),
    });
  }
  async upload(
    hostId: string,
    path: string,
    file: File,
    hostRevision?: number,
  ) {
    return this.request(
      "/upload?" +
        new URLSearchParams({
          hostId,
          path,
          ...(hostRevision === undefined
            ? {}
            : { hostRevision: String(hostRevision) }),
        }),
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-rw-csrf": this.csrf,
        },
        body: file,
      },
    );
  }
  /** Fetch raw bytes of a remote file (preview route, 25 MiB cap on the host). */
  async readBinary(
    path: string,
    query: Record<string, string>,
  ): Promise<BinaryResponse> {
    const response = await fetch(
      API_PREFIX + path + "?" + new URLSearchParams(query),
      { credentials: "same-origin" },
    );
    if (!response.ok) {
      const data = (await response.json().catch(() => ({
        code: "HTTP_ERROR",
        message: `服务器返回 ${response.status}`,
      }))) as ErrorBody;
      throw new ApiError(data.code, data.message, data.details);
    }
    const etagHeader = response.headers.get("etag");
    const revisionHeader = response.headers.get("x-rw-host-revision");
    return {
      data: await response.arrayBuffer(),
      type: response.headers.get("content-type") ?? "application/octet-stream",
      etag: etagHeader ? etagHeader.replace(/"/g, "") : undefined,
      hostRevision: revisionHeader ? Number(revisionHeader) : undefined,
    };
  }
  /** Persist raw bytes; the host only accepts PDF through this route. */
  async saveBinary(
    query: Record<string, string>,
    body: Blob | Uint8Array,
  ): Promise<{
    path: string;
    etag: string;
    size: number;
    hostRevision: number;
  }> {
    const typed =
      body instanceof Blob
        ? body
        : new Blob([body as unknown as BlobPart], {
            type: "application/octet-stream",
          });
    return this.request("/file/save-binary?" + new URLSearchParams(query), {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "x-rw-csrf": this.csrf,
      },
      body: typed,
    });
  }
  async fileInfo(hostId: string, path: string): Promise<RemoteFileInfo> {
    return this.get<RemoteFileInfo>("/file/info", { hostId, path });
  }
  async file(hostId: string, path: string): Promise<RemoteFile> {
    return this.get<RemoteFile>("/file", { hostId, path });
  }
  async resources(
    hostId: string,
    signal?: AbortSignal,
  ): Promise<ResourceResponse> {
    const response = await fetch(
      API_PREFIX + "/resources?" + new URLSearchParams({ hostId }).toString(),
      { credentials: "same-origin", signal },
    );
    if (!response.ok) {
      const data = (await response.json().catch(() => ({
        code: "HTTP_ERROR",
        message: `服务器返回 ${response.status}`,
      }))) as ErrorBody;
      throw new ApiError(data.code, data.message, data.details);
    }
    return response.json() as Promise<ResourceResponse>;
  }
  async commands(
    hostId: string,
    q = "",
    signal?: AbortSignal,
  ): Promise<CommandLibrary> {
    const query = new URLSearchParams({ hostId });
    if (q) query.set("q", q);
    const response = await fetch(API_PREFIX + "/commands?" + query.toString(), {
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({
        code: "HTTP_ERROR",
        message: `服务器返回 ${response.status}`,
      }))) as ErrorBody;
      throw new ApiError(data.code, data.message, data.details);
    }
    return response.json() as Promise<CommandLibrary>;
  }
  async suggest(
    hostId: string,
    cwd: string,
    input: string,
    signal?: AbortSignal,
  ): Promise<{ items: CommandSuggestion[] }> {
    const response = await fetch(
      API_PREFIX +
        "/commands/suggest?" +
        new URLSearchParams({ hostId, cwd, input }).toString(),
      { credentials: "same-origin", signal },
    );
    if (!response.ok) {
      const data = (await response.json().catch(() => ({
        code: "HTTP_ERROR",
        message: `服务器返回 ${response.status}`,
      }))) as ErrorBody;
      throw new ApiError(data.code, data.message, data.details);
    }
    return response.json() as Promise<{ items: CommandSuggestion[] }>;
  }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(API_PREFIX + path, {
      credentials: "same-origin",
      ...init,
    });
    const data = await response.json().catch(() => ({
      code: "HTTP_ERROR",
      message: `服务器返回 ${response.status}，请确认插件已加载`,
    }));
    if (!response.ok) {
      const e = data as ErrorBody;
      throw new ApiError(e.code, e.message, e.details);
    }
    return data as T;
  }
  socket(id: string) {
    const transport = (
      globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }
    ).__DSH_TRANSPORT__;
    const base = ["http:", "https:"].includes(location.protocol)
      ? location.origin
      : transport?.streamBaseUrl;
    if (!base)
      throw new ApiError(
        "STREAM_UNAVAILABLE",
        "当前 DSH 桌面版本缺少终端流通道，请使用 Web profile 打开工作台",
      );
    const url = new URL(API_PREFIX + "/terminal", base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({ id, token: this.csrf }).toString();
    return new WebSocket(url);
  }
}
export const api = new Api();
export const remoteJoin = (path: string, name: string) =>
  path.replace(/\/$/, "") + "/" + name;
export const parentPath = (path: string) =>
  path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
export function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}
/** Byte rate text; null means the host has no baseline sample yet. */
export const rate = (value: number | null | undefined) =>
  value === null || value === undefined ? "采样中" : bytes(value) + "/s";
export const percent = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined ? "—" : `${value.toFixed(digits)}%`;
export const duration = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
};
/** Build the same-origin URL used by <img>/<video> for a remote preview. */
const withRevision = (hostId: string, path: string, hostRevision?: number) => ({
  hostId,
  path,
  ...(hostRevision === undefined ? {} : { hostRevision: String(hostRevision) }),
});
/**
 * Same-origin URL used by <img>/<video> for a remote preview. The revision
 * pins the request to the connection the file was opened against.
 */
export const previewUrl = (
  hostId: string,
  path: string,
  hostRevision?: number,
) =>
  API_PREFIX +
  "/file/preview?" +
  new URLSearchParams(withRevision(hostId, path, hostRevision)).toString();
export const downloadUrl = (
  hostId: string,
  path: string,
  hostRevision?: number,
) =>
  API_PREFIX +
  "/download?" +
  new URLSearchParams(withRevision(hostId, path, hostRevision)).toString();
