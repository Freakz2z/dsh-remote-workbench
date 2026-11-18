import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "../src/host/store.ts";
import { Engine } from "../src/host/engine.ts";
import { Permissions } from "../src/host/permissions.ts";
import { startFixture } from "./ssh-fixture.ts";
import type { Credentials } from "../src/shared/types.ts";
import {
  createCredentialVault,
  type CredentialVault,
} from "../src/host/vault.ts";

/** In-memory stand-in for DSH's credential records (same contract as vault.ts). */
function memoryVault() {
  const records = new Map<string, Credentials>();
  const vault: CredentialVault = {
    async read(hostId) {
      return records.get(hostId);
    },
    async write(hostId, credentials) {
      records.set(hostId, { ...(records.get(hostId) ?? {}), ...credentials });
    },
    async forget(hostId) {
      records.delete(hostId);
    },
  };
  return { records, vault };
}

describe("durable credentials and pre-connection grants", () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  let store: Store;
  let engine: Engine;
  let id: string;
  let vaults: ReturnType<typeof memoryVault>;

  beforeAll(async () => {
    fixture = await startFixture();
    store = new Store(join(fixture.root, "state"));
    await store.init();
    vaults = memoryVault();
    engine = new Engine(store, vaults.vault);
    const host = await store.saveHost({
      name: "凭据测试",
      address: "127.0.0.1",
      port: fixture.port,
      username: fixture.username,
      rootPath: fixture.workspace,
      group: "测试",
      auth: "key",
      privateKeyPath: fixture.privateKeyPath,
      favorite: false,
    });
    id = host.id;
  }, 20000);

  afterAll(async () => {
    await engine?.dispose();
    await fixture?.close();
  });

  it("persists a password once, outside the plugin state file", async () => {
    await engine.setCredentials(id, { password: "s3cret" });
    expect(vaults.records.get(id)).toEqual({ password: "s3cret" });
    const state = await readFile(
      join(fixture.root, "state", "state.json"),
      "utf8",
    );
    expect(state).not.toContain("s3cret");
    // A brand-new Host process (same vault) still has the credential.
    const restarted = new Engine(store, vaults.vault);
    expect(await restarted.hasStoredCredentials(id)).toBe(true);
    await restarted.dispose();
  });

  it("forgets a stored credential on request and on host deletion", async () => {
    await engine.setCredentials(id, { password: "again" });
    await engine.forgetCredentials(id);
    expect(vaults.records.has(id)).toBe(false);
    expect(await engine.hasStoredCredentials(id)).toBe(false);
  });

  it("accepts a grant before the first connection and canonicalises it later", async () => {
    const permissions = new Permissions();
    const grant = await permissions.set(engine, {
      sessionId: "session-test",
      hostId: id,
      rootPath: fixture.workspace,
      read: true,
      write: false,
      exec: false,
    });
    expect(grant.rootPath).toBe(fixture.workspace);

    await engine.trust(id, fixture.fingerprint).catch(() => {});
    // First connection resolves the fingerprint through the UI flow.
    await engine.connect(id).catch(async (error: unknown) => {
      if ((error as { code?: string }).code === "HOST_KEY_UNKNOWN") {
        await engine.trust(
          id,
          String(
            (error as { details?: { fingerprint?: string } }).details
              ?.fingerprint,
          ),
        );
        return engine.connect(id);
      }
      throw error;
    });
    expect(engine.isConnected(id)).toBe(true);
    const path = await permissions.check(
      engine,
      "session-test",
      id,
      "read",
      join(fixture.workspace, "README.md"),
    );
    expect(path).toBe(join(fixture.workspace, "README.md"));
    expect(permissions.visible("session-test")[0]?.rootPath).toBe(
      fixture.workspace,
    );
  }, 20000);
});

describe("DSH credential records adapter", () => {
  it("stores per-host records through the credentials service and never returns empties", async () => {
    const records = new Map<string, { kind?: string; payload?: unknown }>();
    const service = {
      async readRecord(key: string) {
        return records.get(key);
      },
      async modifyRecord(
        key: string,
        mutate: (
          current: { kind?: string; payload?: unknown } | undefined,
        ) =>
          | Promise<{ kind?: string; payload?: unknown }>
          | { kind?: string; payload?: unknown },
      ) {
        records.set(key, await mutate(records.get(key)));
      },
      async deleteRecord(key: string) {
        records.delete(key);
      },
    };
    const vault = createCredentialVault({
      get: (name: string) => (name === "credentials" ? service : undefined),
    } as never);
    expect(vault).toBeDefined();
    await vault!.write("host-1", { password: "pw", passphrase: undefined });
    await vault!.write("host-1", { passphrase: "phrase" });
    expect(records.get("remote-workbench/host-1")?.payload).toEqual({
      password: "pw",
      passphrase: "phrase",
    });
    expect(await vault!.read("host-1")).toEqual({
      password: "pw",
      passphrase: "phrase",
    });
    expect(await vault!.read("missing")).toBeUndefined();
    await vault!.forget("host-1");
    expect(records.has("remote-workbench/host-1")).toBe(false);
    // A composition without the credentials service degrades to memory-only.
    expect(
      createCredentialVault({ get: () => undefined } as never),
    ).toBeUndefined();
  });
});
