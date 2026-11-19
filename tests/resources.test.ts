import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildResourceSample,
  ResourceMonitor,
  parseResourceSections,
  windowsProbeCommand,
} from "../src/host/resources.ts";

const linux = (next = false) => ({
  PLATFORM: "Linux",
  HOSTNAME: "linux-fixture",
  KERNEL: "6.8.0",
  OS: 'PRETTY_NAME="Test Linux"',
  UPTIME: "86400.00 12345.00",
  CPU: next
    ? "cpu 140 0 120 1040 0 0 0 0\ncpu0 70 0 60 520 0 0 0 0\ncpu1 70 0 60 520 0 0 0 0"
    : "cpu 100 0 100 1000 0 0 0 0\ncpu0 50 0 50 500 0 0 0 0\ncpu1 50 0 50 500 0 0 0 0",
  CPUINFO: "model name : Fixture CPU\ncpu MHz : 2400\ncpu MHz : 2600",
  LOAD: "0.50 0.25 0.10 1/100 123",
  MEMORY:
    "MemTotal: 1000000 kB\nMemAvailable: 600000 kB\nCached: 200000 kB\nSReclaimable: 10000 kB\nBuffers: 10000 kB\nSwapTotal: 200000 kB\nSwapFree: 100000 kB",
  FILESYSTEMS:
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 10000 4000 6000 40% /\n/dev/sdb1 20000 10000 10000 50% /mnt/a\\040b",
  DISKS: next
    ? "8 0 sda 10 0 120 0 20 0 240 0 0 300 0"
    : "8 0 sda 10 0 100 0 20 0 200 0 0 100 0",
  NETWORKS: next
    ? "eth0: 5000 5 1 0 0 0 0 0 9000 9 2 0 0 0 0 0"
    : "eth0: 1000 1 0 0 0 0 0 0 3000 3 0 0 0 0 0 0",
  ADDRESSES: "2: eth0 inet 10.0.0.2/24 scope global eth0",
  TEMPERATURE: "42000",
  NVIDIA: '0, "NVIDIA Test, GPU", 42, 1024, 8192, 55, 120.5, 30',
  AMD: "",
});
const raw = (next: boolean, at: number, revision = 1) => ({
  sections: linux(next),
  at,
  revision,
});
afterEach(() => vi.useRealTimers());

