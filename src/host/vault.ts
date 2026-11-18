import type { Context } from "@deepseek-ai/cordis";
import type { Credentials } from "../shared/types.ts";

/**
 * Durable SSH credentials for Remote Workbench. Values live in DSH's credential
 * records — never in the plugin's own state file and never in tool arguments —
 * so a password or key passphrase entered once keeps working across reconnects
 * and Host restarts.
 */
export interface CredentialVault {
  read(hostId: string): Promise<Credentials | undefined>;
  write(hostId: string, credentials: Credentials): Promise<void>;
  forget(hostId: string): Promise<void>;
}

interface CredentialRecord {
  kind: "api-key" | "grant";
  payload?: unknown;
}
/** Structural view of DSH's credentials service; keys are branded at compile time only. */
interface CredentialRecords {
  readRecord(key: string): Promise<CredentialRecord | undefined>;
  modifyRecord(
    key: string,
    mutate: (
      current: CredentialRecord | undefined,
    ) => Promise<CredentialRecord> | CredentialRecord,
  ): Promise<unknown>;
  deleteRecord(key: string): Promise<void>;
}

const OWNER = "remote-workbench";

export function createCredentialVault(
  ctx: Context,
): CredentialVault | undefined {
  const records = (ctx as unknown as { get(name: string): unknown }).get(
    "credentials",
  ) as CredentialRecords | undefined;
  if (!records) return undefined;
  const keyFor = (hostId: string) => {
    // Preserve valid keys. A UUID can start with a digit, which DSH rejects.
    const segment = /^[a-z][a-z0-9-]*$/.test(hostId)
      ? hostId
      : `host-${Buffer.from(hostId, "utf8").toString("hex")}`;
    return `${OWNER}/${segment}`;
  };

  return {
    async read(hostId) {
      const record = await records.readRecord(keyFor(hostId));
      const payload = record?.payload as Credentials | undefined;
      if (!payload) return undefined;
      const value: Credentials = {};
      if (typeof payload.password === "string" && payload.password)
        value.password = payload.password;
      if (typeof payload.passphrase === "string" && payload.passphrase)
        value.passphrase = payload.passphrase;
      return value.password || value.passphrase ? value : undefined;
    },
    async write(hostId, credentials) {
      if (!credentials.password && !credentials.passphrase) return;
      await records.modifyRecord(keyFor(hostId), (current) => {
        const previous = (current?.payload as Credentials | undefined) ?? {};
        const next = { ...previous, ...credentials };
        if (next.password === undefined) delete next.password;
        if (next.passphrase === undefined) delete next.passphrase;
        return { kind: "grant", payload: next };
      });
    },
    async forget(hostId) {
      await records.deleteRecord(keyFor(hostId));
    },
  };
}
