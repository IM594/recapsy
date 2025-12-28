const { app, BrowserWindow } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

// 开发模式：加载 Vite 服务器
const isDev = !app.isPackaged;

// ========== 日志过滤配置 ==========
// 设置 Chromium 日志级别（只显示致命错误）
// 级别: 0=INFO, 1=WARNING, 2=ERROR, 3=FATAL_ERROR, 4=DISABLED
app.commandLine.appendSwitch('log-level', '3');  // 只显示 FATAL 错误

// 启用硬件加速以提升动画性能
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

// 只在开发环境过滤日志
if (isDev) {
  // 拦截 stderr，只保留自己代码的日志
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function(chunk, encoding, callback) {
    const msg = String(chunk);

    // 只显示非框架来源的日志（排除 devtools://, chrome://, electron 等前缀）
    const isFrameworkNoise = /^(\[.*?\])?\s*(\d{4}-\d{2}-\d{2}.*Electron\[|.*ERROR:CONSOLE.*source: devtools:)/.test(msg);

    if (!isFrameworkNoise) {
      return originalWrite(chunk, encoding, callback);
    }
    if (callback) callback();
    return true;
  };
}
// ========== 日志过滤配置结束 ==========

// 后端服务器进程
let backendProcess = null;
let backendPort = 3456;

// 启动后端服务器
function startBackend() {
  return new Promise((resolve, reject) => {
    // 后端服务器路径
    const backendPath = isDev
      ? path.join(__dirname, "../backend/src/api/server.ts")
      : path.join(process.resourcesPath, "backend/dist/api/server.js");

    // 后端目录（用于设置工作目录和查找 .env）
    const backendDir = isDev
      ? path.join(__dirname, "../backend")
      : path.join(process.resourcesPath, "backend");

    // .env 文件路径
    const envPath = path.join(backendDir, ".env");

    // 检查 .env 文件是否存在
    if (!fs.existsSync(envPath)) {
      console.warn("⚠️  警告: .env 文件不存在，后端可能无法正常工作");
    } else {
      console.log("✅ 找到 .env 文件:", envPath);
    }

    console.log("🔧 启动后端服务器...");
    console.log("   工作目录:", backendDir);

    // 使用 tsx 启动（开发模式）或直接运行编译后的代码（生产模式）
    const command = isDev ? "npx" : "node";
    const args = isDev ? ["tsx", backendPath] : [backendPath];

    backendProcess = spawn(command, args, {
      cwd: backendDir,
      env: {
        ...process.env,
        PORT: String(backendPort),
      },
      stdio: "pipe",
      shell: true,
    });

    backendProcess.stdout.on("data", (data) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[Backend] ${output}`);
        // 检测服务器启动成功
        if (output.includes("服务器运行在")) {
          resolve();
        }
      }
    });

    backendProcess.stderr.on("data", (data) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[Backend Error] ${output}`);
      }
    });

    backendProcess.on("error", (err) => {
      console.error("❌ 后端启动失败:", err);
      reject(err);
    });

    backendProcess.on("exit", (code) => {
      console.log(`🛑 后端进程退出，代码: ${code}`);
      backendProcess = null;
    });

    // 超时处理
    setTimeout(() => {
      if (backendProcess) {
        console.log("✅ 后端启动超时（可能已成功）");
        resolve();
      }
    }, 5000);
  });
}

// 停止后端服务器
function stopBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    // 开发模式下打开 DevTools
    // win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../frontend/dist/index.html"));
  }
}

// App 事件
app.whenReady().then(async () => {
  try {
    // 先启动后端服务器
    await startBackend();
    console.log("✅ 后端服务器已就绪");

    // 再创建窗口
    createWindow();
  } catch (err) {
    console.error("❌ 应用启动失败:", err);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // 停止后端服务器
    stopBackend();
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  // 应用退出前停止后端
  stopBackend();
});
