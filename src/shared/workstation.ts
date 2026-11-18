/** Workstation 0.2 API. All metrics are real samples; unavailable values are null. */
export interface CpuMetrics {
  model: string;
  logicalCores: number;
  usagePercent: number | null;
  userPercent: number | null;
  systemPercent: number | null;
  ioWaitPercent: number | null;
  frequencyMHz: number | null;
  temperatureC: number | null;
  load: number[];
  cores: { id: string; usagePercent: number | null }[];
}
export interface MemoryMetrics {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  cachedBytes: number | null;
  buffersBytes: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  usagePercent: number;
}
export interface GpuMetrics {
  id: string;
  vendor: string;
  name: string;
  usagePercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  temperatureC: number | null;
  powerWatts: number | null;
  fanPercent: number | null;
}
export interface FilesystemMetrics {
  device: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}
export interface DiskIoMetrics {
  device: string;
  readBytes: number;
  writeBytes: number;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  busyPercent: number | null;
}
export interface NetworkMetrics {
  name: string;
  addresses: string[];
  receivedBytes: number;
  sentBytes: number;
  receiveBytesPerSecond: number | null;
  sendBytesPerSecond: number | null;
  receiveErrors: number;
  sendErrors: number;
}
export interface ResourceSample {
  hostId: string;
  hostRevision: number;
  sampledAt: number;
  platform: "linux" | "darwin" | "unsupported";
  hostname: string;
  os: string;
  kernel: string;
  uptimeSeconds: number | null;
  cpu: CpuMetrics;
  memory: MemoryMetrics | null;
  gpus: GpuMetrics[];
  gpuStatus: "available" | "unavailable";
  gpuMessage: string;
  filesystems: FilesystemMetrics[];
  disks: DiskIoMetrics[];
  networks: NetworkMetrics[];
  warnings: string[];
}
export interface ResourceHistoryPoint {
  sampledAt: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  receiveBytesPerSecond: number | null;
  sendBytesPerSecond: number | null;
}
export interface ResourceResponse {
  sample: ResourceSample;
  history: ResourceHistoryPoint[];
  intervalMs: number;
}
export type RemoteFileKind =
  "text" | "code" | "markdown" | "pdf" | "image" | "audio" | "video" | "binary";
export interface RemoteFileInfo {
  hostId: string;
  hostRevision: number;
  path: string;
  name: string;
  size: number;
  modified: number;
  mode: string;
  kind: RemoteFileKind;
  mime: string;
  editable: boolean;
  previewable: boolean;
  reason?: string;
  maxTextBytes: number;
  maxPreviewBytes: number;
}
export interface CommandHistoryEntry {
  id: string;
  hostId: string;
  command: string;
  cwd: string;
  lastUsedAt: number;
  uses: number;
}
export interface CommandSnippet {
  id: string;
  hostId?: string;
  name: string;
  command: string;
  group: string;
  createdAt: number;
  updatedAt: number;
}
export interface CommandLibrary {
  history: CommandHistoryEntry[];
  snippets: CommandSnippet[];
  remember: boolean;
}
export interface CommandSuggestion {
  id: string;
  kind: "history" | "snippet" | "command" | "path";
  label: string;
  value: string;
  description: string;
}
