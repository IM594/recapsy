# Recaply Sense 反屎山整改包（v1）

> 日期：2026-03-01  
> 适用范围：`/Users/user/Downloads/projects/my/recaply-sense`  
> 目标：把“屎山前兆”在低成本阶段消除，形成可持续迭代节奏。

## 1. 当前判定（基于仓库现状）

1. 当前不是全面屎山，但已经出现明显前兆。
2. 入口层职责交叉偏重：`MenuBarApp.swift` 体量 699 行、方法 36 个，包含运行时装配、UI 构建、权限探测、状态查询、动作分发等多职责。
3. 测试门禁存在盲区：`swift test` 已通过，但关键模块覆盖不均衡，部分核心文件行为无测试命中。
4. 重复逻辑开始出现：运行时装配在 CLI 与菜单栏入口重复；截图写盘与哈希在两种采集实现重复。
5. 并发边界不够显式：后台采集写库与主线程 UI 读库共享 `MemoryStore`，缺少可审计的串行/actor 约束。

## 2. 整改目标（对应你的执行规范）

1. 所有整改先拆成原子 Feature，逐个落地。
2. 每个 Feature 先有最小测试清单，再写实现。
3. 每个 Feature 变更范围只触达单一职责模块。
4. 每个 Feature 完成后记录耦合增减与回归结果。
5. 所有红线（无测试、复制粘贴、临时兜底无退出）默认阻断。

## 3. Feature 执行顺序（建议）

1. `F-001` 运行时装配抽离（先止血重复逻辑）
2. `F-002` 主窗口状态快照服务抽离（切断入口层交叉）
3. `F-003` 截图写盘与哈希抽象（消除双实现复制）
4. `F-004` CLI/MCP 路由可测试化（补齐裸实现测试）
5. `F-005` MemoryStore 并发边界显式化（处理中期稳定性风险）

---

## 4. 原子功能卡

### 4.1 F-001 运行时装配抽离

1. Feature 名称：`AppRuntimeBuilder 抽离`
2. 目标（Goal）：把 `MemoryStore + OfflinePipeline + CaptureService + CaptureLifecycleController` 的组装逻辑从 CLI 与菜单栏入口提取到单一装配器，消除重复和初始化分叉。
3. 非目标（Non-goals）：不改变采集频率、不改变数据库 schema、不改 UI 表现。
4. 输入契约（Input）：`dataDirectory` 或 `dbPath`、`windowSize`、`captureInterval`。
5. 输出契约（Output）：`AppRuntime`（包含 `store/service/lifecycle/dataDirectory`）。
6. 错误语义（Errors）：目录不可写、DB 初始化失败、采集源创建失败时返回可读错误，不吞错。
7. 状态读写范围（State Read/Write）：仅创建运行期对象并初始化 schema，不写业务数据。
8. 副作用（Side Effects）：文件夹创建、SQLite 文件创建、schema 初始化。
9. 依赖模块（Dependencies）：`MemoryStore`、`OfflinePipeline`、`CaptureSourceFactory`、`CaptureService`、`CaptureLifecycleController`、`VisionOCRProvider`。
10. 验收标准（Acceptance）：
   - CLI 与菜单栏入口共用同一装配器。
   - 重复装配代码从两个入口移除。
   - 初始化失败信息可定位到具体阶段。
11. 对应测试用例（Tests）：
   - 主路径：给定临时目录，构建 `AppRuntime` 成功并可读写基础统计。
   - 边界路径：给定非法路径或采集源失败注入时，返回预期错误。
   - 一致性路径：CLI 与菜单栏入口使用同一装配器 API（编译级+行为级断言）。

### 4.2 F-002 主窗口状态快照服务抽离

1. Feature 名称：`DashboardSnapshotService 抽离`
2. 目标（Goal）：将主窗口 `permission/stats/latest/error/hint` 读取逻辑从 `MenuBarAppDelegate` 拆分为独立服务，`MenuBarAppDelegate` 只做渲染与动作分发。
3. 非目标（Non-goals）：不修改按钮布局、不改菜单交互文案。
4. 输入契约（Input）：`CaptureLifecycleState`、`MemoryStore?`、`PermissionChecker`、`lastError`、`dataDirectory`。
5. 输出契约（Output）：`DashboardSnapshot` 结构（纯数据，UI 无关）。
6. 错误语义（Errors）：服务内部读库失败转为 `snapshot` 字段级错误文案，不抛到 UI 主循环。
7. 状态读写范围（State Read/Write）：只读 store 与权限状态，不写库。
8. 副作用（Side Effects）：权限 API 查询、数据库只读查询。
9. 依赖模块（Dependencies）：`MemoryStore`、`PermissionDiagnostics`、`CaptureLifecycleController`。
10. 验收标准（Acceptance）：
   - `MenuBarAppDelegate` 删除大部分文本拼接逻辑。
   - `refreshMainWindow` 只绑定快照数据。
   - 权限文案和统计文案行为不回归。
11. 对应测试用例（Tests）：
   - 主路径：有 store 且有数据时，返回完整快照字段。
   - 失败路径：store 查询异常时，对应字段返回 `读取失败:*`，其余字段可用。
   - 边界路径：store 未就绪时返回占位文案，不崩溃。

### 4.3 F-003 截图落盘与哈希能力抽象

