import { posix } from "node:path";
import type { Grant } from "../shared/types.ts";
import type { Engine } from "./engine.ts";
import { WorkbenchError, absolutePath } from "./errors.ts";

export class Permissions {
  private grants = new Map<string, Grant>();
  list() {
    return [...this.grants.values()].map((g) => ({ ...g }));
  }
  async set(engine: Engine, grant: Grant) {
    engine.store.host(grant.hostId);
    const requested = absolutePath(grant.rootPath);
    // Before the first connection there is no SFTP channel to resolve a
    // canonical root; keep the requested absolute path and canonicalise it on
    // the first authorised operation instead of refusing the grant.
    const rootPath = engine.isConnected(grant.hostId)
      ? await engine.canonical(grant.hostId, requested)
      : requested;
    const value = {
      ...grant,
      rootPath,
      hostRevision: engine.store.host(grant.hostId).revision,
    };
    this.grants.set(`${grant.sessionId}:${grant.hostId}`, value);
    return value;
  }
  revoke(sessionId: string, hostId: string) {
    this.grants.delete(`${sessionId}:${hostId}`);
  }
  revokeHost(hostId: string) {
    for (const [key, grant] of this.grants)
      if (grant.hostId === hostId) this.grants.delete(key);
  }
  async check(
    engine: Engine,
    sessionId: string | undefined,
    hostId: string,
    operation: "read" | "write" | "exec",
    path: string,
  ) {
    await this.canonicalize(engine, sessionId, hostId);
    if (!sessionId)
      throw new WorkbenchError(
        "AI_SESSION_REQUIRED",
        "远程工具需要一个明确的 DSH 会话",
      );
    const grant = this.grants.get(`${sessionId}:${hostId}`);
    if (
      !grant ||
      !grant[operation] ||
      grant.hostRevision !== engine.store.host(hostId).revision
    )
      throw new WorkbenchError(
        "AI_PERMISSION_REQUIRED",
        `请在远程工作台为当前会话授权 ${operation} 操作`,
      );
    const canonical = await engine.canonical(hostId, absolutePath(path));
    if (
      this.grants.get(`${sessionId}:${hostId}`) !== grant ||
      grant.hostRevision !== engine.store.host(hostId).revision
    )
      throw new WorkbenchError(
        "AI_PERMISSION_REQUIRED",
        "连接或授权已变化，请重新授权",
      );
    if (
      canonical !== grant.rootPath &&
      !canonical.startsWith(grant.rootPath.replace(/\/$/, "") + "/")
    )
      throw new WorkbenchError("AI_PATH_DENIED", "路径超出此会话的授权目录");
    return canonical;
  }
  /**
   * Replace a pre-connection root with the server's canonical path once the
   * connection exists. No-op for connected grants and for missing grants.
   */
  private async canonicalize(
    engine: Engine,
    sessionId: string | undefined,
    hostId: string,
  ) {
    if (!sessionId || !engine.isConnected(hostId)) return;
    const grant = this.grants.get(`${sessionId}:${hostId}`);
    if (!grant) return;
    const canonical = await engine.canonical(hostId, grant.rootPath);
    if (canonical !== grant.rootPath)
      this.grants.set(`${sessionId}:${hostId}`, {
        ...grant,
        rootPath: canonical,
      });
  }
  visible(sessionId?: string) {
    return this.list().filter((g) => g.sessionId === sessionId);
  }
}
