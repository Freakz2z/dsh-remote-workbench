# DSH Workstation 0.2 结果

日期：2026-11-17 · 实施者：DeepSeek Harness 中的 Flash · DSH：0.2.2-rc.3

本轮的最高优先级是**原生右侧栏 Agent 模式**：DSH 会话中央照常聊天，右侧 `sidebar.right.pane.tab` 里呈现远程服务器监控与文件/编辑器。Agent 模式内**没有终端、命令栏、终端标签、第二套 AI 对话**。独立工作台（主面板 `remote-workbench`）保留为次要入口，命令栏与历史只在那边出现。

## 一、Agent 模式（主交付）

### 1. 注册与绑定

`src/client/index.tsx` 通过真实扩展点注册：

- `sidebarRightTabs.register({ id: 'dsh-remote-workbench.agent', kind: 'remote-agent', multiple: false, keepMounted: true, priority: 'extension', title: () => '远程 Agent', guide: [...] })` —— 右侧栏“+ / 引导页”里出现自己的卡片，不占用文件/终端内置类型。
- `slots.inject('sidebar.right.pane.tab')` 以定义 id 为 key 注册面板；**未 inject `sessionId`**，直接使用 slot 原生提供的会话，避免覆盖保留 prop（`inject` 只用于自有的 `openAgent` 回调）。
- `slots.inject('conversation.session.header.actions')` 注册一个 28px 图标，点击 `openTabIn(sessionId, 'remote-agent')`：中央聊天保持不动，真实右栏展开。
- `keepMounted: true` 保证收合右栏、切会话时不销毁已打开文档。
- 所有注册都在 `ctx.effect` 内，热重载/卸载会释放。

Agent 模式只使用当前会话 ID：没有会话选择器、模型选择或聊天输入框。

### 2. 顶部紧凑栏

`主机选择 ▾ · 连接/断开 · 文件 | 监控 · 授权`

- 主机按钮弹出服务器列表（搜索、状态点、当前标记）与“新建连接 / 从 SSH Config 导入 / 编辑当前连接”。
- **空态即可用**：没有服务器时直接给“新建 SSH 连接”，复用 `HostDialog`，首次连接弹出指纹核对，`CREDENTIAL_REQUIRED` 时弹出内存密码输入。不需要先回独立工作台。
- 授权只展示本模式需要的入口：读取默认开启，**写入可选**，永远不发 `exec: true`；已授权时可撤销。监控从不要求 Shell。
- 文件/监控是两个各自保持挂载的面板，切换只改 `data-active`，不卸载组件。

### 3. 文件工作区

- 面包屑导航、上一级、刷新、上传（含拖放）、新建文件、新建文件夹、排序（名称/时间/大小）、隐藏文件、筛选、多选、详情条（路径 / 权限 / 时间）。
- 文件操作：新建、复制、移动/重命名、修改权限（3–4 位八进制）、删除（确认）、下载、上传；目录复制如实提示不可用。
- **多文件标签**：每个标签独立草稿；关闭脏标签、返回列表、切换服务器都会确认（切换服务器会关闭该主机标签）。
- 编辑器按类型分流：
  - 文本/代码：CodeMirror 6，按扩展名选择 JS/TS/JSON/Python/Markdown/HTML/CSS/Shell/YAML/TOML/SQL/Go/Lua/Ruby/Perl/Dockerfile/Nginx/ini/diff 高亮，行号、撤销、`Cmd/Ctrl+S`、`Cmd/Ctrl+F` 查找替换（高亮全部匹配、上一个/下一个、区分大小写、替换/全部替换）。
  - Markdown：源码 / 分屏 / 预览三态；marked + DOMPurify 渲染，脚本、内联样式、表单元素与事件属性被移除；相对图片走当前主机的预览接口，**外部图片需点击“加载外部图片 · host”才发请求**；相对链接在同一个编辑器里打开。
  - PDF：见下节。
  - 图片/音频/视频：同源预览 URL 或对象 URL，原生媒体控件；其他二进制只给类型、大小与下载。
- “交给 Agent”：生成上下文预览（可编辑）、复制或显式发送到当前会话（`/ai/send`）。发送前显示目标会话，不自动发送。

### 4. 监控（六个视图）

综合 / CPU / 显卡 / 内存 / 磁盘 / 网络，全部来自 `GET /resources`：

- 指标：CPU 总/用户/系统/IO 等待/频率/温度/负载/每核心；内存 used/available/cached/buffers/swap；挂载点与磁盘 IO 速率；网卡地址、收发速率、错误；GPU 使用率/显存/温度/功耗/风扇。
- 图表为内联 SVG，`null` 采样点断线而不是画成 0；首次采样显示“采样中”。
- GPU 不可用时显示 `gpuMessage`，不画假的 0%。
- 采样间隔 3/5/10/30 秒或暂停；`document.visibilityState` 隐藏、Agent 模式切到文件、右栏标签不可见（`tabInfo.visible=false`）、断开连接时停止轮询；错误显示原因并可重试。
- “交给 AI”把当前采样摘要放进与文件相同的“交给当前 Agent”预览。

