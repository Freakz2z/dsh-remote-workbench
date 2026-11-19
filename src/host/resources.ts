import type {
  ResourceSample,
  ResourceResponse,
  ResourceHistoryPoint,
  CpuMetrics,
  DiskIoMetrics,
  NetworkMetrics,
  GpuMetrics,
  MemoryMetrics,
} from "../shared/workstation.ts";

/** Fixed read-only script. No user-supplied shell fragments or remote installation. */
export const RESOURCE_PROBE = `export LC_ALL=C
section() { printf '\\n__RW_RESOURCE_V1_%s__\\n' "$1"; }
section PLATFORM; uname -s
section HOSTNAME; hostname
section KERNEL; uname -r
case "$(uname -s)" in
Linux)
 section OS; cat /etc/os-release 2>/dev/null
 section UPTIME; cat /proc/uptime 2>/dev/null
 section CPU; cat /proc/stat 2>/dev/null
 section CPUINFO; cat /proc/cpuinfo 2>/dev/null | head -c 131072
 section LOAD; cat /proc/loadavg 2>/dev/null
 section MEMORY; cat /proc/meminfo 2>/dev/null
 section FILESYSTEMS; df -Pk 2>/dev/null
 section DISKS; cat /proc/diskstats 2>/dev/null
 section NETWORKS; cat /proc/net/dev 2>/dev/null
 section ADDRESSES; ip -o addr show 2>/dev/null
 section TEMPERATURE
 for d in /sys/class/thermal/thermal_zone*; do
  [ -r "$d/type" ] || continue
  case "$(cat "$d/type")" in *cpu*|*CPU*|x86_pkg_temp) cat "$d/temp" 2>/dev/null; break;; esac
 done
 section NVIDIA
 if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,fan.speed --format=csv,noheader,nounits 2>/dev/null
 fi
 section AMD
 for d in /sys/class/drm/card[0-9]*; do
  [ -r "$d/device/vendor" ] || continue
  [ "$(cat "$d/device/vendor")" = '0x1002' ] || continue
  printf '%s|' "$(basename "$d")"
  cat "$d/device/product_name" 2>/dev/null | tr '\\n' ' '; printf '|'
  for f in gpu_busy_percent mem_info_vram_used mem_info_vram_total; do cat "$d/device/$f" 2>/dev/null | tr '\\n' ' '; printf '|'; done
  for f in "$d"/device/hwmon/hwmon*/temp1_input; do [ -r "$f" ] && cat "$f" && break; done
  printf '\\n'
 done
 ;;
Darwin)
 section OS; sw_vers -productName; sw_vers -productVersion
 section UPTIME; sysctl -n kern.boottime
 section CPUINFO; sysctl -n machdep.cpu.brand_string 2>/dev/null; sysctl -n hw.ncpu; sysctl -n hw.cpufrequency 2>/dev/null
 section LOAD; sysctl -n vm.loadavg
 section CPU; top -l 2 -s 1 -n 0 2>/dev/null | grep 'CPU usage' | tail -1
 section MEMORY; sysctl -n hw.memsize; vm_stat; sysctl vm.swapusage
 section FILESYSTEMS; df -Pk 2>/dev/null
 section NETWORKS; netstat -ibn 2>/dev/null
 ;;
esac
section END
`;

