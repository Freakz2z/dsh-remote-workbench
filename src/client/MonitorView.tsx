import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronRight,
  Cpu,
  HardDrive,
  LoaderCircle,
  MemoryStick,
  MonitorSmartphone,
  Network,
  Pause,
  Play,
  PlugZap,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  Sparkles,
  Timer,
} from "lucide-react";
import { api, ApiError, bytes, duration, percent, rate } from "./api.ts";
import type {
  ResourceHistoryPoint,
  ResourceResponse,
  ResourceSample,
} from "../shared/workstation.ts";

type DetailTab = "overview" | "cpu" | "gpu" | "memory" | "disk" | "network";

const TABS: { id: DetailTab; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "综合", icon: ServerCog },
  { id: "cpu", label: "CPU", icon: Cpu },
  { id: "gpu", label: "显卡", icon: MonitorSmartphone },
  { id: "memory", label: "内存", icon: MemoryStick },
  { id: "disk", label: "磁盘", icon: HardDrive },
  { id: "network", label: "网络", icon: Network },
];
const INTERVALS = [
  { value: 3000, label: "3 秒" },
  { value: 5000, label: "5 秒" },
  { value: 10000, label: "10 秒" },
  { value: 30000, label: "30 秒" },
];

/** Interactive area sparkline; null samples leave a gap instead of drawing a fake 0. */
function Sparkline({
  points,
  pick,
  max,
  label,
  format,
}: {
  points: ResourceHistoryPoint[];
  pick(point: ResourceHistoryPoint): number | null;
  max?: number;
  label: string;
  format?: (value: number) => string;
}) {
  const gradId = useId();
  const [hoverIdx, setHoverIdx] = useState<number>();
  const values = points.map(pick);
  const known = values.filter((v): v is number => typeof v === "number");
  const top = max ?? Math.max(1, ...known);
  const width = 100;
  const height = 30;
  let path = "";
  let area = "";
  let segmentStart = -1;
  let lastX = 0;
  let started = false;
  const coords: ({ x: number; y: number; value: number } | null)[] = [];

  values.forEach((value, index) => {
    if (value === null) {
      if (started && segmentStart >= 0) {
        area += `L${lastX.toFixed(2)},${height}L${segmentStart.toFixed(2)},${height}Z`;
      }
      started = false;
      segmentStart = -1;
      coords.push(null);
      return;
    }
    const x =
      values.length === 1 ? width : (index / (values.length - 1)) * width;
    const y = height - Math.min(1, value / top) * height;
    path += `${started ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    area += `${started ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    if (!started) segmentStart = x;
    lastX = x;
    started = true;
    coords.push({ x, y, value });
  });
  if (started && segmentStart >= 0) {
    area += `L${lastX.toFixed(2)},${height}L${segmentStart.toFixed(2)},${height}Z`;
  }

  if (known.length < 2) {
    return (
      <div className="rw-monitor-spark-wrap">
        <div className="rw-monitor-spark-wait">等待基线采样…</div>
      </div>
    );
  }

  const activeCoord =
    hoverIdx !== undefined ? coords[hoverIdx] ?? null : null;
  const activePoint = hoverIdx !== undefined ? points[hoverIdx] : undefined;

  return (
    <div className="rw-monitor-spark-wrap">
      <svg
        className="rw-monitor-spark"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        onMouseMove={(e) => {
          if (!values.length) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = Math.max(
            0,
            Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)),
          );
          setHoverIdx(Math.round(ratio * (values.length - 1)));
        }}
        onMouseLeave={() => setHoverIdx(undefined)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.24" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeOpacity="0.14"
          strokeDasharray="2 2"
          strokeWidth="0.6"
          vectorEffect="non-scaling-stroke"
        />
        {area && <path d={area} fill={`url(#${gradId})`} />}
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          vectorEffect="non-scaling-stroke"
        />
        {activeCoord && (
          <>
            <line
              x1={activeCoord.x}
              y1="0"
              x2={activeCoord.x}
              y2={height}
              stroke="currentColor"
              strokeOpacity="0.4"
              strokeWidth="0.8"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={activeCoord.x}
              cy={activeCoord.y}
              r="2.2"
              fill="currentColor"
            />
          </>
        )}
      </svg>
      {activeCoord && activePoint && (
        <span className="rw-monitor-spark-tip">
          {new Date(activePoint.sampledAt).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}{" "}
          · {format ? format(activeCoord.value) : activeCoord.value.toFixed(1)}
        </span>
      )}
    </div>
  );
}