### 5. 主题与原生观感

- 面板根节点复用 `rw-workbench` 主题域，因此全部 DSH token（`--dsw-alias-*`、`--dsw-radius-*`、`--dsw-elevation-*`、`--dsh-*-font-size`…）与独立工作台一致；明暗随 `body[data-ds-dark-theme]`，在真实 DSH 深色下已截图。
- 右栏 300px 起可用：容器查询在 460px/720px 加宽信息密度；文件列表与编辑器在窄栏内切换，宽栏并排。
- 启动按钮、弹层、菜单、输入、按钮、滚动条都是原生几何（28px 图标按钮、0.5px 描边、`radius-sm/md`、毛玻璃菜单）。

## 一·补、本轮界面调整（2026-11-17 下午）

- **独立工作台不再有 AI 协作**：删除 AI 栏、AI 开关、上下文/会话选择/发送与相关状态；工作台现在是「文件 + 终端（含命令栏）+ 任务栏」，打开文件不再在工作台内嵌编辑器。
- **文件在原生右侧栏打开**：双击文件（或右键“在右侧栏打开”、选中后按钮）先回到当前会话，再调用 `sidebarRight.openTab('remote-agent', { params: { hostId, path } })`（右侧栏需要已挂载的会话，因此有重试）；Agent 面板从 `tabInfo().tab.navigation.params` 读取并打开该文件，`navigation.revision` 作为重复打开同一文件的触发器。开发预览用右侧抽屉模拟同一流程（`?agent=1` 直接挂载组件）。
- **新建连接不再提供 SSH Agent**：认证方式只有「私钥文件 / 密码」；已有 `auth: "agent"` 的旧连接保留「SSH Agent（旧配置）」选项并提示改用私钥或密码，避免静默改动现有配置。

## 一·补二、凭据持久化与 Agent 连接（2026-11-17 下午）

- **凭据只存一次**：`setCredentials` 同时写入内存与 DSH 凭据记录（`remote-workbench/<hostId>`，`kind: "ssh-credentials"`），`connect` 在内存缺失时自动从记录恢复；断开只清内存，不删记录。新增 `POST /credentials/forget`，编辑连接对话框提供「忘记已保存凭据」，删除连接会一并删除记录。凭据值不会写入插件 `state.json`，也不会出现在工具参数或返回值里。
- **`rw_connect` 工具**：要求当前 DSH 会话对该主机已有读授权且 revision 一致；使用已保存凭据重连，密码认证缺少记录时明确要求先在 UI 连接一次。新增的连接授权可在未连接时创建（`Permissions.set` 在无 SFTP 时先保存绝对路径，首次授权操作时再规范化根目录），因此安装后 Agent 可以在用户授权的范围内自行建立连接。
- **Agent 授权对话框**新增「工具级 Shell 执行」选项（仍不渲染终端/命令栏），使 `rw_exec` 在新 UI 下仍有可控授权入口；默认关闭。

## 二、PDF（生产环境重点）

- **Worker 隔离**：`import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'` → Blob URL → `GlobalWorkerOptions.workerSrc`。不再 side-effect import worker 模块，因此不会污染宿主 `globalThis.pdfjsWorker`，解析也不阻塞对话（集成断言已覆盖）。
- **字体/图像**：`cMapUrl`、`standardFontDataUrl`、`wasmUrl`、`iccUrl` 指向宿主 `GET /api/remote-workbench/assets/pdfjs/...`；桌面非 http 环境优先用 `__DSH_TRANSPORT__.streamBaseUrl` 的 loopback 地址，无 CDN、无网络字体。
- **默认适应宽度**：缩放选单第一项“适应宽度”，用 ResizeObserver 跟随右栏宽度；旋转 90° 后整页仍在可视宽度内。手动选择 75–200% 后切回固定比例。
- **渲染取消不再是错误**：新的渲染会 `cancel()` 旧任务；`RenderingCancelledException`（含 cancelled 文案）被忽略，只有真正的失败才进入红色错误行；成功绘制会清掉旧的渲染错误。保存后等待新页面绘制完成，截图无 “Rendering cancelled”。
- **表单**：使用 pdf-lib 导出类的 `instanceof`（`PDFTextField`/`PDFCheckBox`/`PDFRadioGroup`/`PDFDropdown`/`PDFOptionList`）识别，minify 后仍有效；文本框、复选、单选、下拉、多选列表可编辑，保存时写回。
- **批注/旋转/表单都是草稿**：状态存放在文件标签上（`PdfDraft`），切标签、切模式、回列表、收右栏都不丢；保存成功后才清空。
- **保存**：`POST /file/save-binary` 带原始 etag + hostRevision，`FILE_CONFLICT` 保留本地修改并提示，原子保存；中文批注在本地 Canvas 栅格成 PNG 嵌入，不依赖网络字体。

