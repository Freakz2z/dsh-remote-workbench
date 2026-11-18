/** Manual/native-app QA companion. Own temporary SSH fixture; never calls a model. */
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { startFixture } from "../tests/ssh-fixture.ts";
import { PDFDocument } from "pdf-lib";

const origin = new URL(process.env.RW_DESKTOP_ORIGIN ?? "http://127.0.0.1:0");
if (origin.hostname !== "127.0.0.1" || origin.port === "0")
  throw new Error(
    "Set RW_DESKTOP_ORIGIN to the current desktop's loopback HTTP origin",
  );
const base = origin.origin + "/api/remote-workbench";
const statePath = resolve(
  process.env.DSH_HOME ?? "/Users/freak/.dsh",
  "remote-workbench/state.json",
);
const directory = resolve(".dev/desktop-verification");
await mkdir(directory, { recursive: true, mode: 0o700 });
const original = await readFile(statePath).catch((error) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});
if (original)
  await writeFile(join(directory, "state-before.json"), original, {
    mode: 0o600,
  });
const bootstrap = await (await fetch(base + "/bootstrap")).json();
const post = async (path: string, body: unknown) => {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rw-csrf": bootstrap.csrf,
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.message), value);
  return value;
};
const fixture = await startFixture();
let hostId: string | undefined;
let stop: () => void = () => {};
const done = new Promise<void>((resolveDone) => {
  stop = resolveDone;
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const host = await post("/hosts/save", {
    name: "本机验收 · 临时",
    address: "127.0.0.1",
    port: fixture.port,
    username: fixture.username,
    rootPath: fixture.workspace,
    group: "临时验收",
    auth: "key",
    privateKeyPath: fixture.privateKeyPath,
    favorite: false,
  });
  hostId = host.id;
  try {
    await post("/connect", { hostId });
  } catch (error) {
    const details = (error as { details?: { fingerprint?: string } }).details;
    if (
      (error as { code?: string }).code !== "HOST_KEY_UNKNOWN" ||
      details?.fingerprint !== fixture.fingerprint
    )
      throw error;
    await post("/trust", { hostId, fingerprint: fixture.fingerprint });
    await post("/connect", { hostId });
  }
  await writeFile(
    join(directory, "fixture.json"),
    JSON.stringify(
      {
        hostId,
        hostName: host.name,
        rootPath: fixture.workspace,
        port: fixture.port,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: "ready",
      hostName: host.name,
      hostId,
      workspace: fixture.workspace,
    }),
  );
  await done;
  const pdf = await PDFDocument.load(
    await readFile(join(fixture.workspace, "sample.pdf")),
  );
  const markdown = await readFile(join(fixture.workspace, "sample.md"), "utf8");
  console.log(
    JSON.stringify({
      status: "inspected",
      markdownSaved: markdown.includes("DESKTOP_VERIFIED"),
      pdfOperator: pdf.getForm().getTextField("Operator").getText(),
      pdfRotation: pdf.getPage(0).getRotation().angle,
    }),
  );
} finally {
  try {
    if (hostId) {
      await post("/disconnect", { hostId }).catch(() => {});
      await post("/hosts/delete", { hostId }).catch(() => {});
    }
    // Remove only the temporary fixture's trusted key from the on-disk state;
    // preserve any concurrent user changes. The desktop is reopened after QA to
    // drop the same unused trust entry from memory as well.
    const latestRaw = await readFile(statePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const latest = latestRaw ? JSON.parse(latestRaw) : undefined;
    if (latest) {
      if (hostId)
        latest.hosts = latest.hosts.filter(
          (host: { id: string }) => host.id !== hostId,
        );
      const key = `[127.0.0.1]:${fixture.port}`;
      if (latest.knownHosts?.[key] === fixture.fingerprint)
        delete latest.knownHosts[key];
      const before = original ? JSON.parse(original.toString()) : undefined;
      if (before) {
        for (const key of [
          "commandHistory",
          "commandSnippets",
          "commandPreferences",
        ]) {
          if (
            !(key in before) &&
            latest[key] &&
            Object.keys(latest[key]).length === 0
          )
            delete latest[key];
        }
      }
      const createdEmptyState =
        !original &&
        Object.keys(latest).every((key) =>
          [
            "version",
            "hosts",
            "knownHosts",
            "tasks",
            "commandHistory",
            "commandSnippets",
            "commandPreferences",
          ].includes(key),
        ) &&
        Object.entries(latest).every(
          ([key, value]) =>
            key === "version" ||
            (value !== null &&
              typeof value === "object" &&
              Object.keys(value).length === 0),
        );
      const identical =
        createdEmptyState ||
        (before && JSON.stringify(latest) === JSON.stringify(before));
      if (createdEmptyState) await unlink(statePath);
      else {
        const temp = statePath + ".desktop-qa.tmp";
        await writeFile(
          temp,
          identical ? original! : JSON.stringify(latest, null, 2) + "\n",
          { mode: 0o600 },
        );
        await rename(temp, statePath);
      }
      console.log(
        JSON.stringify({
          status: "cleaned",
          originalStateRestored: Boolean(identical),
        }),
      );
    }
  } finally {
    await fixture.close();
  }
}