/** Fixed read-only Windows collector. Invoked as powershell -EncodedCommand, not via cmd quoting. */
const WINDOWS_PROBE_SCRIPT = `$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='SilentlyContinue'
$u=New-Object System.Text.UTF8Encoding $false
function E([string]$s){if($null -eq $s){$s=''};$b=$u.GetBytes($s+"\`n");[Console]::OpenStandardOutput().Write($b,0,$b.Length)}
function S($n){E '';E ('__RW_RESOURCE_V1_'+$n+'__')}
S PLATFORM
E Windows
$cs=Get-CimInstance Win32_ComputerSystem
$os=Get-CimInstance Win32_OperatingSystem
$cpu=@(Get-CimInstance Win32_Processor)
$mem=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
S HOSTNAME
E $cs.Name
S KERNEL
E $os.Version
S OS
E $os.Caption
S UPTIME
$boot=$os.LastBootUpTime
if($boot -is [string]){$boot=[Management.ManagementDateTimeConverter]::ToDateTime($boot)}
E ([int]((Get-Date)-$boot).TotalSeconds)
Start-Sleep -Milliseconds 800
S WINCPU
Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor|%{E ('{0}|{1}|{2}|{3}' -f $_.Name,$_.PercentProcessorTime,$_.PercentUserTime,$_.PercentPrivilegedTime)}
S CPUINFO
foreach($row in $cpu){E ('model name : {0}' -f $row.Name);E ('cpu MHz : {0}' -f $row.CurrentClockSpeed);E ('logical : {0}' -f $row.NumberOfLogicalProcessors);E ('load : {0}' -f $row.LoadPercentage)}
S MEMORY
E ('MemTotal: {0} kB' -f [int64]$os.TotalVisibleMemorySize)
E ('MemAvailable: {0} kB' -f ([int64]$mem.AvailableBytes/1024))
E ('Cached: {0} kB' -f ([int64]$mem.CacheBytes/1024))
E ('SwapTotal: {0} kB' -f [int64]$os.SizeStoredInPagingFiles)
E ('SwapFree: {0} kB' -f [int64]$os.FreeSpaceInPagingFiles)
S FILESYSTEMS
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"|%{
$t=[int64]($_.Size/1024);$a=[int64]($_.FreeSpace/1024);if($t -le 0){return}
$d=$t-$a;E ('{0} {1} {2} {3} {4}% {5}' -f $_.DeviceID,$t,$d,$a,([int][math]::Floor(100.0*$d/$t)),$_.DeviceID)}
S WINDISK
Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk|?{$_.Name -notmatch '_Total'}|%{E ('{0}|{1}|{2}' -f $_.Name,$_.DiskReadBytesPersec,$_.DiskWriteBytesPersec)}
S WINNET
Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface|%{E ('{0}|{1}|{2}|{3}|{4}' -f $_.Name,$_.BytesReceivedPersec,$_.BytesSentPersec,$_.PacketsReceivedErrors,$_.PacketsOutboundErrors)}
S WINADDR
Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True"|%{foreach($ip in @($_.IPAddress)){if($ip -notmatch ':'){E ('{0}|{1}' -f $_.Description,$ip)}}}
S NVIDIA
$smi="$env:SystemRoot\\System32\\nvidia-smi.exe"
if(-not (Test-Path -LiteralPath $smi)){$smi="$env:ProgramFiles\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"}
if(Test-Path -LiteralPath $smi){& $smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,fan.speed --format=csv,noheader,nounits|%{E $_}}
S END
exit 0
`;

export function windowsProbeCommand(): string {
  const encoded = Buffer.from(WINDOWS_PROBE_SCRIPT, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

/** SSH on Chinese Windows emits the ANSI code page. GBK of 专业 is also valid UTF-8 for unrelated characters. */
export function decodeProbeText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe)
    return buffer.subarray(2).toString("utf16le");
  if (buffer.length >= 4 && buffer[1] === 0 && buffer[3] === 0 && buffer[0] < 0x80)
    return buffer.toString("utf16le");
  return buffer.toString("utf8");
}