## 三、连接版本保护（review 11）

- **不再读取最新 revision**：删除了 `currentRevision()`。旧实现会在操作前刷新 revision，等于把旧操作静默授权到新连接上。
- 打开新建/复制/移动/权限/删除弹窗时捕获 `{ hostId, hostRevision }`；提交只用这个原始版本。**六种写操作**（`/files/create`、`mkdir`、`copy`、`rename`、`chmod`、`remove`）的请求体都带捕获的 `hostId` 与 `hostRevision`，不再用当前 `host.id`。`CONNECTION_CHANGED` 时保留草稿、选择与对话框，提示“请刷新目录重新确认”，**不重试**。
- 目录列表、`/file/info`、`/file`、`/file/preview`、上传都带原始 `hostRevision` 并核对响应（列表响应带 `hostRevision`）；不匹配就拒绝并保留已打开文档。
- 下载与 Markdown 相对图片预览也带打开文件时的 `hostRevision`（`downloadUrl` / `previewUrl` 的可选参数），预览请求与文件版本绑定。
- 文本保存仍用 etag + hostRevision，PDF 保存仍用 etag + hostRevision；连接变更不会自动重置含未保存文件的组件（标签 key 用 host.id，不用 revision）。

## 四、Markdown 与文件安全

- HTML/SVG 只作为源码编辑，不执行；预览经过 DOMPurify，禁止 `script/style/iframe/form/object/embed` 与事件属性。
- 外部图片点击加载；相对图片走当前 SSH 主机预览接口。
- 未知类型、超限文件、二进制都会给出真实原因（`reason`），不假装可编辑。

## 五、独立工作台（次要）

- 保留 0.1 的顶部主机切换、文件 + 终端 + 编辑器 + AI、任务栏与通信流程，仍注册在 DSH 主面板。
- **命令栏与命令库只在独立工作台**：终端上方新增命令栏（历史 / 片段 / 命令库 / 发送）；终端本身不拦截原生 Tab 与 ↑ 历史，命令栏只在自己的输入框内处理按键；发送前检查 `writable && OPEN`，只在用户按 Enter/发送时写入 PTY。
- 历史按主机保存，可搜索、删除、清空、暂停；片段可新建/编辑/删除、区分主机/全局；点击历史或片段只填入命令栏、不执行。
- 发送与记录保留原始前导空格（前导空格的敏感命令由宿主决定不入库），输入补全保留尾部空格，`cd ` 路径补全可用。
- 终端颜色与字号从宿主 token 读取，切换主题/字号自动重取色。

## 六、实际用到的 API

`GET /snapshot`、`GET /files?hostRevision`、`GET /file/info?hostRevision`、`GET /file?hostRevision`、`GET /file/preview?hostRevision`、`POST /file/save`、`POST /file/save-binary`、`POST /files/create|copy|chmod|rename|mkdir|remove`、`POST /upload?hostRevision`、`GET /download`、`GET /resources`、`GET /commands`、`GET /commands/suggest`、`POST /commands/remember|preferences|clear|delete|snippets/save|snippets/delete`、`POST /connect|disconnect|credentials|credentials/forget|trust`、`POST /hosts/save|delete`、`POST /ssh/import`、`POST /ai/grant|revoke|send`。

## 七、改动文件

| 文件 | 说明 |
| --- | --- |
| `src/client/index.tsx` | 右侧栏 tab 类型、body、title、会话头部启动按钮；主面板注册保留 |
| `src/client/AgentPanel.tsx` | Agent 模式外壳：主机/连接/授权、空态新建连接、交给 Agent、模式切换、主机切换确认 |
| `src/client/AgentFiles.tsx` | 文件浏览、多标签、Markdown/代码/PDF/媒体、文件操作、连接版本保护 |
| `src/client/MonitorView.tsx` | 六视图监控、轮询控制、图表、AI 摘要 |
| `src/client/editors/CodeEditor.tsx` | CodeMirror 6 + 语法高亮 + 查找替换 |
| `src/client/editors/MarkdownPreview.tsx` | 安全 Markdown、相对图片、外部图片点击加载 |
| `src/client/editors/PdfViewer.tsx` | 隔离 worker、适应宽度、取消处理、表单/批注/旋转、保存 |
| `src/client/editors/MediaPreview.tsx` | 图片/音频/视频/二进制 |
| `src/client/Commands.tsx` | 命令栏与命令库（仅独立工作台） |
| `src/client/TerminalView.tsx` | 可控发送 `send()`、状态回调、主题跟随 |
| `src/client/App.tsx` | 独立工作台接入命令栏/命令库与终端状态 |
| `src/client/api.ts` | 0.2 API 客户端、二进制读写、资源/命令查询、上传带 revision |
| `src/client/style.css` | Agent/监控/编辑器/PDF/命令栏样式（全部 DSH token） |
| `src/client/standalone.tsx` | 开发预览 `?agent=1` 挂载真实 Agent 组件 |
| `tests/ui/agent.spec.ts` | 6 项 Agent 模式 UI 测试 |
| `tests/ui/workbench.spec.ts` | 新增命令栏发送/历史/敏感命令测试（共 6 项） |

