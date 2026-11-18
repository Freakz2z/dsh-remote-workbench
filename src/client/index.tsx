import React from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Activity } from "lucide-react";
import { App } from "./App.tsx";
import { AgentPanel, AgentTitle } from "./AgentPanel.tsx";

export const inject = [
  "slots",
  "layout",
  "uiWorkspace",
  "sidebarRight",
  "sidebarRightTabs",
];
const PANEL_ID = "remote-workbench";
/** Implementation identity, used as the key of the body/title slot registrations. */
const AGENT_ID = "dsh-remote-workbench.agent";
/** Tab kind opened through sidebarRight.openTab/openTabIn. */
const AGENT_KIND = "remote-agent";

interface SlotService {
  inject(name: string, register: () => () => void): () => void;
  register(
    options: Record<string, unknown>,
    component: React.ComponentType<never>,
  ): () => void;
}
interface Layout {
  selectPanel(id: string | null): void;
  toggleSidebar(): void;
}
interface SidebarRightTabs {
  register(definition: {
    id: string;
    kind: string;
    multiple?: boolean;
    keepMounted?: boolean;
    priority?: "extension" | "builtin" | "fallback";
    title: (address: string) => string;
    guide?: {
      id: string;
      order: number;
      title: () => string;
      description?: () => string;
      icon?: React.ComponentType<{ size?: number | string }>;
    }[];
  }): () => void;
}
interface SidebarRight {
  openTab(kind: string, options?: { params?: Record<string, unknown> }): void;
  openTabIn(
    sessionId: string,
    kind: string,
    options?: { params?: Record<string, unknown> },
  ): void;
}
interface AgentServices {
  slots: SlotService;
  layout: Layout;
  uiWorkspace: { openSession(id: string): void };
  sidebarRight: SidebarRight;
  sidebarRightTabs: SidebarRightTabs;
}

export function apply(ctx: Context) {
  const services = ctx as unknown as AgentServices;
  /**
   * Files open beside the conversation, never inside the workbench column: go
   * back to the Session first (the right sidebar needs a mounted session) and
   * retry until that surface is mounted.
   */
  const openInSidebar = (hostId: string, path: string) => {
    services.layout.selectPanel(null);
    const attempt = (tries: number) => {
      try {
        services.sidebarRight.openTab(AGENT_KIND, {
          params: { hostId, path },
        });
      } catch {
        if (tries > 0) requestAnimationFrame(() => attempt(tries - 1));
      }
    };
    requestAnimationFrame(() => attempt(30));
  };
  const Page = () => (
    <App
      onBack={() => services.layout.selectPanel(null)}
      onOpenFile={openInSidebar}
      onFocus={() => services.layout.toggleSidebar()}
    />
  );
  const Icon = ({ size = 16 }: { size?: number }) => (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="2" y="3" width="16" height="14" rx="3" />
      <path d="m5 7 3 3-3 3m6 0h4" />
      <path
        d="m15 2 .7 1.6L17.5 4l-1.8.7L15 6l-.6-1.3L13 4l1.4-.4Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
  // Compact launcher beside the conversation header: opens the Agent tab in
  // the real right sidebar for this Session and leaves the conversation in place.
  const AgentAction = ({ openAgent }: { openAgent?: () => void }) => (
    <button
      type="button"
      className="rw-agent-launcher"
      aria-label="在右侧栏打开远程 Agent"
      title="在右侧栏打开远程 Agent（监控与文件）"
      onClick={() => openAgent?.()}
    >
      <Activity size={16} />
    </button>
  );

  ctx.effect(() =>
    services.slots.inject("sidebar.panellist", () =>
      services.slots.register(
        {
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 35,
          label: () => "远程工作台",
        },
        Icon as React.ComponentType<never>,
      ),
    ),
  );
  // The standalone workbench stays available as a secondary surface.
  ctx.effect(() =>
    services.slots.inject("main", () =>
      services.slots.register(
        { name: "main", key: PANEL_ID },
        Page as React.ComponentType<never>,
      ),
    ),
  );
  ctx.effect(
    () =>
      services.sidebarRightTabs.register({
        id: AGENT_ID,
        kind: AGENT_KIND,
        multiple: false,
        keepMounted: true,
        priority: "extension",
        title: () => "远程 Agent",
        guide: [
          {
            id: "open",
            order: 25,
            title: () => "远程 Agent",
            description: () => "服务器监控与远程文件，紧挨当前会话",
            icon: Activity,
          },
        ],
      }),
    "remote-workbench: agent tab type",
  );
  ctx.effect(
    () =>
      services.slots.inject("sidebar.right.pane.tab", () =>
        services.slots.register(
          // The slot already provides `sessionId`; injecting it would shadow a
          // reserved prop, so the body registers without an inject.
          { name: "sidebar.right.pane.tab", key: AGENT_ID },
          AgentPanel as unknown as React.ComponentType<never>,
        ),
      ),
    "remote-workbench: agent tab body",
  );
  ctx.effect(
    () =>
      services.slots.inject("sidebar.right.pane.tab.title", () =>
        services.slots.register(
          { name: "sidebar.right.pane.tab.title", key: AGENT_ID },
          AgentTitle as unknown as React.ComponentType<never>,
        ),
      ),
    "remote-workbench: agent tab title",
  );
  ctx.effect(
    () =>
      services.slots.inject("conversation.session.header.actions", () =>
        services.slots.register(
          {
            name: "conversation.session.header.actions",
            id: "remote-agent",
            inject: (sessionId: string) => ({
              openAgent: () =>
                services.sidebarRight.openTabIn(sessionId, AGENT_KIND),
            }),
          },
          AgentAction as unknown as React.ComponentType<never>,
        ),
      ),
    "remote-workbench: agent launcher",
  );
}
