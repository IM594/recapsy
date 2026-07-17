# Recapsy macOS 采集进程

本目录是 Recapsy 桌面端的 macOS 屏幕采集进程(ADR 0009 的落地代码)。采集进程是一个**独立签名的 `.app` bundle**,由 Electron 主进程经一个 native disclaim 启动器 spawn,拥有自己稳定的 TCC 身份(bundle id `one.recapsy.desktop.capture`),按自身签名身份向系统申请屏幕录制授权。

## 组成

SwiftPM 包(`Package.swift`,macOS 14+ target):

| 目标 | 类型 | 职责 |
| --- | --- | --- |
| `CaptureCore` | Swift library | 纯逻辑:相对键生成、资产落盘路径拼接、活跃窗口选择规则、NDJSON envelope 编码、SHA-256 内容哈希、capture id 生成。全部有单测,且完全不依赖 libwebp / ScreenCaptureKit。 |
| `CWebP` | system library shim | 把 libwebp 的 C 编码 API(`webp/encode.h`)以 `CWebP` 模块暴露给 Swift。头/库路径**不写死**,由 `build-capture-bundle.sh` 经 `brew --prefix webp` 动态传入。 |
| `RecapsyCapture` | Swift executable | 采集体:取前台 app → `SCShareableContent` 选主窗口 → `SCContentFilter(desktopIndependentWindow:)` 只截该活跃窗口 → CGImage 转 RGBA → libwebp `WebPEncodeRGBA` 有损编码(压后约 100–800KB)→ 写资产根 → NDJSON stdio 主循环。组装进 bundle 时**重命名为 `Recapsy`**(隐私面板显示名,ADR 约束③)。 |
| `CaptureLauncher` | C executable | 极小 disclaim supervisor：`posix_spawn` + `responsibility_spawnattrs_setdisclaim`，转发 `SIGTERM` / `SIGINT`，严格 `waitpid` 并镜像采集体退出码；Electron 超时强退时终止 launcher 与采集体共享的专用进程组。 |

前台 app 无可截窗口时(如 Finder 桌面、无窗口应用),采集体**静默跳过本次 tick**:不发 `capture.result`、不发 `capture.error`(仅 stderr 记一行),下个 interval 再试。

## 依赖(dev)

采集体用 libwebp 编码 WebP,dev 环境需先安装:

```bash
brew install webp
```

`build-capture-bundle.sh` 用 `brew --prefix webp` 动态解析头/库路径并**静态链接** `libwebp.a` + `libsharpyuv.a`(libwebp 的编码器会引用 SharpYuv 符号),使产物二进制自足、运行时不依赖 libwebp dylib(`otool -L` 无 libwebp 条目)。路径绝不写死进 `Package.swift` 或脚本。

## 构建与签名

```bash
# 在 apps/desktop 下
pnpm run build:capture
```

该脚本 `swift build -c release`(带上述 libwebp include / 静态归档 flag),组装并**用 `Recapsy Developer` 自签名证书**签整个 bundle,产物落在 gitignored 的 `apps/desktop/macos/build/Recapsy.app`(绝不落系统临时目录 —— macOS 拒绝为 `/tmp` 下的 bundle 持久化授权,ADR 约束①)。签名身份可用环境变量 `RECAPSY_CAPTURE_SIGN_IDENTITY` 覆盖。

产物路径:

- 启动器:`build/Recapsy.app/Contents/MacOS/CaptureLauncher`
- 采集体:`build/Recapsy.app/Contents/MacOS/Recapsy`

复验签名:

```bash
codesign -dv --verbose=4 macos/build/Recapsy.app
# 应看到 Identifier=one.recapsy.desktop.capture、Authority=Recapsy Developer
```

## Electron `.app` 装配

在 `apps/desktop` 下运行：

```bash
pnpm run package:macos
```

命令先构建真实 capture bundle 与 Electron main / preload，再由
`@electron/packager` 生成宿主机架构的
`dist/release/Recapsy-darwin-<arch>/Recapsy.app`。应用代码来自最小 staging，
`app.asar` 只包含 `dist/main/electron-entry.js`、login preload / HTML、shell
main preload / HTML 和最小 manifest；源码、tests、SwiftPM `.build` 与 package
`node_modules` 不会进入产物。
采集 bundle 位于标准 nested-code 路径
`Recapsy.app/Contents/Frameworks/RecapsyCapture.app`，`Contents/Resources` 不保留
重复副本。

