# Recapsy macOS 采集进程

本目录是 Recapsy 桌面端的 macOS 屏幕采集进程(ADR 0009 的落地代码)。采集进程是一个**独立签名的 `.app` bundle**,由 Electron 主进程经一个 native disclaim 启动器 spawn,拥有自己稳定的 TCC 身份(bundle id `one.recapsy.desktop.capture`),按自身签名身份向系统申请屏幕录制授权。

## 组成

SwiftPM 包(`Package.swift`,macOS 14+ target):

| 目标 | 类型 | 职责 |
| --- | --- | --- |
| `CaptureCore` | Swift library | 纯逻辑:相对键生成、JPEG 落盘路径拼接、NDJSON envelope 编码、SHA-256 内容哈希、capture id 生成。全部有单测。 |
| `RecapsyCapture` | Swift executable | 采集体:`SCScreenshotManager` 单张主屏截图 → ImageIO JPEG(压后约 100–800KB)→ 写资产根 → NDJSON stdio 主循环。组装进 bundle 时**重命名为 `Recapsy`**(隐私面板显示名,ADR 约束③)。 |
| `CaptureLauncher` | C executable | 极小 disclaim 启动器:`posix_spawn` + `responsibility_spawnattrs_setdisclaim`,`waitpid` 到采集体退出并镜像其退出码。 |

## 构建与签名

```bash
# 在 apps/desktop 下
pnpm run build:capture
```

该脚本 `swift build -c release`,组装并**用 `Recapsy Developer` 自签名证书**签整个 bundle,产物落在 gitignored 的 `apps/desktop/macos/build/Recapsy.app`(绝不落系统临时目录 —— macOS 拒绝为 `/tmp` 下的 bundle 持久化授权,ADR 约束①)。签名身份可用环境变量 `RECAPSY_CAPTURE_SIGN_IDENTITY` 覆盖。

产物路径:

- 启动器:`build/Recapsy.app/Contents/MacOS/CaptureLauncher`
- 采集体:`build/Recapsy.app/Contents/MacOS/Recapsy`

复验签名:

```bash
codesign -dv --verbose=4 macos/build/Recapsy.app
# 应看到 Identifier=one.recapsy.desktop.capture、Authority=Recapsy Developer
```

## 自动化测试(不依赖屏幕录制授权)

```bash
# Swift 纯逻辑单测
swift test --package-path macos

# 真实 spawn 已签名 bundle(经 disclaim 启动器)+ 协议握手
pnpm run test:capture-bundle-process
```

集成测试断言:经启动器真实 spawn → 收到真实 `helper.hello`(`capabilities.mock === false`,即这是真采集体而非 dev 占位)、上报权限状态、`capture.start` 后跑出协议合法的 capture 信封、`stop()` 后启动器与采集体干净退出无僵尸。

## 手动 E2E 清单(真实 JPEG → server,需人工授权)

新 bundle id `one.recapsy.desktop.capture` 是**全新 TCC 身份**,屏幕录制授权只能由你在系统设置手动完成,自动化无法代点。按下列步骤验证整条链路从 `blocked` 走到 `synced`:

1. **构建 bundle**

   ```bash
   cd apps/desktop && pnpm run build:capture
   ```

2. **指向启动器与采集体**(Electron 的接线契约,见 `src/main/electron-entry.ts`):

   ```bash
   export RECAPSY_DESKTOP_HELPER_COMMAND="$PWD/macos/build/Recapsy.app/Contents/MacOS/CaptureLauncher"
   export RECAPSY_DESKTOP_HELPER_ARGS="$PWD/macos/build/Recapsy.app/Contents/MacOS/Recapsy"
   ```

   `RECAPSY_DESKTOP_HELPER_ARGS` 按空格分隔成 argv,因此采集体路径不能含空格;资产根经 `RECAPSY_CAPTURE_ASSET_ROOT` env 传递(Electron 从 `userData/captures` 派生),不走 argv,以容忍 `Application Support` 里的空格。

3. **启动桌面 app 并登录**(触发 sync loop)。

4. **首次采集触发系统授权弹框**,或手动到:

   系统设置 → 隐私与安全性 → **屏幕录制** → 确认存在一条名为 **`Recapsy`** 的条目并**勾选启用**。

   > 关键复验:显示名必须是 `Recapsy`(取自可执行名 `Recapsy` / `CFBundleName`,不是只靠 `CFBundleDisplayName`,ADR 约束③)。若显示成别的名字,说明可执行名或 bundle 装配错了。

5. **辅助功能本阶段不做**(ADR 约束②,阶段 3 才引导);采集体对 `accessibility` 恒报 `not_determined`,不影响截图。

6. **观察闭环**:授权后采集体产出真实 JPEG 写入 `userData/captures/<captureId>/screenshot.jpg`,`capture.result` 的 `asset.ref` 为相对键 `<captureId>/screenshot.jpg`;主进程按同一资产根读回字节,sync job 从 `blocked` 转为 `synced`。

7. (可选)彻底清理残留 TCC 条目:

   ```bash
   tccutil reset ScreenCapture one.recapsy.desktop.capture
   ```

### 关于 disclaim 身份的诚实边界

ADR 0009 的 spike 已在 macOS 15 实测确认 disclaim 生效(责任进程翻转为采集进程自身、授权按其 bundle 身份归属)。本启动器使用同一私有 API(`responsibility_spawnattrs_setdisclaim`),`swift build` / 运行时均无报错(setdisclaim 返回 0)。但在**当前开发机的调用链已持有屏幕录制授权**的前提下,`CGPreflightScreenCaptureAccess()` 对「disclaim 后按自身身份」与「未 disclaim 借用祖先授权」两种情况都返回 `granted`,单凭权限探测**无法就地区分**。要确证授权是绑定到新 bundle 身份 `one.recapsy.desktop.capture`(而非借用父链),须以上面第 4 步「屏幕录制面板出现名为 Recapsy 的条目」为准。
