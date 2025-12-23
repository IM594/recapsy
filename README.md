# Electron 桌面应用模板

一个开箱即用的 Electron 桌面应用开发模板，集成现代化前端技术栈。

## 技术栈

| 技术 | 说明 |
|------|------|
| [Electron](https://www.electronjs.org/) | 跨平台桌面应用框架 |
| [Vite](https://vitejs.dev/) | 下一代前端构建工具 |
| [React 19](https://react.dev/) | UI 框架 |
| [TypeScript](https://www.typescriptlang.org/) | 类型安全 |
| [Tailwind CSS 4](https://tailwindcss.com/) | 原子化 CSS |
| [shadcn/ui](https://ui.shadcn.com/) | 高质量组件库 |
| [Jotai](https://jotai.org/) | 原子化状态管理 |
| [pnpm](https://pnpm.io/) | 快速的包管理器 |

## 快速开始

### 1. 克隆模板

```bash
# 复制此模板到你的项目目录
cp -r electron-demo my-app
cd my-app
```

### 2. 安装依赖

```bash
pnpm install

# 如果 Electron 报错，运行：
node node_modules/electron/install.js
```

### 3. 启动开发

```bash
pnpm dev
```

## 命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 启动开发模式（热重载） |
| `pnpm run build` | 构建 React 应用 |
| `pnpm run build:app` | 打包成 `.dmg` 安装包 |

## 项目结构

```
electron-demo/
├── electron/
│   └── main.cjs           # Electron 主进程
├── src/
│   ├── components/ui/     # shadcn 组件
│   ├── lib/               # 工具函数
│   ├── App.tsx            # 主应用组件
│   ├── main.tsx           # React 入口
│   └── index.css          # 全局样式
├── components.json        # shadcn 配置
├── vite.config.ts         # Vite 配置
├── tailwind.config.js     # Tailwind 配置
└── package.json
```

## 开发指南

### 添加 shadcn 组件

```bash
# 查看可用组件
npx shadcn@latest add

# 添加指定组件
npx shadcn@latest add button
npx shadcn@latest add input
npx shadcn@latest add dialog
```

### 修改应用名称

编辑 `package.json`：

```json
{
  "name": "your-app-name",
  "build": {
    "productName": "你的应用名称"
  }
}
```

### 修改窗口设置

编辑 `electron/main.cjs`：

```javascript
const win = new BrowserWindow({
  width: 1200,
  height: 800,
  titleBarStyle: "hiddenInset",  // macOS 风格
  ...
})
```

### 状态管理

使用 Jotai：

```typescript
import { atom, useAtom } from 'jotai'

// 创建原子
const countAtom = atom(0)

// 使用
function Counter() {
  const [count, setCount] = useAtom(countAtom)
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>
}
```

## 打包分发

### macOS

```bash
pnpm run build:app
```

生成的 `dist/ElectronDemo.dmg` 可直接分发。

### Windows / Linux

修改 `package.json` 的 build 配置添加对应平台：

```json
{
  "build": {
    "mac": { "target": ["dmg"] },
    "win": { "target": ["nsis"] },
    "linux": { "target": ["AppImage"] }
  }
}
```

## 常见问题

### Electron 启动报错

```bash
node node_modules/electron/install.js
```

### 白屏问题

确保 `electron/main.cjs` 中：

- `backgroundColor` 与应用背景色一致
- 使用 `show: false` + `ready-to-show` 事件

### pnpm 构建脚本被阻止

在 `.npmrc` 中已配置：
```
enable-pre-post-scripts=true
```

## 支持平台

- macOS (Intel + Apple Silicon)
- Windows (x64 + ARM)
- Linux

## 资源

- [Electron 文档](https://www.electronjs.org/docs)
- [shadcn/ui 组件](https://ui.shadcn.com/docs/components)
- [Vite 文档](https://vitejs.dev/)
