# Recapsy macOS 采集进程

本目录是 Recapsy 桌面端的 macOS 屏幕采集进程(ADR 0009 的落地代码)。采集进程是一个**独立签名的 `.app` bundle**,由 Electron 主进程经一个 native disclaim 启动器 spawn,拥有自己稳定的 TCC 身份(bundle id `one.recapsy.desktop.capture`),按自身签名身份向系统申请屏幕录制授权。

## 组成

SwiftPM 包(`Package.swift`,macOS 14+ target):

| 目标 | 类型 | 职责 |
| --- | --- | --- |
| `CaptureCore` | Swift library | 纯逻辑:相对键生成、资产落盘路径拼接、活跃窗口选择规则、NDJSON envelope 编码、SHA-256 内容哈希、capture id 生成。全部有单测,且完全不依赖 libwebp / ScreenCaptureKit。 |
| `CWebP` | system library shim | 把 libwebp 的 C 编码 API(`webp/encode.h`)以 `CWebP` 模块暴露给 Swift。头/库路径**不写死**,由 `build-libwebp-static.sh` 构建的固定源码产物传入。 |
| `RecapsyCapture` | Swift executable | 采集体:按 `CGWindowList` 前后序取顶层可截窗口（不信任 `NSWorkspace.frontmostApplication`，避免 Electron 等宿主谎报前台）→ `SCShareableContent` 校验 ownership → `SCContentFilter(desktopIndependentWindow:)` 只截该窗口 → CGImage 转 RGBA → libwebp `WebPEncodeRGBA` 有损编码(压后约 100–800KB)→ 写资产根 → NDJSON stdio 主循环。组装进 bundle 时按 `product-identity.json` 重命名为 `Recapsy Preview Capture`（隐私面板显示名，ADR 约束③）。 |
| `CaptureLauncher` | C executable | 极小 disclaim supervisor：`posix_spawn` + `responsibility_spawnattrs_setdisclaim`，转发 `SIGTERM` / `SIGINT`，严格 `waitpid` 并镜像采集体退出码；Electron 超时强退时终止 launcher 与采集体共享的专用进程组。 |

前台无可截窗口时(如 Finder 桌面、无窗口应用),采集体**静默跳过本次 tick**:不发 `capture.result`、不发 `capture.error`(仅 stderr 记一行),下个 interval 再试。

## 构建依赖与兼容性

常规开发命令按当前宿主原生构建 helper，最低系统版本为 macOS 14 Sonoma。`RECAPSY_CAPTURE_ARCH` 只接受 `arm64` 或 `x86_64`，且必须与构建宿主一致，避免把未验证的交叉编译伪装成可发行产物。外部发行 workflow 会在 arm64 与 x64 runner 分别构建并签名，然后合并为 universal `.app`；本地 arm64 gate 仍只证明 Apple Silicon 路径。

采集体用 libwebp 编码 WebP。构建需要 Xcode Command Line Tools、系统 `curl` 及 CMake；CMake 可通过以下命令安装：

```bash
brew install cmake
```

首次构建会从 WebP 官方 HTTPS 源下载固定的 `libwebp 1.6.0` 源码，校验 SHA-256 `e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564`，并以所选原生架构、`MACOSX_DEPLOYMENT_TARGET=14.0` 编译静态 `libwebp.a` 与 `libsharpyuv.a`。构建器会逐个检查归档内 Mach-O 对象的最低版本与架构，失败即中止。源码、CMake 中间产物和归档都位于 gitignored 的 `macos/build/third-party/`；`macos/build/libwebp-<arch>.json` 是可追溯 provenance。

采集 helper 静态链接这两个归档，因此运行时不依赖 libwebp dylib（`otool -L` 无 libwebp 条目）。libwebp 的 BSD 许可证会随 bundle 安装在 `Contents/Resources/ThirdPartyNotices/libwebp.txt`。

## 构建与签名

```bash
# 在 apps/desktop 下
pnpm run build:capture
```