未修改：`src/host/**`、`src/shared/**`、`src/index.ts`、`scripts/**`、`package.json`。

## 八、验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | **37/37**（含 backend 0.2 路由、资源采样、命令库、凭据记录持久化与连接前授权） |
| `npm run build` | 通过（closure-factory 客户端 + host） |
| `npm run test:ui` | **12/12**（在全新夹具上运行；测试结束会关闭自己创建的终端，避免夹具 `MaxSessions` 被上一轮残留占满）：Agent 无终端/命令栏/聊天、六视图、草稿跨模式与标签、PDF 表单保存与重新打开、Markdown 分屏、文件新建/目录/权限/复制/重命名/删除并断言六种写操作都带 `hostId`+`hostRevision`、空态新建连接；独立工作台无 AI 界面、文件从工作台在右侧栏（预览抽屉）打开并保存、主题、响应式、命令栏单次发送 + 历史回填 |
| `npm run test:dsh`（隔离 profile，真实 DSH 0.2.2-rc.3） | **24 项通过**，包含：原生右侧栏引导页打开 Agent 面板、工作台文件改为在会话旁的原生右栏打开、`rw_connect` 在授权后可用、原生右栏内无终端 UI、六个监控视图、Markdown 草稿跨模式与 SFTP 保存、生产包 PDF worker 绘制且不污染宿主全局、PDF 表单与旋转从右栏保存到真实 SFTP、无浏览器运行时报错 |

真实 DSH 截图（本轮由集成脚本更新）：`docs/dsh-agent-rightbar-preview.png`、`docs/dsh-agent-rightbar-dark-preview.png`、`docs/dsh-agent-pdf-preview.png`（保存 + 旋转后，无 “Rendering cancelled”）、`docs/dsh-agent-monitor-preview.png`。

## 九、未完成 / 已知限制

1. **桌面窗口未做真机观感验收**：只做了 Web 渲染层的真实 DSH 集成；macOS vibrancy、`dsh-app://` 下 PDF worker 取字体资产的极端情况以 `streamBaseUrl` 兜底，未在桌面实机验证。
2. **左栏文件/终端仍是 DSH 原生实现**：Agent 模式不做终端；终端能力只在独立工作台。
3. **PDF**：不支持 OCR/文字提取、数字签名、嵌入字体替换；中文批注是栅格图像（不是可选文本），大文件逐页渲染首次打开会有一两秒解析。
4. **监控**：macOS 只暴露宿主可读指标（无逐核心、无 GPU、磁盘 IO 可能缺失），界面按真实缺项显示 `—` 与 warnings；Linux 的 GPU 依赖 `nvidia-smi`。
5. **命令栏**：不做自动执行、不做 PTY 全量按键捕获；历史仅用户主动发送的命令；独立工作台之外的窗口不共享命令栏。
6. **Markdown**：外部图片需点击加载（有意为之），不支持远程文档内嵌 HTML 执行。
7. **未做真机桌面验收**：安装与桌面验收仍由 Codex 收尾（本会话未安装插件、未重启 DSH）。
8. **凭据持久化依赖 DSH 凭据服务**：默认 DSH 组合包含本地凭据存储；若某个自定义组合没有 `credentials` 服务，插件会退化为仅内存保存（不会报错），此时重启 Host 仍需重输。


## 十、Codex 最终安装与桌面验收补充

Flash 交付之后，最终发行包在隔离 profile 中通过 22 项真实 DSH 集成检查，新增连接变更后拒绝旧移动操作的回归。已安装到日常 desktop profile 并重开 DSH；原生 dsh-app 桌面中的资源监控、Markdown 保存、PDF 绘制及表单/旋转保存均通过。临时服务器和信任信息已清理，原有配置状态恢复。上述第九节关于“未做桌面验收”的记录仅描述 Flash 交付时的状态，现已完成；详见 [RELEASE-0.2.0.md](RELEASE-0.2.0.md) 与 [desktop-verification.json](desktop-verification.json)。