function Meter({
  value,
  tone,
  label,
}: {
  value: number | null;
  tone?: "warn" | "danger";
  label: string;
}) {
  const clamped = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div
      className={
        "rw-monitor-meter" +
        (tone ? ` ${tone}` : "") +
        (value === null ? " unknown" : "")
      }
      role="meter"
      aria-label={label}
      aria-valuenow={value ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <i style={{ width: `${clamped}%` }} />
    </div>
  );
}

const toneFor = (value: number | null) =>
  value !== null && value >= 90
    ? "danger"
    : value !== null && value >= 75
      ? "warn"
      : undefined;

/**
 * Live server monitor. Every value comes from `/resources`; the panel never
 * invents numbers. Polling stops when the panel is hidden, the host is not
 * connected, or the user pauses.
 */
export function MonitorView({
  hostId,
  hostName,
  connected,
  connecting = false,
  onConnect,
  active = true,
  onSummary,
  onNotice,
}: {
  hostId: string;
  hostName: string;
  connected: boolean;
  connecting?: boolean;
  onConnect?(): void;
  /** False while the pane is hidden (other agent mode, collapsed tab). */
  active?: boolean;
  onSummary(text: string): void;
  onNotice(text: string, error?: boolean): void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [interval, setIntervalMs] = useState(3000);
  const [paused, setPaused] = useState(false);
  const [data, setData] = useState<ResourceResponse>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [visible, setVisible] = useState(
    typeof document === "undefined" || document.visibilityState === "visible",
  );
  const request = useRef<AbortController>();
  const version = useRef(0);

  useEffect(() => {
    const onVisibility = () =>
      setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const load = useCallback(async () => {
    if (!hostId || !connected) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++version.current;
    setLoading(true);
    try {
      const value = await api.resources(hostId, controller.signal);
      if (current !== version.current) return;
      setData(value);
      setUpdatedAt(Date.now());
      setError("");
    } catch (e) {
      if (controller.signal.aborted || current !== version.current) return;
      const apiError = e as ApiError;
      setError(
        apiError.code === "NOT_CONNECTED"
          ? "主机未连接，监控已停止"
          : apiError.message,
      );
    } finally {
      if (current === version.current) setLoading(false);
    }
  }, [hostId, connected]);

  useEffect(() => {
    if (!hostId || !connected || paused || !visible || !active) return;
    void load();
    const timer = window.setInterval(() => void load(), interval);
    return () => {
      window.clearInterval(timer);
      request.current?.abort();
    };
  }, [hostId, connected, paused, visible, active, interval, load]);

  useEffect(() => {
    // A different host must not show the previous host's sample.
    setData(undefined);
    setError("");
    setUpdatedAt(undefined);
  }, [hostId]);

  const sample = data?.sample;
  const history = data?.history ?? [];
  const summary = useMemo(() => {
    if (!sample) return "";
    const lines = [
      `远程主机监控摘要 · ${sample.hostname}（${hostName}）`,
      `采样时间：${new Date(sample.sampledAt).toLocaleString("zh-CN")} · 平台 ${sample.platform} · ${sample.os} ${sample.kernel}`,
      `运行时长：${duration(sample.uptimeSeconds)}`,
      `CPU：${percent(sample.cpu.usagePercent, 1)}（${sample.cpu.logicalCores} 核，负载 ${sample.cpu.load.map((n) => n.toFixed(2)).join(" / ") || "—"}）`,
      sample.memory
        ? `内存：${percent(sample.memory.usagePercent, 1)}，已用 ${bytes(sample.memory.usedBytes)} / ${bytes(sample.memory.totalBytes)}`
        : "内存：暂不可用",
    ];
    for (const fs of sample.filesystems.slice(0, 4))
      lines.push(
        `磁盘 ${fs.mount}：${percent(fs.usagePercent, 1)}，已用 ${bytes(fs.usedBytes)} / ${bytes(fs.totalBytes)}`,
      );
    for (const net of sample.networks.slice(0, 4))
      lines.push(
        `网卡 ${net.name}：收 ${rate(net.receiveBytesPerSecond)}，发 ${rate(net.sendBytesPerSecond)}`,
      );
    if (sample.gpuStatus === "available")
      for (const gpu of sample.gpus)
        lines.push(
          `GPU ${gpu.name}：使用 ${percent(gpu.usagePercent)}，显存 ${gpu.memoryUsedBytes === null ? "—" : bytes(gpu.memoryUsedBytes)} / ${gpu.memoryTotalBytes === null ? "—" : bytes(gpu.memoryTotalBytes)}，温度 ${gpu.temperatureC === null ? "—" : gpu.temperatureC + "°C"}，功耗 ${gpu.powerWatts === null ? "—" : gpu.powerWatts + " W"}`,
        );
    else lines.push(`GPU：${sample.gpuMessage || "未检测到可用 GPU"}`);
    if (sample.warnings.length)
      lines.push(`提示：${sample.warnings.join("；")}`);
    return lines.join("\n");
  }, [sample, hostName]);

  const header = (
    <div className="rw-monitor-toolbar">
      <div className="rw-monitor-tabs" role="tablist" aria-label="监控视图">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            <item.icon size={14} />
            {item.label}
          </button>
        ))}
      </div>
      <div className="rw-monitor-controls">
        <label>
          采样
          <select
            aria-label="采样间隔"
            value={interval}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
          >
            {INTERVALS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="rw-icon"
          aria-label={paused ? "继续采样" : "暂停采样"}
          title={paused ? "继续采样" : "暂停采样"}
          onClick={() => setPaused((v) => !v)}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
        <button
          className="rw-icon"
          aria-label="立即刷新"
          title="立即刷新"
          onClick={() => void load()}
        >
          <RefreshCw size={14} className={loading ? "rw-spin" : ""} />
        </button>
        <button
          className="rw-button"
          disabled={!sample}
          onClick={() => onSummary(summary)}
          title="把当前采样摘要加入 AI 上下文"
        >
          <Sparkles size={13} />
          交给 AI
        </button>
      </div>
    </div>
  );

  if (!connected)
    return (
      <div className="rw-monitor">
        {header}
        <div className="rw-monitor-state">
          <ServerCog size={26} />
          <h2>连接后开始监控</h2>
          <p>监控只在已连接的服务器上采样真实指标。</p>
          {onConnect && (
            <button
              type="button"
              className="rw-button primary"
              disabled={connecting}
              onClick={onConnect}
            >
              {connecting ? (
                <LoaderCircle size={13} className="rw-spin" />
              ) : (
                <PlugZap size={13} />
              )}
              {connecting ? "正在连接…" : `连接 ${hostName}`}
            </button>
          )}
        </div>
      </div>
    );

  return (
    <div className="rw-monitor">
      {header}
      {error && (
        <div className="rw-monitor-error" role="alert">
          <ShieldAlert size={14} />
          <span>{error}</span>
          <button className="rw-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {!sample ? (
        <div className="rw-monitor-state">
          <LoaderCircle size={24} className={loading ? "rw-spin" : ""} />
          <h2>{error ? "暂时没有数据" : "正在采集首次指标…"}</h2>
          <p>CPU 与网速需要两次采样才能给出速率，首个点显示为“采样中”。</p>
        </div>
      ) : (
        <div className="rw-monitor-body">
          {tab === "overview" && (
            <Overview sample={sample} history={history} onTab={setTab} />
          )}
          {tab === "cpu" && <CpuView sample={sample} history={history} />}
          {tab === "gpu" && <GpuView sample={sample} />}
          {tab === "memory" && <MemoryView sample={sample} history={history} />}
          {tab === "disk" && <DiskView sample={sample} />}
          {tab === "network" && (
            <NetworkView sample={sample} history={history} />
          )}
          {sample.warnings.length > 0 && (
            <ul className="rw-monitor-warnings">
              {sample.warnings.map((warning) => (
                <li key={warning}>
                  <ShieldAlert size={12} />
                  {warning}
                </li>
              ))}
            </ul>
          )}
          <div className="rw-monitor-status">
            <Timer size={11} />
            <span>
              {paused
                ? "采样已暂停"
                : updatedAt
                  ? `更新于 ${new Date(updatedAt).toLocaleTimeString("zh-CN")}`
                  : "等待采样"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function Overview({
  sample,
  history,
  onTab,
}: {
  sample: ResourceSample;
  history: ResourceHistoryPoint[];
  onTab(tab: DetailTab): void;
}) {
  const rootFs = sample.filesystems[0];
  const rx = sample.networks.reduce(
    (sum, net) => sum + (net.receiveBytesPerSecond ?? 0),
    0,
  );
  const tx = sample.networks.reduce(
    (sum, net) => sum + (net.sendBytesPerSecond ?? 0),
    0,
  );
  const rxKnown = sample.networks.some((n) => n.receiveBytesPerSecond !== null);
  const txKnown = sample.networks.some((n) => n.sendBytesPerSecond !== null);
  return (
    <div className="rw-monitor-overview">
      <section className="rw-monitor-card">
        <header>
          <ServerCog size={14} />
          <h3>{sample.hostname}</h3>
          <span className="rw-monitor-tag">{sample.platform}</span>
        </header>
        <dl className="rw-monitor-facts">
          <div>
            <dt>系统</dt>
            <dd>
              {sample.os} · {sample.kernel}
            </dd>
          </div>
          <div>
            <dt>运行时长</dt>
            <dd>{duration(sample.uptimeSeconds)}</dd>
          </div>
          <div>
            <dt>CPU</dt>
            <dd>
              {sample.cpu.model} · {sample.cpu.logicalCores} 核
            </dd>
          </div>
        </dl>
      </section>

      <section className="rw-monitor-card">
        <header>
          <Activity size={14} />
          <h3>实时负载</h3>
          <span className="rw-monitor-muted">点击指标查看详情</span>
        </header>
        <div className="rw-monitor-grid">
          <button
            type="button"
            className="rw-monitor-tile"
            onClick={() => onTab("cpu")}
          >
            <span className="rw-monitor-tile-head">
              <span>CPU</span>
              <ChevronRight size={12} />
            </span>
            <strong>{percent(sample.cpu.usagePercent, 1)}</strong>
            <Meter
              value={sample.cpu.usagePercent}
              tone={toneFor(sample.cpu.usagePercent)}
              label="CPU 使用率"
            />
            <Sparkline
              points={history}
              pick={(p) => p.cpuPercent}
              max={100}
              label="CPU 历史"
              format={(v) => percent(v, 1)}
            />
          </button>
          <button
            type="button"
            className="rw-monitor-tile"
            onClick={() => onTab("memory")}
          >
            <span className="rw-monitor-tile-head">
              <span>内存</span>
              <ChevronRight size={12} />
            </span>
            <strong>{percent(sample.memory?.usagePercent ?? null, 1)}</strong>
            <Meter
              value={sample.memory?.usagePercent ?? null}
              tone={toneFor(sample.memory?.usagePercent ?? null)}
              label="内存使用率"
            />
            <Sparkline
              points={history}
              pick={(p) => p.memoryPercent}
              max={100}
              label="内存历史"
              format={(v) => percent(v, 1)}
            />
          </button>
          <button
            type="button"
            className="rw-monitor-tile"
            onClick={() => onTab("disk")}
          >
            <span className="rw-monitor-tile-head">
              <span>根分区</span>
              <ChevronRight size={12} />
            </span>
            <strong>{percent(rootFs?.usagePercent ?? null, 1)}</strong>
            <Meter
              value={rootFs?.usagePercent ?? null}
              tone={toneFor(rootFs?.usagePercent ?? null)}
              label="根分区使用率"
            />
            <small>
              {rootFs
                ? `${rootFs.mount} · ${bytes(rootFs.usedBytes)} / ${bytes(rootFs.totalBytes)}`
                : "没有挂载点数据"}
            </small>
          </button>
          <button
            type="button"
            className="rw-monitor-tile"
            onClick={() => onTab("network")}
          >
            <span className="rw-monitor-tile-head">
              <span>网络吞吐</span>
              <ChevronRight size={12} />
            </span>
            <strong>↓ {rxKnown ? bytes(rx) + "/s" : "采样中"}</strong>
            <small>↑ {txKnown ? bytes(tx) + "/s" : "采样中"}</small>
            <Sparkline
              points={history}
              pick={(p) => p.receiveBytesPerSecond}
              label="接收速率历史"
              format={(v) => bytes(v) + "/s"}
            />
          </button>
        </div>
      </section>

      <section className="rw-monitor-card">
        <header>
          <MonitorSmartphone size={14} />
          <h3>GPU</h3>
          <button className="rw-monitor-link" onClick={() => onTab("gpu")}>
            查看显卡
          </button>
        </header>
        {sample.gpuStatus === "available" && sample.gpus.length ? (
          <ul className="rw-monitor-gpu-mini">
            {sample.gpus.map((gpu) => (
              <li key={gpu.id}>
                <strong>{gpu.name}</strong>
                <span>
                  使用 {percent(gpu.usagePercent)} · 温度{" "}
                  {gpu.temperatureC === null ? "—" : `${gpu.temperatureC}°C`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rw-monitor-muted">
            {sample.gpuMessage || "未检测到可用 GPU"}
          </p>
        )}
      </section>
    </div>
  );
}

function CpuView({
  sample,
  history,
}: {
  sample: ResourceSample;
  history: ResourceHistoryPoint[];
}) {
  return (
    <div className="rw-monitor-detail">
      <section className="rw-monitor-card">
        <header>
          <Cpu size={14} />
          <h3>{sample.cpu.model}</h3>
          <span className="rw-monitor-tag">{sample.cpu.logicalCores} 线程</span>
        </header>
        <div className="rw-monitor-hero">
          <div>
            <strong>{percent(sample.cpu.usagePercent, 1)}</strong>
            <span>总使用率</span>
          </div>
          <Sparkline
            points={history}
            pick={(p) => p.cpuPercent}
            max={100}
            label="CPU 总使用率历史"
          />
        </div>
        <div className="rw-monitor-facts">
          <div>
            <dt>用户</dt>
            <dd>{percent(sample.cpu.userPercent, 1)}</dd>
          </div>
          <div>
            <dt>系统</dt>
            <dd>{percent(sample.cpu.systemPercent, 1)}</dd>
          </div>
          <div>
            <dt>IO 等待</dt>
            <dd>{percent(sample.cpu.ioWaitPercent, 1)}</dd>
          </div>
          <div>
            <dt>频率</dt>
            <dd>
              {sample.cpu.frequencyMHz === null
                ? "—"
                : `${sample.cpu.frequencyMHz} MHz`}
            </dd>
          </div>
          <div>
            <dt>温度</dt>
            <dd>
              {sample.cpu.temperatureC === null
                ? "—"
                : `${sample.cpu.temperatureC}°C`}
            </dd>
          </div>
          <div>
            <dt>负载</dt>
            <dd>
              {sample.cpu.load.map((n) => n.toFixed(2)).join(" / ") || "—"}
            </dd>
          </div>
        </div>
      </section>
      <section className="rw-monitor-card">
        <header>
          <Activity size={14} />
          <h3>每核心</h3>
          <span className="rw-monitor-muted">
            数值来自本机采样，缺失的核显示“—”
          </span>
        </header>
        <ul className="rw-monitor-cores">
          {sample.cpu.cores.map((core) => (
            <li key={core.id}>
              <span>{core.id}</span>
              <Meter
                value={core.usagePercent}
                tone={toneFor(core.usagePercent)}
                label={`核心 ${core.id} 使用率`}
              />
              <small>{percent(core.usagePercent)}</small>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function GpuView({ sample }: { sample: ResourceSample }) {
  if (sample.gpuStatus !== "available" || !sample.gpus.length)
    return (
      <div className="rw-monitor-card rw-monitor-empty">
        <MonitorSmartphone size={22} />
        <h3>没有可用的 GPU 指标</h3>
        <p>{sample.gpuMessage || "未检测到 GPU，或驱动/工具不可读。"}</p>
        <p className="rw-monitor-muted">
          这里不会显示推测的 0%：只有 nvidia-smi
          等真实数据源可读时才会出现显卡信息。
        </p>
      </div>
    );
  return (
    <div className="rw-monitor-gpus">
      {sample.gpus.map((gpu) => (
        <section className="rw-monitor-card" key={gpu.id}>
          <header>
            <MonitorSmartphone size={14} />
            <h3>{gpu.name}</h3>
            <span className="rw-monitor-tag">{gpu.vendor}</span>
          </header>
          <div className="rw-monitor-grid">
            <div>
              <span>使用率</span>
              <strong>{percent(gpu.usagePercent, 1)}</strong>
              <Meter
                value={gpu.usagePercent}
                tone={toneFor(gpu.usagePercent)}
                label="GPU 使用率"
              />
            </div>
            <div>
              <span>显存</span>
              <strong>
                {gpu.memoryUsedBytes === null || gpu.memoryTotalBytes === null
                  ? "—"
                  : `${bytes(gpu.memoryUsedBytes)} / ${bytes(gpu.memoryTotalBytes)}`}
              </strong>
              <Meter
                value={
                  gpu.memoryUsedBytes !== null &&
                  gpu.memoryTotalBytes !== null &&
                  gpu.memoryTotalBytes > 0
                    ? (gpu.memoryUsedBytes / gpu.memoryTotalBytes) * 100
                    : null
                }
                label="GPU 显存占用"
              />
            </div>
            <div>
              <span>温度</span>
              <strong>
                {gpu.temperatureC === null ? "—" : `${gpu.temperatureC}°C`}
              </strong>
            </div>
            <div>
              <span>功耗</span>
              <strong>
                {gpu.powerWatts === null ? "—" : `${gpu.powerWatts} W`}
              </strong>
            </div>
            <div>
              <span>风扇</span>
              <strong>
                {gpu.fanPercent === null ? "—" : `${gpu.fanPercent}%`}
              </strong>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

function MemoryView({
  sample,
  history,
}: {
  sample: ResourceSample;
  history: ResourceHistoryPoint[];
}) {
  const memory = sample.memory;
  if (!memory)
    return (
      <div className="rw-monitor-card rw-monitor-empty">
        <MemoryStick size={22} />
        <h3>内存指标不可用</h3>
        <p>当前平台没有提供可读的内存数据。</p>
      </div>
    );
  const rows: { label: string; value: number | null; total?: number | null }[] =
    [
      { label: "已用", value: memory.usedBytes, total: memory.totalBytes },
      { label: "可用", value: memory.availableBytes, total: memory.totalBytes },
      { label: "缓存", value: memory.cachedBytes, total: memory.totalBytes },
      { label: "缓冲", value: memory.buffersBytes, total: memory.totalBytes },
      {
        label: "交换已用",
        value: memory.swapUsedBytes,
        total: memory.swapTotalBytes,
      },
    ];
  return (
    <div className="rw-monitor-detail">
      <section className="rw-monitor-card">
        <header>
          <MemoryStick size={14} />
          <h3>内存</h3>
          <span className="rw-monitor-tag">
            {bytes(memory.usedBytes)} / {bytes(memory.totalBytes)}
          </span>
        </header>
        <div className="rw-monitor-hero">
          <div>
            <strong>{percent(memory.usagePercent, 1)}</strong>
            <span>已用比例</span>
          </div>
          <Sparkline
            points={history}
            pick={(p) => p.memoryPercent}
            max={100}
            label="内存使用率历史"
          />
        </div>
        <ul className="rw-monitor-rows">
          {rows.map((row) => (
            <li key={row.label}>
              <span>{row.label}</span>
              <Meter
                value={
                  row.value === null || !row.total
                    ? null
                    : (row.value / row.total) * 100
                }
                label={`${row.label}内存`}
              />
              <small>
                {row.value === null
                  ? "—"
                  : `${bytes(row.value)}${row.total ? ` / ${bytes(row.total)}` : ""}`}
              </small>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function DiskView({ sample }: { sample: ResourceSample }) {
  return (
    <div className="rw-monitor-detail">
      <section className="rw-monitor-card">
        <header>
          <HardDrive size={14} />
          <h3>挂载点</h3>
          <span className="rw-monitor-tag">{sample.filesystems.length} 个</span>
        </header>
        {sample.filesystems.length ? (
          <table className="rw-monitor-table">
            <thead>
              <tr>
                <th>挂载点</th>
                <th>设备</th>
                <th>使用</th>
                <th>已用 / 总量</th>
                <th>可用</th>
              </tr>
            </thead>
            <tbody>
              {sample.filesystems.map((fs) => (
                <tr key={fs.mount + fs.device}>
                  <td data-label="挂载点">
                    <code>{fs.mount}</code>
                  </td>
                  <td data-label="设备" className="rw-monitor-muted">
                    {fs.device}
                  </td>
                  <td data-label="使用">
                    <div className="rw-monitor-cell-meter">
                      <Meter
                        value={fs.usagePercent}
                        tone={toneFor(fs.usagePercent)}
                        label={`${fs.mount} 使用率`}
                      />
                      <small>{percent(fs.usagePercent, 1)}</small>
                    </div>
                  </td>
                  <td data-label="已用 / 总量">
                    {bytes(fs.usedBytes)} / {bytes(fs.totalBytes)}
                  </td>
                  <td data-label="可用">{bytes(fs.availableBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="rw-monitor-muted">没有挂载点数据。</p>
        )}
      </section>
      <section className="rw-monitor-card">
        <header>
          <Activity size={14} />
          <h3>磁盘 IO</h3>
        </header>
        {sample.disks.length ? (
          <table className="rw-monitor-table">
            <thead>
              <tr>
                <th>设备</th>
                <th>读</th>
                <th>写</th>
                <th>忙碌</th>
              </tr>
            </thead>
            <tbody>
              {sample.disks.map((disk) => (
                <tr key={disk.device}>
                  <td data-label="设备">
                    <code>{disk.device}</code>
                  </td>
                  <td data-label="读">
                    {rate(disk.readBytesPerSecond)}
                    <small className="rw-monitor-muted">
                      {" "}
                      累计 {bytes(disk.readBytes)}
                    </small>
                  </td>
                  <td data-label="写">
                    {rate(disk.writeBytesPerSecond)}
                    <small className="rw-monitor-muted">
                      {" "}
                      累计 {bytes(disk.writeBytes)}
                    </small>
                  </td>
                  <td data-label="忙碌">{percent(disk.busyPercent, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="rw-monitor-muted">没有磁盘 IO 数据。</p>
        )}
      </section>
    </div>
  );
}

function NetworkView({
  sample,
  history,
}: {
  sample: ResourceSample;
  history: ResourceHistoryPoint[];
}) {
  return (
    <div className="rw-monitor-detail">
      <section className="rw-monitor-card">
        <header>
          <Network size={14} />
          <h3>网卡</h3>
          <span className="rw-monitor-tag">{sample.networks.length} 个</span>
        </header>
        {sample.networks.length ? (
          <table className="rw-monitor-table">
            <thead>
              <tr>
                <th>网卡</th>
                <th>地址</th>
                <th>接收</th>
                <th>发送</th>
                <th>错误</th>
              </tr>
            </thead>
            <tbody>
              {sample.networks.map((net) => (
                <tr key={net.name}>
                  <td data-label="网卡">
                    <code>{net.name}</code>
                  </td>
                  <td data-label="地址" className="rw-monitor-muted">
                    {net.addresses.join(", ") || "—"}
                  </td>
                  <td data-label="接收">
                    {rate(net.receiveBytesPerSecond)}
                    <small className="rw-monitor-muted">
                      {" "}
                      累计 {bytes(net.receivedBytes)}
                    </small>
                  </td>
                  <td data-label="发送">
                    {rate(net.sendBytesPerSecond)}
                    <small className="rw-monitor-muted">
                      {" "}
                      累计 {bytes(net.sentBytes)}
                    </small>
                  </td>
                  <td data-label="错误">
                    ↓{net.receiveErrors} / ↑{net.sendErrors}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="rw-monitor-muted">没有网卡数据。</p>
        )}
      </section>
      <section className="rw-monitor-card">
        <header>
          <Activity size={14} />
          <h3>吞吐趋势</h3>
        </header>
        <div className="rw-monitor-rates">
          <div>
            <span>接收</span>
            <Sparkline
              points={history}
              pick={(p) => p.receiveBytesPerSecond}
              label="接收速率历史"
            />
          </div>
          <div>
            <span>发送</span>
            <Sparkline
              points={history}
              pick={(p) => p.sendBytesPerSecond}
              label="发送速率历史"
            />
          </div>
        </div>
      </section>
    </div>
  );
}