该脚本先构建并验证上述 arm64/macOS 14 libwebp 归档，再以对应 include / 静态归档 flag 执行 `swift build -c release`，组装并**用 `Recapsy Developer` 自签名证书**签整个 bundle。产物落在 gitignored 的 `apps/desktop/macos/build/Recapsy Preview Capture.app`（绝不落系统临时目录 —— macOS 拒绝为 `/tmp` 下的 bundle 持久化授权，ADR 0009 约束①）。签名身份可用环境变量 `RECAPSY_CAPTURE_SIGN_IDENTITY` 覆盖。

产物路径:

- 启动器：`build/Recapsy Preview Capture.app/Contents/MacOS/CaptureLauncher`
- 采集体：`build/Recapsy Preview Capture.app/Contents/MacOS/Recapsy Preview Capture`

复验签名:

```bash
codesign -dv --verbose=4 "macos/build/Recapsy Preview Capture.app"
# 应看到 Identifier=one.recapsy.desktop.capture、Authority=Recapsy Developer
```

## Electron `.app` 装配

在 `apps/desktop` 下运行：

```bash
pnpm run package:macos
```

命令先构建真实 capture bundle 与 Electron main / preload，再由
`@electron/packager` 生成宿主机架构的
`dist/release/Recapsy Preview-darwin-<arch>/Recapsy Preview.app`。应用代码来自最小 staging，
`app.asar` 只包含 `dist/main/electron-entry.js`、login preload / HTML、shell
main preload / HTML 和最小 manifest；源码、tests、SwiftPM `.build` 与 package
`node_modules` 不会进入产物。
采集 bundle 位于标准 nested-code 路径
`Recapsy Preview.app/Contents/Frameworks/Recapsy Preview Capture.app`，`Contents/Resources` 不保留
重复副本。

签名渠道分为三种。未设置 `RECAPSY_CAPTURE_SIGN_IDENTITY` 时是本机开发渠道：
Electron 外壳和 helpers 使用 ad-hoc 签名，capture bundle 恢复为稳定的
`Recapsy Developer` 身份，outer app 最后重新 seal 并执行完整验证；本机必须已有
可用的该证书。显式设置为 `-` 时，outer 与 nested 全部使用 ad-hoc 签名，仅用于
CI 的布局、进程和 seal 门禁，不提供跨 rebuild 的 TCC 身份稳定性。显式设置为
Developer ID 时，Packager 使用同一发行身份 inside-out 签完整应用；Developer ID
凭据、notarization 和正式分发仍由后续独立发行任务完成。

`package:macos` 仍只生成 host-native 架构；正式 universal/DMG/notarization/rollback 链路由 `release:stage`、`release:assemble`、`release:notarize`、`release:verify` 和 `release:verify-rollback` 组成，并由仅手动触发的 `.github/workflows/external-macos-release.yml` 编排。该 workflow 要求 Developer ID、App Store Connect API key 与已有 GitHub Release rollback DMG；没有这些外部输入时，自动化只验证 fail-closed contract，绝不把 ad-hoc GREEN 宣称为 Developer ID、Gatekeeper 或正式发行完成。

## 自动化测试(不依赖屏幕录制授权)

```bash
# 完整 macOS 门禁：先运行不下载也不链接 libwebp 的纯 Swift CaptureCore 测试，
# 再构建真实 helper、封装 Electron 应用并检查最终布局。
pnpm run test:macos

# 只构建 arm64 helper，并验证固定源码、静态 archive 与签名。
pnpm run build:capture

# 真实 spawn 已签名 bundle(经 disclaim 启动器)+ 协议握手
pnpm run test:capture-bundle-process
```

`test:capture-bundle-process` 会读取 `macos/build/libwebp-arm64.json`，确认两个静态 archive 都是 arm64、每个对象的最低 macOS 版本均为 14.0，并在真实签名 helper 上执行协议、策略 ACK、恢复和进程监督测试。`pnpm run test:macos` 进一步封装 Electron 应用并验证 nested code、签名与最终目录布局。