describe("resource probe output parsing", () => {
  it("keeps first rates unavailable and calculates CPU, disk and network deltas", () => {
    const first = buildResourceSample("host", raw(false, 1000));
    expect(first.cpu.usagePercent).toBeNull();
    expect(first.networks[0].receiveBytesPerSecond).toBeNull();
    const sample = buildResourceSample(
      "host",
      raw(true, 3000),
      raw(false, 1000),
    );
    expect(sample.cpu).toMatchObject({
      usagePercent: 60,
      userPercent: 40,
      systemPercent: 20,
      logicalCores: 2,
      frequencyMHz: 2500,
      load: [0.5, 0.25, 0.1],
      temperatureC: 42,
    });
    expect(sample.cpu.cores.map((c) => c.usagePercent)).toEqual([60, 60]);
    expect(sample.memory).toMatchObject({
      usedBytes: 400000 * 1024,
      availableBytes: 600000 * 1024,
      usagePercent: 40,
    });
    expect(sample.filesystems[1].mount).toBe("/mnt/a b");
    expect(sample.disks[0]).toMatchObject({
      readBytesPerSecond: 5120,
      writeBytesPerSecond: 10240,
      busyPercent: 10,
    });
    expect(sample.networks[0]).toMatchObject({
      receiveBytesPerSecond: 2000,
      sendBytesPerSecond: 3000,
      addresses: ["10.0.0.2/24"],
    });
    expect(sample.gpus[0]).toMatchObject({
      name: "NVIDIA Test, GPU",
      usagePercent: 42,
      memoryUsedBytes: 1024 ** 3,
      temperatureC: 55,
    });
  });
  it("does not create negative rates after reboot or reuse a previous connection revision", () => {
    const reset = buildResourceSample(
      "host",
      raw(false, 5000),
      raw(true, 3000),
    );
    expect(reset.cpu.usagePercent).toBeNull();
    expect(reset.networks[0].receiveBytesPerSecond).toBeNull();
    const changed = buildResourceSample(
      "host",
      raw(true, 5000, 2),
      raw(false, 3000, 1),
    );
    expect(changed.cpu.usagePercent).toBeNull();
    expect(changed.disks[0].readBytesPerSecond).toBeNull();
  });
  it("parses Windows counters without treating a missing GPU as zero", () => {
    // Synthetic probe data, including a Chinese OS name and a documentation IP.
    const previous = {
      sections: {
        PLATFORM: "Windows",
        HOSTNAME: "win-fixture",
        KERNEL: "10.0.10000",
        OS: "Windows 测试版",
        UPTIME: "3600",
        WINCPU: "_Total|2|1|1\n0|4|3|1",
        CPUINFO:
          "model name : Fixture CPU\ncpu MHz : 2400\nlogical : 4\nload : 2",
        MEMORY:
          "MemTotal: 8388608 kB\nMemAvailable: 6291456 kB\nCached: 1048576 kB\nSwapTotal: 2097152 kB\nSwapFree: 1572864 kB",
        FILESYSTEMS: "X: 102400 25600 76800 25% X:",
        WINDISK: "0 X: Y:|1000|2000",
        WINNET: "Fixture Ethernet|1000|4000|0|1",
        WINADDR: "Fixture Ethernet|192.0.2.8",
        NVIDIA: "0, NVIDIA Fixture GPU, 10, 1024, 8192, 40, 15.5, 20",
      },
      at: 1000,
      revision: 1,
    };
    const first = buildResourceSample("host", previous);
    expect(first.platform).toBe("windows");
    expect(first.os).toBe("Windows 测试版");
    expect(first.cpu).toMatchObject({
      model: "Fixture CPU",
      logicalCores: 4,
      usagePercent: 2,
      frequencyMHz: 2400,
    });
    expect(first.cpu.cores).toEqual([{ id: "0", usagePercent: 4 }]);
    expect(first.memory?.usagePercent).toBeGreaterThan(0);
    expect(first.filesystems[0].mount).toBe("X:");
    expect(first.disks[0].readBytesPerSecond).toBeNull();
    expect(first.networks[0]).toMatchObject({
      receiveBytesPerSecond: null,
      addresses: ["192.0.2.8"],
    });
    expect(first.gpus[0]).toMatchObject({
      name: "NVIDIA Fixture GPU",
      usagePercent: 10,
      memoryTotalBytes: 8192 * 1024 * 1024,
    });
    const next = buildResourceSample(
      "host",
      {
        sections: {
          ...previous.sections,
          WINDISK: "0 X: Y:|3000|2000",
          WINNET: "Fixture Ethernet|5000|4000|0|1",
          WINCPU: "_Total|2|1|1",
          NVIDIA: "",
        },
        at: 3000,
        revision: 1,
      },
      previous,
    );
    expect(next.disks[0].readBytesPerSecond).toBe(1000);
    expect(next.networks[0].receiveBytesPerSecond).toBe(2000);
    expect(next.gpuStatus).toBe("unavailable");
    expect(next.gpus).toEqual([]);
    const command = windowsProbeCommand();
    expect(command.length).toBeLessThan(8000);
    const script = Buffer.from(command.split(" ").at(-1) ?? "", "base64").toString(
      "utf16le",
    );
    expect(script).toContain("UTF8Encoding");
    expect(script).toContain("OpenStandardOutput");
  });
  it("reports absent GPU and unsupported platforms without fabricating measurements", () => {
    const sections = { ...linux(), NVIDIA: "" };
    const sample = buildResourceSample("host", {
      sections,
      at: 1000,
      revision: 1,
    });
    expect(sample.gpus).toEqual([]);
    expect(sample.gpuStatus).toBe("unavailable");
    const unsupported = buildResourceSample("host", {
      sections: { PLATFORM: "FreeBSD" },
      at: 1000,
      revision: 1,
    });
    expect(unsupported.platform).toBe("unsupported");
    expect(unsupported.memory).toBeNull();
    expect(unsupported.warnings.length).toBeGreaterThan(0);
  });
  it("parses framing and deduplicates/cache-bounds concurrent SSH probes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const text =
      Object.entries(linux())
        .map(([key, value]) => `\n__RW_RESOURCE_V1_${key}__\n${value}`)
        .join("") + "\n__RW_RESOURCE_V1_END__\n";
    expect(parseResourceSections(text).PLATFORM).toBe("Linux");
    const probe = vi.fn(async () => text);
    const monitor = new ResourceMonitor(probe, () => 1);
    await Promise.all([monitor.get("host"), monitor.get("host")]);
    expect(probe).toHaveBeenCalledTimes(1);
    const cached = await monitor.get("host");
    expect(probe).toHaveBeenCalledTimes(1);
    cached.sample.hostname = "do not poison the cache";
    vi.setSystemTime(103000);
    const next = await monitor.get("host");
    expect(probe).toHaveBeenCalledTimes(2);
    expect(next.history).toHaveLength(2);
    expect(next.sample.hostname).toBe("linux-fixture");
    monitor.clear("host");
    expect((await monitor.get("host")).history).toHaveLength(1);
  });
});
