# 0.2 工作台接口合同

Codex 负责 `src/host/**`、`src/shared/**`、`src/index.ts`、打包与依赖，以及后端测试。DSH Flash 负责所有 UI/UX 和客户端实现，可改 `src/client/**` 及 `tests/ui/**`。不要交叉改对方文件。现有 API 保持兼容。新增类型见 `src/shared/workstation.ts`，这里的 API 由 Codex 实现，Flash 可以立即按合同开发。

公共前缀 `/api/remote-workbench`；已有 `api.get/post` 仍可用，写入需 `x-rw-csrf`。所有异步结果绑定 hostId + hostRevision；客户端切主机/关文件后忽略晚到结果。错误是已有 `{code,message,details}`。

## 资源监控

`GET /resources?hostId=<uuid>` → `ResourceResponse`。Linux 无 Agent、无 sudo，读取 /proc、sysfs、df、ip 和 nvidia-smi（如已安装）；macOS 提供可读取的基础指标，缺项会有 warnings。主机必须已经连接，断开时返回 `NOT_CONNECTED`。按 host + revision 合并并发请求，2 秒缓存，保留最近 120 个采样点；前端默认每 3 秒请求一次，可选 3/5/10/30 秒与暂停。页面不可见、切到其他工作模式、断开时停止轮询。CPU/网速首个点为 null，显示“采样中”，不可当 0。GPU 缺失/驱动不支持显示 gpuMessage，不画假的 0%。只显示真实后端数据。

## 文件

`GET /file/info?hostId&path` → `RemoteFileInfo`：按类型分流，不再把 PDF 等二进制送进文本编辑器。

- `GET /file?hostId&path` → 原有 `RemoteFile`，文本上限提高为 1 MiB，UTF-8 严格检测；`POST /file/save` 仍按原合同。
- `GET /file/preview?hostId&path` → 二进制 body，`content-type`，`etag` 为带双引号 SHA256，`x-rw-host-revision`。预览上限 25 MiB。用 fetch 取得 ArrayBuffer / Blob，检查 response.ok，保存原始 etag（移除双引号）与 revision。建议在 api.ts 增加 readBinary helper。
- PDF：用 pdfjs-dist 显示分页、缩放；用 pdf-lib 支持旋转页面、文字批注、已有表单填写，保存后重新加载预览。明确这是 PDF 批注/表单编辑，不是排版软件。中文批注可用 Canvas 栅格文字嵌入 PDF，不依赖网络字体。可按页面点击位置插文字，别只做下载按钮。
- PDF 保存：`POST /file/save-binary?hostId&path&etag&hostRevision`，body 为 Uint8Array/Blob（application/pdf）、header x-rw-csrf。→ `{path,etag,size,hostRevision}`；冲突返回 FILE_CONFLICT，保留本地修改。只接受 PDF，25 MiB 以内，原子保存并保留权限。
- Markdown：源码编辑/预览/分屏，marked + DOMPurify；关闭 HTML 执行，链接和图片不得执行脚本，远端相对图片从同主机预览 API 读取。不加载 CDN。
- 代码/配置/普通文本：建议 CodeMirror 6，语法高亮、查找替换、行号、撤销、Cmd/Ctrl+S。多文件标签保留独立草稿，关标签/换主机有未保存确认。
- PNG/JPEG/GIF/WebP/AVIF 图片可预览，音视频用原生媒体控件，其他二进制显示信息+下载；HTML/SVG 按源码编辑，不作为活动页面执行。
- `POST /files/create` `{hostId,path,content?:string,hostRevision:number}`，新建文本，默认空内容，存在拒绝覆盖。
- `POST /files/copy` `{hostId,path,target,hostRevision:number}`，流式复制普通文件，存在拒绝覆盖。目录暂不递归复制，UI 如实提示。
- `POST /files/chmod` `{hostId,path,mode:string,hostRevision:number}`，mode 为 3 或 4 位八进制。
- 原有 rename/mkdir/remove/upload/download 保留。移动用 rename；可加复制/剪切/粘贴、面包屑、排序、快捷键、选中文件详情，所有危险操作保留确认。没有实现的操作不展示可用按钮。

## 命令记忆与补全

`GET /commands?hostId&q=<可选搜索>` → `CommandLibrary`，主机级历史 + 当前主机/全局片段 + remember 开关。历史持久化并去重计数，上限每主机 500 条，总计 2000 条。密码/token 等明显敏感命令和前导空格命令不入库。

`GET /commands/suggest?hostId&cwd&input` → `{items: CommandSuggestion[]}`，历史、片段、常用 Unix 命令、远端 SFTP 路径补全。建议防抖 150–250ms，忽略过期结果；↑↓选择、Tab 填入、Esc 关闭，选择建议只填入不自动执行。

`POST /commands/remember` `{hostId,command,cwd}` → `{remembered:boolean}`；只在用户主动发送命令后记录命令栏中的文本。不要捕捉 PTY 每次按键，不记录密码提示输入。原始终端仍保留远端 Shell 原生 Tab 和↑历史。

`POST /commands/preferences` `{hostId,remember:boolean}`；`POST /commands/clear` `{hostId}`；`POST /commands/delete` `{hostId,id}`。

`POST /commands/snippets/save` `{id?:uuid,hostId?:uuid,name,command,group?:string}` → `CommandSnippet`，hostId 省略为全局；`POST /commands/snippets/delete` `{id}`。

终端“命令栏”可有输入/补全/历史/片段入口。用户点击发送/Enter 才通过当前终端 WS 发送输入；需要 writable + OPEN，不能向别的主机/终端发。不把换行加入补全值。可以在 TerminalView 增加可控发送和 onReady 回调，或把命令栏放在 TerminalView 内。直接键入终端的 Tab/方向键不被客户端拦截。记忆的命令只标“已发送”，未取得 shell 退出码就不标执行成功。

## 打包依赖

Codex 统一安装依赖：pdfjs-dist、pdf-lib、marked、dompurify、CodeMirror 6（state/view/commands/language/lang-javascript/lang-json/lang-python/lang-markdown/lang-html/lang-css/legacy-modes）。都作为 devDependencies 内联进发行包。PDF worker 可 `import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'` 然后 Blob URL，Codex 会为现有 esbuild 加 `?raw` 支持（Vite 原生支持）。资源与文档图标用现有 lucide，不引入网络资源。
