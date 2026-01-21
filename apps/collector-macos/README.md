# RecapSense macOS Collector（最小可用版）

这是一个 **macOS 13+** 的原生采集进程（Swift / SwiftPM 可执行程序），负责：

- 每 5 秒截图（当前默认：主屏幕）
- 计算 `dHash` 做快速去重（避免重复 OCR / 重复入库）
- Vision OCR 抽取文本
- 写入本机 Agent：`POST /v1/ingest/frame`（带 token）
-（可选）写入缩略图到数据目录：`media/thumbnails/YYYY-MM-DD/...`（路径会写入 frames 表）

> 目标是先跑通最小闭环：**截图 → OCR → 入库 → 搜索 → MCP**。后续再逐步增强（多屏/更强去重/音频/LLM Vision 等）。

## 构建

在本目录执行：

```bash
swift build -c release
```

产物默认在：

- `./.build/release/recapsense-collector`

## 运行（建议先启动 Agent）

1）在仓库根目录启动 Agent（会生成 token）：

```bash
npm run dev:agent
```

2）设置环境变量（建议使用**绝对路径**，避免相对路径不一致）：

```bash
export RECAPSENSE_AGENT_URL="http://127.0.0.1:4832"
export RECAPSENSE_DATA_DIR="/绝对路径/到/recapsense/.recapsense"
```

如果你不想传 `RECAPSENSE_DATA_DIR`，也可以直接传 token（两者选其一即可）：

```bash
export RECAPSENSE_API_TOKEN="你的 token（一般由 Agent 生成）"
```

3）启动采集（默认 5 秒）：

```bash
./.build/release/recapsense-collector
```

可选参数示例：

```bash
./.build/release/recapsense-collector --interval 5 --dedupe-threshold 2 --ocr-level fast
```

## 权限（必须）

截图与窗口标题在 macOS 需要系统权限：

- **屏幕录制**（必须，否则无法截屏）
  - 系统设置 → 隐私与安全性 → 屏幕录制
- **辅助功能**（可选，用于获取 `windowTitle`，没有也能跑）
  - 系统设置 → 隐私与安全性 → 辅助功能

开发阶段如果你是从终端运行，通常需要给“终端.app（Terminal）/ iTerm”授权；如果你是直接运行二进制，也可能需要给该二进制授权。

授权后可能需要**重启**相关进程（终端/collector）才能生效。

## 调试技巧

- 只采集一次并退出（便于验证权限/OCR）：

```bash
./.build/release/recapsense-collector --once
```

- 不写入 Agent，只打印 OCR 摘要（便于排查 OCR 质量）：

```bash
./.build/release/recapsense-collector --dry-run --once
```

## 目录与数据

当缩略图开启（默认开启）时，collector 会写入：

- `${RECAPSENSE_DATA_DIR}/media/thumbnails/YYYY-MM-DD/<ts>_<hash>.jpg`

并把相对路径写入 ingestion payload 的 `thumbnailPath` 字段（Agent 会原样存入 `frames.thumbnail_path`）。

## 已知限制（MVP）

- 目前只截取**主屏幕**（多屏支持后续再做）
- 当前仅做 screenshot+OCR，不含 mic/系统音频
- 去重策略是 `dHash + 阈值`，属于“足够好”的最小实现，后续会迭代
