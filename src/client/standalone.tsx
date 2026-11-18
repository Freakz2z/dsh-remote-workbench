import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { AgentPanel, type OpenFileRequest } from "./AgentPanel.tsx";

// Development preview only. `?agent=1` mounts the right-sidebar Agent component
// alone; otherwise opening a file from the workbench emulates the native right
// sidebar in a fixed drawer so the flow can be exercised without a DSH host.
const params = new URLSearchParams(location.search);
const agentOnly = params.has("agent");

function Preview() {
  const [request, setRequest] = useState<OpenFileRequest>();
  if (agentOnly)
    return <AgentPanel sessionId={params.get("session") || undefined} />;
  return (
    <div style={{ width: "100vw", height: "100dvh", display: "flex" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <App
          onOpenFile={(hostId, path) =>
            setRequest({ hostId, path, nonce: Date.now() })
          }
        />
      </div>
      {request && (
        <aside className="rw-dev-drawer" aria-label="右侧栏预览">
          <div className="rw-dev-drawer-bar">
            <span>右侧栏预览（真实 DSH 中为原生右栏）</span>
            <button
              className="rw-dev-drawer-close"
              aria-label="关闭右侧栏预览"
              onClick={() => setRequest(undefined)}
            >
              ×
            </button>
          </div>
          <AgentPanel openRequest={request} />
        </aside>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
