# Daily Work Summarizer

基于 LangGraph + React + TypeScript 的智能每日工作总结工具。

## ✨ 功能特性

- 🤖 **AI 驱动**：使用 LangGraph 工作流和 OpenAI 生成高质量工作总结
- 📊 **多数据源**：自动收集 Git 提交记录，支持手动补充说明
- 🎯 **灵活配置**：支持自定义时间范围、仓库选择、作者过滤
- 📝 **Markdown 导出**：生成结构化的 Markdown 格式总结
- 🎨 **现代化 UI**：基于 shadcn/ui 的美观界面
- ⚡ **实时反馈**：通过 SSE 实时展示工作流执行进度

## 🚀 快速开始

### 环境要求

- Node.js 20+
- pnpm 8+
- OpenAI API Key

### 安装

```bash
# 克隆项目
git clone <repository-url>
cd daily-work-summarizer

# 安装依赖
pnpm install
```

### 配置

在 `backend` 目录创建 `.env` 文件：

```bash
# OpenAI API 配置（必需）
OPENAI_API_KEY=sk-...

# Todoist API 配置（可选）
TODOIST_API_KEY=your-todoist-api-key

# 自动汇总配置（可选）
AUTO_REPOS=/path/to/repo1,/path/to/repo2
AUTO_TIME=23:59
```

### 运行

```bash
# 启动后端（端口 3456）
pnpm dev:backend

# 启动前端（端口 5173）
pnpm dev:frontend
```

访问 http://localhost:5173 开始使用。

## 📁 项目结构

```
daily-work-summarizer/
├── backend/                    # 后端服务
│   ├── src/
│   │   ├── api/               # Express API
│   │   │   ├── routes/        # API 路由
│   │   │   └── server.ts      # 服务器入口
│   │   ├── lib/               # 工具库
│   │   │   ├── git.ts         # Git 操作
│   │   │   └── logger.ts      # 日志工具
│   │   └── workflow/          # LangGraph 工作流
│   │       ├── graph.ts       # 工作流图定义
│   │       ├── state.ts       # 状态定义
│   │       └── nodes/         # 工作流节点
│   └── package.json
│
├── frontend/                   # 前端应用
│   ├── src/
│   │   ├── components/        # React 组件
│   │   │   ├── ui/           # shadcn/ui 组件
│   │   │   ├── InputForm.tsx  # 输入表单
│   │   │   └── ResultCard.tsx # 结果展示
│   │   ├── App.tsx
│   │   └── main.tsx
│   └── package.json
│
├── package.json               # Workspace 配置
├── pnpm-workspace.yaml        # pnpm workspace
├── ARCHITECTURE.md            # 架构文档
└── CLAUDE.md                  # 开发指南
```

## 🛠️ 技术栈

### 后端

- **运行时**：Node.js + TypeScript
- **Web 框架**：Express
- **工作流引擎**：LangGraph 0.2
- **AI 模型**：OpenAI GPT
- **数据库**：SQLite (Checkpointer)

### 前端

- **框架**：React 18 + TypeScript
- **构建工具**：Vite
- **UI 组件**：shadcn/ui (Radix UI)
- **样式**：Tailwind CSS
- **Markdown 渲染**：react-markdown

## 📖 使用说明

### 快速模式

1. 选择配置文件或创建新配置
2. 选择要汇总的 Git 仓库
3. 选择时间范围（今天/本周/本月/自定义）
4. 添加补充说明（可选）
5. 点击"生成总结"

### 配置管理

配置文件存储在项目根目录的 `config.json`，包含：

- Git 仓库根路径列表
- 默认仓库选择
- 作者过滤模式
- 时间范围设置

## 🔧 开发

### 可用脚本

```bash
# 开发
pnpm dev:backend      # 启动后端开发服务器
pnpm dev:frontend     # 启动前端开发服务器

# 构建
pnpm build            # 构建所有项目

# 清理
pnpm clean            # 清理构建产物和临时文件

# 代码检查（frontend）
pnpm --filter daily-work-summarizer-frontend lint
```

### 工作流架构

LangGraph 工作流包含以下节点：

1. **git_collector**：收集 Git 提交记录
2. **user_input**：接收用户补充说明
3. **external_api**：调用外部 API（如 Todoist）
4. **ai_processor**：AI 分析和生成总结
5. **markdown_exporter**：导出 Markdown 文件

节点并行执行数据收集，然后由 AI 处理器统一生成总结。

## 📄 许可证

ISC

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

更多详细信息请参阅 [ARCHITECTURE.md](./ARCHITECTURE.md) 和 [CLAUDE.md](./CLAUDE.md)。
