# 0.1.1：修复 DSH 热重载路由残留

验证日期：2026-11-17。宿主：macOS，DSH 0.2.2-rc.3。

## 问题与修复

0.1.0 没有把 `webServer.register()` 和 `registerUpgrade()` 返回的清理函数交给 Cordis 管理。组件停用、升级或部分启动失败后，HTTP / WebSocket 路由仍被旧实例占用，下一次加载报 `webserver: duplicate prefix route "/api/remote-workbench"`。

0.1.1 在 `src/index.ts` 中使用 `ctx.effect()` 注册两类路由，并提前绑定引擎和 WebSocket 的销毁行为，使完整卸载和失败回滚都能释放资源。客户端产物与 Flash 完成的版本字节一致，保留顶部导航和 DSH 原生主题。

旧版已残留在内存中的路由需要完全退出 DSH 一次才能清除。本次已更新用户的 desktop profile 并重开 DSH。

## 验证结果

- `npm run typecheck` 通过。
- `npm test` 20/20 通过。新增两个生命周期回归测试在修复前均失败，修复后通过；覆盖连续三次加载/卸载，以及终端路由冲突导致部分启动失败后的清理与恢复。使用真实 Cordis、WebServer、Store 和 Engine，仅替代这些场景不使用的 AI / 工具服务。
- 从 `releases/dsh-remote-workbench-0.1.1.tgz` 安装至隔离 profile，`npm run test:dsh` 15 项通过，包括真实 SSH / PTY、SFTP 编辑、权限、六个工具、会话交接和暗色主题。详见 `docs/dsh-verification.json`。
- 日常 desktop profile 中实测：0.1.1 组件显示“运行中”；工作台、新建连接弹窗正常；组件停用后重新启用成功，再打开工作台仍正常。
- 安装前备份清单、锁文件和配置；安装后核对其他依赖、bundle 顺序、配置与持久化工作台数据未变。源码构建、安装包和已安装插件的两个 JS 文件逐字节一致。

未连接用户真实服务器，也未发送模型请求。真实传输与工具调用通过隔离的本机 OpenSSH 夹具验证；完整 DSH 工具审批流水线不在该集成探针的覆盖范围内。

## 发行包

- `releases/dsh-remote-workbench-0.1.1.tgz`，977,555 字节。
- SHA-256：`f03034fd655da6e2aad56e7129b58915585b4aa3f254bb6c6e789c7044780a66`。
- 独立源码快照：`releases/dsh-remote-workbench-0.1.1-source.zip`。
- 所有保留发行包的校验值：`releases/SHA256SUMS`。
