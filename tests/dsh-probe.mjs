// Test-only white-box probe. Excluded from the distributable package.
export const inject = ["webServer", "tools", "agents"];
export function apply(ctx) {
  ctx.webServer.register({
    kind: "exact",
    path: "/api/rw-validation/tools",
    handler: async (req, res) => {
      if (
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress,
        )
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") {
        res.end(
          JSON.stringify(
            ctx.tools
              .schemas()
              .filter((t) => t.name.startsWith("rw_"))
              .map((t) => t.name),
          ),
        );
        return;
      }
      try {
        let text = "";
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 20000) throw new Error("test request too large");
        }
        const { name, arguments: args, sessionId } = JSON.parse(text);
        if (
          ![
            "rw_hosts",
            "rw_list",
            "rw_read",
            "rw_exec",
            "rw_resources",
            "rw_connect",
          ].includes(name)
        )
          throw new Error("not a validation tool");
        const agent = ctx.agents.list().find((a) => a.id === sessionId);
        if (!agent) throw new Error("session unavailable");
        const definition = ctx.tools.get(name);
        const value = await definition.execute(args, {
          agent,
          signal: new AbortController().signal,
        });
        res.end(JSON.stringify({ ok: true, value }));
      } catch (error) {
        res.end(JSON.stringify({ ok: false, message: error.message }));
      }
    },
  });
}
