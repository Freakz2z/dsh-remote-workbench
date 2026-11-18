import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-agent";
import { createUserMessage, expandAssistantStream } from "@deepseek-ai/dsh-llm";
import { homedir } from "node:os";
import { join } from "node:path";
import { basename } from "node:path";
import type { AiSession } from "./shared/types.ts";
import { Engine } from "./host/engine.ts";
import { Store } from "./host/store.ts";
import { Permissions } from "./host/permissions.ts";
import { createCredentialVault } from "./host/vault.ts";
import { createRoutes, type AiBridge } from "./host/routes.ts";
import { registerTools } from "./host/tools.ts";
import { WorkbenchError } from "./host/errors.ts";

export const name = "remote-workbench";
export const inject = ["webServer", "tools", "agents"];
export async function apply(
  ctx: Context,
  config: { dataDirectory?: string } = {},
) {
  const store = new Store(
    config.dataDirectory ??
      join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "remote-workbench"),
  );
  await store.init();
  const engine = new Engine(store, createCredentialVault(ctx));
  const permissions = new Permissions();
  const transcripts = new Map<
    string,
    { role: string; text: string; time: number }[]
  >();
  const accepted = new Set<string>();
  // Observe future committed settlements; the main DSH conversation remains the full history owner.
  ctx.on("session/event", (session, event) => {
    if (event.type !== "assistant/message" || !transcripts.has(session.id))
      return;
    try {
      const stream = (
        event.data as { stream?: Parameters<typeof expandAssistantStream>[0] }
      ).stream;
      if (!stream) return;
      const text = expandAssistantStream(stream)
        .flatMap((record) =>
          record.chunk.type === "text-delta" ? [record.chunk.text] : [],
        )
        .join("");
      if (!text.trim()) return;
      const rows = transcripts.get(session.id) ?? [];
      rows.push({
        role: "assistant",
        text: text.slice(0, 20000),
        time: Date.now(),
      });
      transcripts.set(session.id, rows.slice(-30));
    } catch {
      /* Unsupported settlements stay visible in the owning DSH conversation. */
    }
  });
  const ai: AiBridge = {
    sessions: (): AiSession[] =>
      ctx.agents
        .list()
        .filter((agent) => agent.session.header.origin !== "subagent")
        .map((agent) => ({
          id: agent.id,
          title: `${basename(agent.session.header.cwd ?? "") || "DSH 会话"} · ${agent.id.replace(/^session-/, "").slice(0, 6)}`,
          running: agent.status === "running",
        })),
    async send(sessionId, text, requestId) {
      const key = `${sessionId}:${requestId}`;
      if (accepted.has(key)) return;
      const agent = ctx.agents
        .list()
        .find(
          (a) => a.id === sessionId && a.session.header.origin !== "subagent",
        );
      if (!agent)
        throw new WorkbenchError(
          "SESSION_NOT_LIVE",
          "目标会话当前未打开，请在 DSH 中打开后重试",
        );
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" },
        }),
      );
      accepted.add(key);
      if (accepted.size > 1000)
        accepted.delete(accepted.values().next().value!);
      const rows = transcripts.get(sessionId) ?? [];
      rows.push({ role: "user", text, time: Date.now() });
      transcripts.set(sessionId, rows.slice(-30));
    },
    messages: (id) => {
      if (!transcripts.has(id)) {
        if (transcripts.size >= 20)
          transcripts.delete(transcripts.keys().next().value!);
        transcripts.set(id, []);
      }
      return transcripts.get(id)!;
    },
  };
  const routes = createRoutes(engine, permissions, ai);
  // Own resources before registering anything that can fail during activation.
  ctx.effect(() => async () => {
    routes.dispose();
    await engine.dispose();
  });
  // WebServer returns plain disposers; unlike tools.register(), registration
  // does not automatically belong to the calling plugin's Cordis fiber.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "prefix",
      path: "/api/remote-workbench",
      handler: routes.handler,
    }),
  );
  ctx.effect(() =>
    ctx.webServer.registerUpgrade({
      path: "/api/remote-workbench/terminal",
      handler: routes.upgrade,
    }),
  );
  registerTools(ctx, engine, permissions);
}