1. Feature 名称：`FrameArtifactWriter 抽象`
2. 目标（Goal）：提取 `writePNG + sha256 + 文件命名` 公共能力，消除 `CGWindowCaptureSource` 与 `ScreenCaptureKitFrameSource` 重复实现。
3. 非目标（Non-goals）：不修改窗口选择策略、不修改采样触发条件。
4. 输入契约（Input）：`CGImage`、`captureDate`、`filenamePrefix`、`mediaDirectory`、可选 `windowID`。
5. 输出契约（Output）：`FrameArtifact(path: String, hash: String)`。
6. 错误语义（Errors）：图片编码失败、写盘失败时抛出 `RecaplySenseError.capture`。
7. 状态读写范围（State Read/Write）：写入媒体目录文件；不触达数据库。
8. 副作用（Side Effects）：PNG 文件写入、文件 IO。
9. 依赖模块（Dependencies）：Foundation / AppKit / CryptoKit（平台受限）。
10. 验收标准（Acceptance）：
   - 两个采集源共享该组件。
   - 重复代码删除，行为保持一致。
   - 生成路径和哈希可追踪且稳定。
11. 对应测试用例（Tests）：
   - 主路径：1x1 测试图像写盘成功且 hash 非空。
   - 失败路径：不可写目录注入后抛出预期错误。
   - 一致性路径：同图像重复写入得到一致 hash。

### 4.4 F-004 CLI/MCP 路由可测试化

1. Feature 名称：`MCPStdioHandler 可测试化`
2. 目标（Goal）：把 `main.swift` 中 JSON 行解析与 tool 路由逻辑抽离成独立对象，使 CLI 入口和协议行为可独立单测。
3. 非目标（Non-goals）：不新增 tool、不调整 MCP 输出字段。
4. 输入契约（Input）：单行 JSON 文本（包含 `tool`、`arguments`）。
5. 输出契约（Output）：JSON 字符串响应。
6. 错误语义（Errors）：非法 JSON、缺失参数、未知 tool 返回稳定错误结构。
7. 状态读写范围（State Read/Write）：只读 `MCPToolRouter`，不直接改库。
8. 副作用（Side Effects）：无（纯解析与路由）。
9. 依赖模块（Dependencies）：`MCPToolRouter`。
10. 验收标准（Acceptance）：
    - `main.swift` 仅保留参数分发与 IO 循环。
    - handler 可以直接单元测试。
    - 已有命令行为不变。
11. 对应测试用例（Tests）：
    - 主路径：`recapsense_search` 返回 `items[]`。
    - 失败路径：`recapsense_get_chunk` 缺 `id` 返回 `missing id`。
    - 边界路径：未知 tool 返回 `tool not found`。

### 4.5 F-005 MemoryStore 并发边界显式化

1. Feature 名称：`MemoryStoreAccess 串行边界`
2. 目标（Goal）：引入统一访问边界（串行队列或 actor 包装）来约束 `MemoryStore` 的并发读写路径，避免未来竞态。
3. 非目标（Non-goals）：不改 schema、不引入新数据库。
4. 输入契约（Input）：`withRead` / `withWrite` 或 actor API。
5. 输出契约（Output）：与原 `MemoryStore` 相同语义结果。
6. 错误语义（Errors）：保留原 SQLite 错误，附带访问上下文信息。
7. 状态读写范围（State Read/Write）：仅对数据库访问路径加边界。
8. 副作用（Side Effects）：访问时序从“隐式”变“显式串行”。
9. 依赖模块（Dependencies）：`MemoryStore`、`CaptureService`、`MenuBarApp` 读取逻辑。
10. 验收标准（Acceptance）：
    - 后台采集写入与前台读取走同一并发边界。
    - 高并发读写下无崩溃、无锁死。
    - 业务行为与输出不变。
11. 对应测试用例（Tests）：
    - 主路径：并发读写 100 轮后计数与数据一致。
    - 边界路径：写入失败不污染后续读路径（错误隔离）。

---

## 5. 最小测试清单（门禁版）

1. 每个 Feature 至少 2 条自动化测试（主路径 + 边界/失败路径）。
2. 本轮整改建议门槛：新增测试总数不少于 12 条。
3. 新增测试优先级：
   - `P0`：F-001、F-002、F-004（直接治理入口层与门禁盲区）
   - `P1`：F-003（去重复）
   - `P1`：F-005（并发风险）
4. 合并前必须执行：
   - `swift test`
   - `swift test --enable-code-coverage`
   - 检查 Core 关键文件覆盖率不下降。

## 6. 耦合变化模板（每个 Feature 完成后必填）

1. 新增耦合点：
2. 消除耦合点：
3. 是否跨层调用内部实现（是/否）：
4. 是否新增临时兜底（是/否，若是必须写移除条件）：
5. 行为兼容策略：

## 7. 风险点与缓解

1. 风险：UI 拆分后文案细节回归。  
   缓解：快照对象字段做快照测试，保留旧文案断言。
2. 风险：运行时装配抽离触发入口启动失败。  
   缓解：先引入新装配器并双路比对，再切换调用点。
3. 风险：并发边界调整影响性能。  
   缓解：先实现正确性，后做采样周期压测和指标比对。
4. 风险：采集模块平台 API 难测。  
   缓解：把平台 API 包装在 adapter，优先测试抽象层行为。

## 8. 例外机制（预填模板）

1. 例外原因：
2. 放宽门禁项：
3. 补测截止日期（Asia/Shanghai）：
4. 负责人：
5. 偿还前冻结项：

## 9. 建议执行节奏（3 天可落地）

1. Day 1：完成 `F-001 + F-004`（先把入口重复与可测试性拉平）。
2. Day 2：完成 `F-002`（显著降低 `MenuBarApp.swift` 复杂度）。
3. Day 3：完成 `F-003`，并启动 `F-005` 最小版本（先串行边界，后再优化）。

