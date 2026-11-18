export type AuthMethod = "agent" | "key" | "password";
export interface Host {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  group: string;
  rootPath: string;
  auth: AuthMethod;
  privateKeyPath?: string;
  jumpHostId?: string;
  favorite: boolean;
  revision: number;
}
export interface Credentials {
  password?: string;
  passphrase?: string;
}
export interface HostInput extends Omit<Host, "id" | "revision"> {
  id?: string;
}
export interface ConnectionState {
  hostId: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
}
export interface FileEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink";
  size: number;
  modified: number;
  mode: string;
}
export interface RemoteFile {
  path: string;
  content: string;
  etag: string;
  size: number;
  hostRevision: number;
}
export interface Task {
  id: string;
  hostId: string;
  hostName: string;
  kind: "upload" | "download" | "command" | "file";
  label: string;
  status: "running" | "completed" | "failed" | "cancelled" | "unknown";
  progress: number;
  bytes?: number;
  total?: number;
  output?: string;
  command?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
export interface TerminalInfo {
  id: string;
  hostId: string;
  title: string;
  status: "running" | "exited";
  exitCode?: number;
  createdAt: number;
}
export interface Tunnel {
  id: string;
  hostId: string;
  localPort: number;
  targetHost: string;
  targetPort: number;
}
export interface AiSession {
  id: string;
  title: string;
  running: boolean;
}
export interface Grant {
  sessionId: string;
  hostId: string;
  rootPath: string;
  read: boolean;
  write: boolean;
  exec: boolean;
  hostRevision?: number;
}
export interface Snapshot {
  hosts: Host[];
  connections: ConnectionState[];
  tasks: Task[];
  terminals: TerminalInfo[];
  tunnels: Tunnel[];
  sessions: AiSession[];
  grants: Grant[];
  mode: "dsh" | "standalone";
}
export interface ContextItem {
  id: string;
  hostId: string;
  hostName: string;
  path: string;
  kind: "file" | "terminal" | "directory";
  text?: string;
}
export interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
export const API_PREFIX = "/api/remote-workbench";