签名渠道分为三种。未设置 `RECAPSY_CAPTURE_SIGN_IDENTITY` 时是本机开发渠道：
Electron 外壳和 helpers 使用 ad-hoc 签名，capture bundle 恢复为稳定的
`Recapsy Developer` 身份，outer app 最后重新 seal 并执行完整验证；本机必须已有
可用的该证书。显式设置为 `-` 时，outer 与 nested 全部使用 ad-hoc 签名，仅用于
CI 的布局、进程和 seal 门禁，不提供跨 rebuild 的 TCC 身份稳定性。显式设置为
Developer ID 时，Packager 使用同一发行身份 inside-out 签完整应用；Developer ID
凭据、notarization 和正式分发仍由后续独立发行任务完成。

当前命令只生成 host-native 架构，不生成 universal 或另一架构产物；也不包含 DMG、
notarization 或 auto-update。自动化不得把 ad-hoc GREEN 宣称为 Developer ID、
Gatekeeper 或正式发行完成。

## 自动化测试(不依赖屏幕录制授权)

```bash
# Swift 纯逻辑单测(相对键、活跃窗口选择、协议编码、哈希)——不碰 libwebp。
# 因 SwiftPM 的 `swift test` 会编译整个包(含依赖 libwebp 的采集体),这里
# target-scoped 只构建测试目标再跑,即使未装 libwebp 也能独立跑绿:
cd macos
swift build --target CaptureCoreTests
swift test --skip-build
# 注:裸 `swift test` 会连带编译采集体,需要上文的 libwebp include/静态归档
# flag(否则找不到 <webp/encode.h> / 链接失败)——那条路径由 build 脚本覆盖。

# 真实 spawn 已签名 bundle(经 disclaim 启动器)+ 协议握手
cd ..
pnpm run test:capture-bundle-process
```

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
   export RECAPSY_DESKTOP_HELPER_COMMAND="$PWD/macos/build/Recapsy.app/Contents/MacOS/CaptureLauncher"
   export RECAPSY_DESKTOP_HELPER_ARGS="$PWD/macos/build/Recapsy.app/Contents/MacOS/Recapsy"
   ```

   `RECAPSY_DESKTOP_HELPER_ARGS` 是单个 argv 值，因此路径可以包含空格。该覆盖只在
   未打包开发环境生效，正式 `.app` 会拒绝覆盖。资产根经
   `RECAPSY_CAPTURE_ASSET_ROOT` env 传递（Electron 从 `userData/captures` 派生）。

3. **启动桌面 app 并登录**(触发 sync loop)。

4. **首次采集触发系统授权弹框**,或手动到:

   系统设置 → 隐私与安全性 → **屏幕录制** → 确认存在一条名为 **`Recapsy`** 的条目并**勾选启用**。

   > 关键复验:显示名必须是 `Recapsy`(取自可执行名 `Recapsy` / `CFBundleName`,不是只靠 `CFBundleDisplayName`,ADR 约束③)。若显示成别的名字,说明可执行名或 bundle 装配错了。

5. **辅助功能**:Tray / 主窗口可打开「辅助功能」设置面板。采集体通过 `AXIsProcessTrusted()` 探测并上报 `granted` / `not_determined`;用户须手动 `+` 添加并启用 **Recapsy**(ADR 约束②)。辅助功能不影响截图,但缺少时 context metadata 无法采样。

6. **观察闭环**:授权后采集体截取当前活跃窗口、产出真实 WebP 写入 `userData/captures/<captureId>/screenshot.webp`,`capture.result` 的 `asset.ref` 为相对键 `<captureId>/screenshot.webp`、`asset.mimeType` 为 `image/webp`;主进程按同一资产根读回字节,sync job 从 `blocked` 转为 `synced`。

7. (可选)彻底清理残留 TCC 条目:

   ```bash
   tccutil reset ScreenCapture one.recapsy.desktop.capture
   ```

### 关于 disclaim 身份的诚实边界

ADR 0009 的 spike 已在 macOS 15 实测确认 disclaim 生效(责任进程翻转为采集进程自身、授权按其 bundle 身份归属)。本启动器使用同一私有 API(`responsibility_spawnattrs_setdisclaim`),`swift build` / 运行时均无报错(setdisclaim 返回 0)。但在**当前开发机的调用链已持有屏幕录制授权**的前提下,`CGPreflightScreenCaptureAccess()` 对「disclaim 后按自身身份」与「未 disclaim 借用祖先授权」两种情况都返回 `granted`,单凭权限探测**无法就地区分**。要确证授权是绑定到新 bundle 身份 `one.recapsy.desktop.capture`(而非借用父链),须以上面第 4 步「屏幕录制面板出现名为 Recapsy 的条目」为准。
