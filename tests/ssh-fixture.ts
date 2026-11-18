import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";

const exec = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function startFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rw-integration-")));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "logs"));
  await mkdir(join(workspace, "public"));
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([595, 842]).drawText("Remote Workbench PDF preview", {
    x: 48,
    y: 780,
    size: 20,
    font,
  });
  pdf.addPage([595, 842]).drawText("Page two: annotations and rotation", {
    x: 48,
    y: 780,
    size: 16,
    font,
  });
  const form = pdf.getForm().createTextField("Operator");
  form.setText("OpenSSH fixture");
  form.addToPage(pdf.getPage(0), { x: 48, y: 700, width: 250, height: 28 });
  await Promise.all([
    writeFile(join(workspace, "sample.pdf"), await pdf.save()),
    writeFile(
      join(workspace, "sample.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
        "base64",
      ),
    ),
    writeFile(
      join(workspace, "sample.md"),
      "# 远程 Markdown\n\n支持**预览与编辑**、表格和代码。\n\n| 功能 | 状态 |\n| --- | --- |\n| SSH | 已连接 |\n\n```sh\nprintf 'Hello Workbench'\n```\n\n![远程图片](sample.png)\n",
    ),
    writeFile(
      join(workspace, "sample.json"),
      '{\n  "name": "remote-workbench",\n  "enabled": true\n}\n',
    ),
    writeFile(
      join(workspace, "README.md"),
      "# Remote Workbench\n\n这是本机隔离目录中的真实 OpenSSH 集成测试项目。\n\n## 开始工作\n\n文件、终端和 AI 在同一个工作台协作。\n",
    ),
    writeFile(
      join(workspace, "package.json"),
      JSON.stringify(
        {
          name: "workbench-sandbox",
          version: "1.0.0",
          scripts: { start: "node src/server.js" },
        },
        null,
        2,
      ) + "\n",
    ),
    writeFile(
      join(workspace, "nginx.conf"),
      "server {\n    listen 8080;\n    server_name localhost;\n\n    location /api {\n        proxy_pass http://127.0.0.1:3000;\n        proxy_set_header Host $host;\n    }\n}\n",
    ),
    writeFile(
      join(workspace, "src", "server.js"),
      "import http from 'node:http';\n\nhttp.createServer((req, res) => {\n  res.end('Hello from Remote Workbench');\n}).listen(3000);\n",
    ),
    writeFile(
      join(workspace, "logs", "error.log"),
      "2026-11-16 10:32:18 [error] connect() failed (61: Connection refused) while connecting to upstream\n2026-11-16 10:32:18 [error] upstream: http://127.0.0.1:3000/api/health\n",
    ),
    writeFile(
      join(workspace, "logs", "access.log"),
      '127.0.0.1 - - [16/Nov/2026:10:32:18 +0800] "GET /api/health HTTP/1.1" 502 157\n',
    ),
    writeFile(
      join(workspace, ".env.example"),
      "PORT=3000\nNODE_ENV=development\n",
    ),
    writeFile(
      join(workspace, "public", "index.html"),
      '<!doctype html><html lang="zh-CN"><title>Workbench Sandbox</title><h1>Connected.</h1></html>\n',
    ),
  ]);
  await exec("/usr/bin/ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    join(root, "host"),
  ]);
  await exec("/usr/bin/ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    join(root, "identity"),
  ]);
  const publicKey = (await readFile(join(root, "host.pub"), "utf8")).split(
    " ",
  )[1];
  const fingerprint =
    "SHA256:" +
    createHash("sha256")
      .update(Buffer.from(publicKey, "base64"))
      .digest("base64")
      .replace(/=+$/, "");
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const username = userInfo().username;
  const config =
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${root}/host`,
      `PidFile ${root}/pid`,
      `AuthorizedKeysFile ${root}/identity.pub`,
      `AllowUsers ${username}`,
      "UsePAM no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "StrictModes no",
      "PermitUserEnvironment no",
      "AllowAgentForwarding no",
      "AllowTcpForwarding yes",
      "PermitTunnel no",
      "Subsystem sftp internal-sftp",
      "LogLevel ERROR",
    ].join("\n") + "\n";
  await writeFile(join(root, "sshd.conf"), config, { mode: 0o600 });
  const child = spawn(
    "/usr/sbin/sshd",
    ["-D", "-e", "-f", join(root, "sshd.conf")],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let diagnostic = "";
  child.stderr.on("data", (b: Buffer) => {
    diagnostic = (diagnostic + b.toString()).slice(-2000);
  });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) break;
    ready = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ready) break;
    await delay(50);
  }
  if (!ready) {
    child.kill();
    await rm(root, { recursive: true, force: true });
    throw new Error("无法启动本机 OpenSSH 测试服务器：" + diagnostic);
  }
  return {
    port,
    root,
    workspace,
    username,
    privateKeyPath: join(root, "identity"),
    fingerprint,
    async close() {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}
