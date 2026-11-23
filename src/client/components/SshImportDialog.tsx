import { useState } from "react";
import { ChevronDown, ChevronRight, HardDrive, Pencil, X } from "lucide-react";
import type { HostInput } from "../../shared/types.ts";
import { Modal } from "./Modal.tsx";

export type SshImportCandidate = Partial<HostInput> & { note?: string };

const normaliseCandidate = (item: SshImportCandidate): SshImportCandidate => ({
  ...item,
  auth:
    item.auth === "agent" || !item.auth
      ? item.privateKeyPath
        ? "key"
        : "password"
      : item.auth,
});

/**
 * Multi-select importer for `~/.ssh/config` entries returned by `/ssh/import`.
 */
export function SshImportDialog({
  hosts,
  skipped = [],
  onClose,
  onImportSelected,
  onEditOne,
}: {
  hosts: SshImportCandidate[];
  skipped?: string[];
  onClose(): void;
  onImportSelected(items: HostInput[]): Promise<void>;
  onEditOne(item: SshImportCandidate): void;
}) {
  const candidates = hosts.map(normaliseCandidate);
  const [selected, setSelected] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(candidates.map((_, i) => [i, true])),
  );
  const [showSkipped, setShowSkipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const chosenCount = candidates.filter((_, i) => selected[i]).length;

  const submit = async () => {
    const items = candidates
      .filter((_, i) => selected[i])
      .map(
        (item): HostInput => ({
          name: item.name || item.address || "SSH 主机",
          address: item.address || "",
          port: item.port ?? 22,
          username: item.username || "root",
          group: item.group || "SSH 导入",
          rootPath: item.rootPath || "/",
          auth: item.privateKeyPath ? "key" : "password",
          privateKeyPath: item.privateKeyPath,
          favorite: false,
        }),
      );
    if (!items.length) return;
    setBusy(true);
    setError("");
    try {
      await onImportSelected(items);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      ariaLabel="从 SSH Config 导入"
      className="rw-import-dialog"
      busy={busy}
      onClose={onClose}
    >
      <header>
        <div className="rw-modal-icon">
          <HardDrive size={19} />
        </div>
        <div>
          <h2>从 SSH Config 导入</h2>
          <p>共发现 {candidates.length} 个明确的主机配置，可批量导入或单独微调。</p>
        </div>
        <button
          type="button"
          className="rw-icon"
          aria-label="关闭"
          disabled={busy}
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>

      <div className="rw-import-list">
        {candidates.map((item, idx) => (
          <div className="rw-import-row" key={`${item.name}-${idx}`}>
            <label className="rw-import-check">
              <input
                type="checkbox"
                checked={!!selected[idx]}
                onChange={(e) =>
                  setSelected((prev) => ({ ...prev, [idx]: e.target.checked }))
                }
              />
              <div>
                <strong>{item.name || item.address}</strong>
                <small>
                  {item.username}@{item.address}:{item.port ?? 22}
                  {item.privateKeyPath ? ` · ${item.privateKeyPath}` : " · 密码认证"}
                </small>
                {item.note && <em className="rw-import-note">{item.note}</em>}
              </div>
            </label>
            <button
              type="button"
              className="rw-icon"
              aria-label={`编辑 ${item.name || item.address}`}
              title="先在表单中微调再保存"
              disabled={busy}
              onClick={() => onEditOne(item)}
            >
              <Pencil size={13} />
            </button>
          </div>
        ))}
      </div>

      {skipped.length > 0 && (
        <div className="rw-import-skipped">
          <button
            type="button"
            onClick={() => setShowSkipped((v) => !v)}
            aria-expanded={showSkipped}
          >
            {showSkipped ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            已跳过 {skipped.length} 条通配符或复杂规则
          </button>
          {showSkipped && (
            <ul>
              {skipped.map((line, i) => (
                <li key={i}>
                  <code>{line}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <div className="rw-error">{error}</div>}

      <footer>
        <button
          type="button"
          className="rw-button"
          disabled={busy}
          onClick={onClose}
        >
          取消
        </button>
        <button
          type="button"
          className="rw-button primary"
          disabled={busy || chosenCount === 0}
          onClick={() => void submit()}
        >
          {busy ? "正在导入…" : `导入所选 (${chosenCount})`}
        </button>
      </footer>
    </Modal>
  );
}
