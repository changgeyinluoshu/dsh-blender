# Changelog

本文件记录 dsh-blender-studio 的所有重要变更。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 0.1.0

首个可用版本。

### DSH 侧（`lib/`）

- 20 个 `blender_*` 工具：状态与清单、基础几何体、选择与变换、复制阵列、对象运算、网格编辑、修改器、布尔、材质、渲染预览、视口截图、导入导出、文件与历史、任意 Python、安装与诊断；
- **零 npm 依赖**：自带 `defineTool` 等价实现与参数 schema 编译器，`git clone` 后无需 `pnpm install`；
- 传输层：TCP + NDJSON，一请求一连接，错误分类（离线 / 超时 / 中止 / 协议 / 远端）并附可操作提示；
- 渲染与导出产物自动落到 `<工作区>/blender-outputs`，同名文件自动编号不覆盖；
- `blender_render_view` 在场景无灯时自动补一盏临时太阳光（渲染后移除），避免全黑预览。

### Blender 侧（`addon/dsh_blender_bridge/`）

- 纯标准库实现的 socket 桥（`dsh_server.py`），29 个命令（`dsh_ops_*.py`）；
- 线程模型：socket 线程只收发与入队，bpy 调用全部在 Blender 主线程（GUI 用 `bpy.app.timers` 泵，headless 用同步循环），天然串行无需加锁；
- GUI：`bl_info` + 偏好设置（端口 / token / 自动启动）+ 3D 视图侧栏 DSH 面板；
- headless：`dsh_headless.py` 支持 `--port / --token / --once / --open / --ready-file`；
- Blender 4.2+ 扩展清单 `blender_manifest.toml`，同时兼容 3.6+ 的旧式 add-on 安装。

### 安装与发布

- `install.ps1` / `install.sh`：幂等安装（node_modules 链接 + `cordis.patch.yml` 托管块 + Blender add-on 复制），改前自动备份；
- `uninstall.ps1` / `uninstall.sh`：可逆卸载；目录联接只删链接、不碰仓库内容；
- `addon/install-addon.ps1` / `.sh`：跨平台定位 Blender 与用户插件目录；
- `scripts/pack-addon.mjs`：无依赖 ZIP 打包（`npm run pack:addon`），供 Blender 的 Install from Disk 使用；
- 包内 `cordis.patch.yml` 声明 `dsh.bundle.patch`，支持 `dsh plugin add` 一键接线。

### 验证

- `npm test`：11 项离线单测（协议、错误分类、超时/中止、工具层参数传递与产物命名）；
- `npm run verify:load`：在真实 cordis 上下文里执行 `apply`，并用 DSH 官方 `assertSupportedJsonSchema` 校验全部工具的 schema；
- `npm run test:addon`：打包 → 解压 → 真实 Blender 启用/停用插件（19 项检查）；
- `npm run test:blender`：真实 Blender 5.2.2 后台进程端到端建模（建桌子、布尔、倒角、材质、导出 GLB/STL、相机取景渲染 PNG，20 项检查）；
- `npm run check`：全部 JS 语法检查 + Blender 侧 Python 编译检查。