`test:capture-bundle-process` 接受三种诚实结果:授权且有活跃窗口 → `capture.result`(WebP 资产);无授权 → `capture.error`;前台无可截窗口 → 无 capture 信封(采集体静默跳过),此时断言心跳仍在推进以证明主循环存活未挂死。

集成测试断言:经启动器真实 spawn → 收到真实 `helper.hello`(`capabilities.mock === false`,即这是真采集体而非 dev 占位)、上报权限状态、`capture.start` 后跑出协议合法的 capture 信封、`stop()` 后启动器与采集体干净退出无僵尸。

## 手动 E2E 清单(真实 WebP → server,需人工授权)

新 bundle id `one.recapsy.desktop.capture` 是**全新 TCC 身份**,屏幕录制授权只能由你在系统设置手动完成,自动化无法代点。按下列步骤验证整条链路从 `blocked` 走到 `synced`:

1. **构建 bundle**

   ```bash
   cd apps/desktop && pnpm run build:capture
   ```

2. **启动 Electron**。开发环境默认解析并校验上一步构建出的真实 bundle，
   不需要手工设置启动命令。只有明确调试自定义进程时才设置以下覆盖项：

   ```bash
   export RECAPSY_DESKTOP_HELPER_COMMAND="$PWD/macos/build/Recapsy Preview Capture.app/Contents/MacOS/CaptureLauncher"
   export RECAPSY_DESKTOP_HELPER_ARGS="$PWD/macos/build/Recapsy Preview Capture.app/Contents/MacOS/Recapsy Preview Capture"
   ```

   `RECAPSY_DESKTOP_HELPER_ARGS` 是单个 argv 值，因此路径可以包含空格。该覆盖只在
   未打包开发环境生效，正式 `.app` 会拒绝覆盖。资产根经
   `RECAPSY_CAPTURE_ASSET_ROOT` env 传递（Electron 从 `userData/captures` 派生）。

3. **启动桌面 app 并登录**(触发 sync loop)。

4. **首次采集触发系统授权弹框**,或手动到:

   系统设置 → 隐私与安全性 → **屏幕录制** → 确认存在一条名为 **`Recapsy`** 的条目并**勾选启用**。

   > 关键复验：过渡期显示名必须是 `Recapsy Preview Capture`（取自同名可执行文件与 `CFBundleName`，不是只靠 `CFBundleDisplayName`，ADR 约束③）。若显示成别的名字，说明可执行名或 bundle 装配错了。

5. **辅助功能**:Tray / 主窗口可打开「辅助功能」设置面板。采集体通过 `AXIsProcessTrusted()` 探测并上报 `granted` / `not_determined`;用户须手动 `+` 添加并启用 **Recapsy**(ADR 约束②)。辅助功能不影响截图,但缺少时 context metadata 无法采样。

6. **观察闭环**:授权后采集体截取当前活跃窗口、产出真实 WebP 写入 `userData/captures/<captureId>/screenshot.webp`,`capture.result` 的 `asset.ref` 为相对键 `<captureId>/screenshot.webp`、`asset.mimeType` 为 `image/webp`;主进程按同一资产根读回字节,sync job 从 `blocked` 转为 `synced`。

7. (可选)彻底清理残留 TCC 条目:

   ```bash
   tccutil reset ScreenCapture one.recapsy.desktop.capture
   ```

### 关于 disclaim 身份的诚实边界

ADR 0009 的 spike 已在 macOS 15 实测确认 disclaim 生效(责任进程翻转为采集进程自身、授权按其 bundle 身份归属)。本启动器使用同一私有 API(`responsibility_spawnattrs_setdisclaim`),`swift build` / 运行时均无报错(setdisclaim 返回 0)。但在**当前开发机的调用链已持有屏幕录制授权**的前提下,`CGPreflightScreenCaptureAccess()` 对「disclaim 后按自身身份」与「未 disclaim 借用祖先授权」两种情况都返回 `granted`,单凭权限探测**无法就地区分**。要确证授权是绑定到新 bundle 身份 `one.recapsy.desktop.capture`(而非借用父链),须以上面第 4 步「屏幕录制面板出现名为 Recapsy Preview Capture 的条目」为准。