interface RawSample {
  sections: Record<string, string>;
  at: number;
  revision: number;
}
const number = (v: string | undefined): number | null => {
  if (!v || !/^-?[\d.]+$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const percent = (v: number) => Math.max(0, Math.min(100, v));
const lines = (value = "") => value.split(/\r?\n/).filter(Boolean);
const clean = (value = "") =>
  value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();

export function parseResourceSections(stdout: string): Record<string, string> {
  const parts = stdout.split(/(?:^|[\r\n]+)__RW_RESOURCE_V1_([A-Z]+)__\r?\n/);
  const result: Record<string, string> = {};
  for (let i = 1; i + 1 < parts.length; i += 2)
    result[parts[i]] = parts[i + 1].trim();
  return result;
}
function cpuCounters(value: string) {
  const result = new Map<string, number[]>();
  for (const row of lines(value)) {
    const [id, ...values] = row.trim().split(/\s+/);
    if (/^cpu\d*$/.test(id)) result.set(id, values.slice(0, 8).map(Number));
  }
  return result;
}
function cpuDelta(
  current: number[] | undefined,
  previous: number[] | undefined,
) {
  if (!current || !previous) return null;
  const diff = current.map((n, i) => n - (previous[i] ?? 0));
  if (diff.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const total = diff.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const part = (n: number) => percent((n / total) * 100);
  return {
    usage: part(total - (diff[3] ?? 0) - (diff[4] ?? 0)),
    user: part((diff[0] ?? 0) + (diff[1] ?? 0)),
    system: part((diff[2] ?? 0) + (diff[5] ?? 0) + (diff[6] ?? 0)),
    ioWait: part(diff[4] ?? 0),
  };
}
function linuxMemory(raw: string): MemoryMetrics | null {
  const entries: Record<string, number> = {};
  for (const row of lines(raw)) {
    const match = row.match(/^([A-Za-z_()]+):\s+(\d+)/);
    if (match) entries[match[1]] = Number(match[2]) * 1024;
  }
  const total = entries.MemTotal;
  if (!total) return null;
  const available = Math.min(
    total,
    entries.MemAvailable ??
      (entries.MemFree ?? 0) + (entries.Cached ?? 0) + (entries.Buffers ?? 0),
  );
  return {
    totalBytes: total,
    usedBytes: total - available,
    availableBytes: available,
    cachedBytes: (entries.Cached ?? 0) + (entries.SReclaimable ?? 0),
    buffersBytes: entries.Buffers ?? 0,
    swapTotalBytes: entries.SwapTotal ?? 0,
    swapUsedBytes: (entries.SwapTotal ?? 0) - (entries.SwapFree ?? 0),
    usagePercent: percent(((total - available) / total) * 100),
  };
}
function darwinMemory(raw: string): MemoryMetrics | null {
  const total = Number(lines(raw)[0]);
  if (!Number.isFinite(total) || total <= 0) return null;
  const pageSize = Number(raw.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
  const count = (name: string) =>
    Number(raw.match(new RegExp(name + ":\\s+(\\d+)"))?.[1] ?? 0) * pageSize;
  const available = Math.min(
    total,
    count("Pages free") + count("Pages inactive") + count("Pages speculative"),
  );
  const swap = (name: string) => {
    const match = raw.match(new RegExp(name + " =\\s*([\\d.]+)([KMG])"));
    return match
      ? Number(match[1]) * 1024 ** ("KMG".indexOf(match[2]) + 1)
      : null;
  };
  return {
    totalBytes: total,
    usedBytes: total - available,
    availableBytes: available,
    cachedBytes: count("File-backed pages"),
    buffersBytes: null,
    swapTotalBytes: swap("total"),
    swapUsedBytes: swap("used"),
    usagePercent: percent(((total - available) / total) * 100),
  };
}
function filesystems(raw: string) {
  return lines(raw).flatMap((row) => {
    const match = row.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!match || !Number(match[2])) return [];
    return [
      {
        device: clean(match[1]),
        totalBytes: Number(match[2]) * 1024,
        usedBytes: Number(match[3]) * 1024,
        availableBytes: Number(match[4]) * 1024,
        usagePercent: percent(Number(match[5])),
        mount: clean(match[6]).replace(/\\040/g, " "),
      },
    ];
  });
}
function rate(
  now: number,
  before: number | undefined,
  seconds: number,
): number | null {
  return before === undefined || seconds <= 0 || now < before
    ? null
    : (now - before) / seconds;
}
function diskCounters(raw: string) {
  const result = new Map<
    string,
    { read: number; write: number; busy: number }
  >();
  for (const row of lines(raw)) {
    const cols = row.trim().split(/\s+/);
    if (cols.length < 14 || /^(loop|ram|fd|sr)/.test(cols[2])) continue;
    result.set(cols[2], {
      read: Number(cols[5]) * 512,
      write: Number(cols[9]) * 512,
      busy: Number(cols[12]),
    });
  }
  return result;
}
function networkCounters(raw: string, darwin: boolean) {
  const result = new Map<
    string,
    {
      received: number;
      sent: number;
      receiveErrors: number;
      sendErrors: number;
      addresses: string[];
    }
  >();
  if (darwin) {
    const rows = lines(raw).map((row) => row.trim().split(/\s+/));
    const header = rows.shift() ?? [];
    const index = (name: string) => header.indexOf(name);
    if (index("Ibytes") < 0 || index("Obytes") < 0) return result;
    for (const cols of rows) {
      const name = cols[0]?.replace(/\*$/, "");
      if (!name || cols.length < header.length - 1) continue;
      const received = Number(cols[index("Ibytes")]);
      const sent = Number(cols[index("Obytes")]);
      if (!Number.isFinite(received) || !Number.isFinite(sent)) continue;
      const old = result.get(name);
      const address = cols[index("Address")];
      const addresses = [
        ...new Set([
          ...(old?.addresses ?? []),
          ...(address && !address.includes(":") ? [address] : []),
        ]),
      ];
      if (!old || received + sent >= old.received + old.sent)
        result.set(name, {
          received,
          sent,
          receiveErrors: Number(cols[index("Ierrs")]) || 0,
          sendErrors: Number(cols[index("Oerrs")]) || 0,
          addresses,
        });
    }
  } else {
    for (const row of lines(raw)) {
      const match = row.match(/^\s*([^:]+):\s*(.*)$/);
      if (!match) continue;
      const c = match[2].split(/\s+/).map(Number);
      if (c.length < 16 || c.some((n) => !Number.isFinite(n))) continue;
      result.set(match[1].trim(), {
        received: c[0],
        sent: c[8],
        receiveErrors: c[2],
        sendErrors: c[10],
        addresses: [],
      });
    }
  }
  return result;
}
function csv(row: string) {
  return (row.match(/(?:"(?:[^"]|"")*"|[^,])+/g) ?? []).map((s) =>
    s.trim().replace(/^"|"$/g, "").replace(/""/g, '"'),
  );
}
function gpus(sections: Record<string, string>): GpuMetrics[] {
  const nvidia = lines(sections.NVIDIA).flatMap((row) => {
    const c = csv(row);
    if (c.length !== 8 || number(c[0]) === null) return [];
    const mib = (n: string) =>
      number(n) === null ? null : Number(n) * 1024 * 1024;
    return [
      {
        id: "nvidia-" + c[0],
        vendor: "NVIDIA",
        name: clean(c[1]),
        usagePercent: number(c[2]),
        memoryUsedBytes: mib(c[3]),
        memoryTotalBytes: mib(c[4]),
        temperatureC: number(c[5]),
        powerWatts: number(c[6]),
        fanPercent: number(c[7]),
      },
    ];
  });
  const amd = lines(sections.AMD).flatMap((row) => {
    const c = row.split("|").map(clean);
    if (c.length < 6) return [];
    const temp = number(c[5]);
    return [
      {
        id: c[0],
        vendor: "AMD",
        name: c[1] || "AMD " + c[0],
        usagePercent: number(c[2]),
        memoryUsedBytes: number(c[3]),
        memoryTotalBytes: number(c[4]),
        temperatureC: temp === null ? null : temp / 1000,
        powerWatts: null,
        fanPercent: null,
      },
    ];
  });
  return [...nvidia, ...amd];
}

function pipeTail(row: string, count: number) {
  const parts = row.split("|");
  if (parts.length < count + 1) return null;
  const values = parts.splice(parts.length - count, count).map(Number);
  if (values.some((n) => !Number.isFinite(n))) return null;
  return { name: parts.join("|").trim(), values };
}
function windowsCpu(sections: Record<string, string>): CpuMetrics {
  const rows = lines(sections.WINCPU).flatMap((row) => {
    const parsed = pipeTail(row, 3);
    if (!parsed) return [];
    return [
      {
        name: parsed.name,
        usage: parsed.values[0],
        user: parsed.values[1],
        system: parsed.values[2],
      },
    ];
  });
  const total = rows.find((row) => /total/i.test(row.name));
  const info = lines(sections.CPUINFO);
  const models = info.flatMap(
    (row) => row.match(/^model name\s*:\s*(.+)/)?.[1] ?? [],
  );
  const mhz = info
    .flatMap((row) => row.match(/^cpu MHz\s*:\s*([\d.]+)/)?.[1] ?? [])
    .map(Number);
  const logical = info
    .flatMap((row) => row.match(/^logical\s*:\s*(\d+)/)?.[1] ?? [])
    .map(Number);
  const loads = info
    .flatMap((row) => row.match(/^load\s*:\s*([\d.]+)/)?.[1] ?? [])
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const load = loads.length
    ? loads.reduce((sum, n) => sum + n, 0) / loads.length
    : null;
  const usage = total?.usage ?? load;
  return {
    model: clean(models[0] ?? "未知 CPU"),
    logicalCores: logical.reduce((sum, n) => sum + n, 0) || rows.filter((row) => row !== total).length,
    usagePercent:
      usage === 0 && load !== null && load > 0 ? percent(load) : usage,
    userPercent: total?.user ?? null,
    systemPercent: total?.system ?? null,
    ioWaitPercent: null,
    frequencyMHz: mhz.length
      ? mhz.reduce((sum, n) => sum + n, 0) / mhz.length
      : null,
    temperatureC: null,
    load: load === null ? [] : [Number(load.toFixed(2))],
    cores: rows
      .filter((row) => row !== total)
      .map((row) => ({ id: row.name, usagePercent: row.usage })),
  };
}
function windowsDisks(raw: string) {
  const result = new Map<string, { read: number; write: number }>();
  for (const row of lines(raw)) {
    const parsed = pipeTail(row, 2);
    if (!parsed?.name) continue;
    result.set(parsed.name, { read: parsed.values[0], write: parsed.values[1] });
  }
  return result;
}
function windowsNetworks(sections: Record<string, string>) {
  const addresses = new Map<string, string[]>();
  for (const row of lines(sections.WINADDR)) {
    const split = row.indexOf("|");
    if (split <= 0) continue;
    const name = row.slice(0, split).trim();
    const address = row.slice(split + 1).trim();
    if (!name || !address) continue;
    addresses.set(name, [...(addresses.get(name) ?? []), address]);
  }
  return lines(sections.WINNET).flatMap((row) => {
    const parsed = pipeTail(row, 4);
    if (!parsed?.name) return [];
    return [
      {
        name: parsed.name,
        addresses: addresses.get(parsed.name) ?? [],
        received: parsed.values[0],
        sent: parsed.values[1],
        receiveErrors: parsed.values[2],
        sendErrors: parsed.values[3],
      },
    ];
  });
}
function buildWindowsSample(
  hostId: string,
  current: RawSample,
  previous?: RawSample,
): ResourceSample {
  const s = current.sections;
  const validPrevious =
    previous?.revision === current.revision ? previous : undefined;
  const seconds = validPrevious ? (current.at - validPrevious.at) / 1000 : 0;
  const cpu = windowsCpu(s);
  const memory = linuxMemory(s.MEMORY ?? "");
  if (memory) memory.buffersBytes = null;
  const currentDisks = windowsDisks(s.WINDISK ?? "");
  const previousDisks = windowsDisks(validPrevious?.sections.WINDISK ?? "");
  const disks: DiskIoMetrics[] = [...currentDisks].map(([device, c]) => ({
    device,
    readBytes: c.read,
    writeBytes: c.write,
    readBytesPerSecond: rate(c.read, previousDisks.get(device)?.read, seconds),
    writeBytesPerSecond: rate(
      c.write,
      previousDisks.get(device)?.write,
      seconds,
    ),
    busyPercent: null,
  }));
  const networks: NetworkMetrics[] = windowsNetworks(s).map((net) => {
    const before = windowsNetworks(validPrevious?.sections ?? {}).find(
      (row) => row.name === net.name,
    );
    return {
      name: net.name,
      addresses: net.addresses,
      receivedBytes: net.received,
      sentBytes: net.sent,
      receiveErrors: net.receiveErrors,
      sendErrors: net.sendErrors,
      receiveBytesPerSecond: rate(net.received, before?.received, seconds),
      sendBytesPerSecond: rate(net.sent, before?.sent, seconds),
    };
  });
  const gpu = gpus(s);
  const warnings = [
    "Windows 不提供 CPU 温度、IO 等待和磁盘忙碌率；磁盘与网络速率从第二次采样开始。",
  ];
  if (!s.WINCPU) warnings.push("无法读取处理器计数器。");
  return {
    hostId,
    hostRevision: current.revision,
    sampledAt: current.at,
    platform: "windows",
    hostname: clean(s.HOSTNAME),
    kernel: clean(s.KERNEL),
    os: clean(s.OS ?? "Windows"),
    uptimeSeconds: number(s.UPTIME?.split(/\s+/)[0]),
    cpu,
    memory,
    gpus: gpu,
    gpuStatus: gpu.length ? "available" : "unavailable",
    gpuMessage: gpu.length
      ? ""
      : "未发现可读取的 NVIDIA GPU；无显卡、驱动未安装或 nvidia-smi 不在默认路径时不可用",
    filesystems: filesystems(s.FILESYSTEMS ?? ""),
    disks,
    networks,
    warnings,
  };
}

export function buildResourceSample(
  hostId: string,
  current: RawSample,
  previous?: RawSample,
): ResourceSample {
  if (current.sections.PLATFORM === "Windows")
    return buildWindowsSample(hostId, current, previous);
  const s = current.sections;
  const platform =
    s.PLATFORM === "Linux"
      ? "linux"
      : s.PLATFORM === "Darwin"
        ? "darwin"
        : "unsupported";
  const validPrevious =
    previous?.revision === current.revision ? previous : undefined;
  const seconds = validPrevious ? (current.at - validPrevious.at) / 1000 : 0;
  const counters = cpuCounters(s.CPU ?? "");
  const before = cpuCounters(validPrevious?.sections.CPU ?? "");
  const usage = cpuDelta(counters.get("cpu"), before.get("cpu"));
  const mhz = lines(s.CPUINFO)
    .flatMap((row) => row.match(/^cpu MHz\s*:\s*([\d.]+)/)?.[1] ?? [])
    .map(Number);
  const darwinCpu = s.CPU?.match(
    /CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/,
  );
  const darwinInfo = lines(s.CPUINFO);
  const cpu: CpuMetrics = {
    model: clean(
      s.CPUINFO?.match(
        /(?:model name|Hardware|Processor)\s*:\s*([^\n]+)/,
      )?.[1] ?? (platform === "darwin" ? darwinInfo[0] : "未知 CPU"),
    ),
    logicalCores:
      platform === "linux"
        ? Math.max(1, counters.size - 1)
        : Number(darwinInfo[1]) || 0,
    usagePercent: darwinCpu
      ? percent(100 - Number(darwinCpu[3]))
      : (usage?.usage ?? null),
    userPercent: darwinCpu ? Number(darwinCpu[1]) : (usage?.user ?? null),
    systemPercent: darwinCpu ? Number(darwinCpu[2]) : (usage?.system ?? null),
    ioWaitPercent: usage?.ioWait ?? null,
    frequencyMHz: mhz.length
      ? mhz.reduce((a, b) => a + b, 0) / mhz.length
      : platform === "darwin"
        ? Number(darwinInfo[2]) / 1e6 || null
        : null,
    temperatureC:
      number(s.TEMPERATURE) === null ? null : Number(s.TEMPERATURE) / 1000,
    load: (s.LOAD?.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number),
    cores: [...counters]
      .filter(([id]) => id !== "cpu")
      .map(([id, values]) => ({
        id,
        usagePercent: cpuDelta(values, before.get(id))?.usage ?? null,
      })),
  };
  const currentDisks = diskCounters(s.DISKS ?? "");
  const previousDisks = diskCounters(validPrevious?.sections.DISKS ?? "");
  const disks: DiskIoMetrics[] = [...currentDisks].map(([device, c]) => ({
    device,
    readBytes: c.read,
    writeBytes: c.write,
    readBytesPerSecond: rate(c.read, previousDisks.get(device)?.read, seconds),
    writeBytesPerSecond: rate(
      c.write,
      previousDisks.get(device)?.write,
      seconds,
    ),
    busyPercent:
      previousDisks.has(device) &&
      seconds > 0 &&
      c.busy >= previousDisks.get(device)!.busy
        ? percent((c.busy - previousDisks.get(device)!.busy) / (seconds * 10))
        : null,
  }));
  const currentNetworks = networkCounters(
    s.NETWORKS ?? "",
    platform === "darwin",
  );
  const previousNetworks = networkCounters(
    validPrevious?.sections.NETWORKS ?? "",
    platform === "darwin",
  );
  for (const row of lines(s.ADDRESSES)) {
    const match = row.match(/^\d+:\s+(\S+)\s+inet6?\s+(\S+)/);
    if (match)
      currentNetworks.get(match[1].split("@")[0])?.addresses.push(match[2]);
  }
  const networks: NetworkMetrics[] = [...currentNetworks].map(([name, c]) => ({
    name,
    addresses: c.addresses,
    receivedBytes: c.received,
    sentBytes: c.sent,
    receiveErrors: c.receiveErrors,
    sendErrors: c.sendErrors,
    receiveBytesPerSecond: rate(
      c.received,
      previousNetworks.get(name)?.received,
      seconds,
    ),
    sendBytesPerSecond: rate(c.sent, previousNetworks.get(name)?.sent, seconds),
  }));
  const gpu = gpus(s);
  const warnings: string[] = [];
  if (platform === "unsupported")
    warnings.push("当前系统暂不支持资源采集，已支持 Linux、macOS 和 Windows。");
  if (platform === "darwin")
    warnings.push(
      "macOS 可用内存依据页统计估算；逐核心使用率、磁盘 I/O 与 GPU 实时指标未暴露。",
    );
  if (platform === "linux" && !s.CPU)
    warnings.push("无法读取 /proc/stat，请检查当前用户的读取权限。");
  const boot = Number(s.UPTIME?.match(/sec = (\d+)/)?.[1]);
  return {
    hostId,
    hostRevision: current.revision,
    sampledAt: current.at,
    platform,
    hostname: clean(s.HOSTNAME),
    kernel: clean(s.KERNEL),
    os: clean(
      s.OS?.match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1] ?? s.OS ?? s.PLATFORM,
    ),
    uptimeSeconds:
      platform === "linux"
        ? number(s.UPTIME?.split(/\s+/)[0])
        : boot
          ? Math.max(0, current.at / 1000 - boot)
          : null,
    cpu,
    memory:
      platform === "darwin"
        ? darwinMemory(s.MEMORY ?? "")
        : linuxMemory(s.MEMORY ?? ""),
    gpus: gpu,
    gpuStatus: gpu.length ? "available" : "unavailable",
    gpuMessage: gpu.length
      ? ""
      : platform === "darwin"
        ? "macOS 未提供可读取的 GPU 实时指标"
        : "未发现可读取的 NVIDIA / AMD GPU；无显卡、驱动未安装或权限不足时不可用",
    filesystems: filesystems(s.FILESYSTEMS ?? ""),
    disks,
    networks,
    warnings,
  };
}

export class ResourceMonitor {
  private entries = new Map<
    string,
    { raw: RawSample; response: ResourceResponse }
  >();
  private pending = new Map<string, Promise<ResourceResponse>>();
  private epochs = new Map<string, number>();
  constructor(
    private probe: (hostId: string, command: string) => Promise<string>,
    private revision: (hostId: string) => number,
  ) {}
  clear(hostId: string) {
    this.entries.delete(hostId);
    this.pending.delete(hostId);
    this.epochs.set(hostId, (this.epochs.get(hostId) ?? 0) + 1);
  }
  async get(hostId: string): Promise<ResourceResponse> {
    const revision = this.revision(hostId);
    const previous = this.entries.get(hostId);
    if (
      previous?.raw.revision === revision &&
      Date.now() - previous.raw.at < 2000
    )
      return structuredClone(previous.response);
    const pending = this.pending.get(hostId);
    if (pending) return structuredClone(await pending);
    const epoch = this.epochs.get(hostId) ?? 0;
    const operation = (async () => {
      const output = await this.probe(hostId, RESOURCE_PROBE);
      const raw = {
        sections: parseResourceSections(output),
        at: Date.now(),
        revision,
      };
      const sample = buildResourceSample(hostId, raw, previous?.raw);
      const active = sample.networks.filter(
        (n) => n.name !== "lo" && n.name !== "lo0",
      );
      const sum = (key: "receiveBytesPerSecond" | "sendBytesPerSecond") =>
        active.some((n) => n[key] !== null)
          ? active.reduce((a, n) => a + (n[key] ?? 0), 0)
          : null;
      const point: ResourceHistoryPoint = {
        sampledAt: sample.sampledAt,
        cpuPercent: sample.cpu.usagePercent,
        memoryPercent: sample.memory?.usagePercent ?? null,
        receiveBytesPerSecond: sum("receiveBytesPerSecond"),
        sendBytesPerSecond: sum("sendBytesPerSecond"),
      };
      const response: ResourceResponse = {
        sample,
        history: [
          ...(previous?.raw.revision === revision
            ? previous.response.history
            : []),
          point,
        ].slice(-120),
        intervalMs: 3000,
      };
      if (
        (this.epochs.get(hostId) ?? 0) === epoch &&
        this.revision(hostId) === revision
      )
        this.entries.set(hostId, { raw, response });
      return response;
    })();
    this.pending.set(hostId, operation);
    try {
      return structuredClone(await operation);
    } finally {
      if (this.pending.get(hostId) === operation) this.pending.delete(hostId);
    }
  }
}
