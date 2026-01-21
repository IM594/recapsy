/**
 * Logger utility for backend output.
 */

// ANSI 颜色码
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

function timestamp(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export const logger = {
  /**
   * Task start - prints a section header.
   */
  taskStart(taskName: string, details?: Record<string, any>) {
    console.log("");
    console.log(`${colors.cyan}${"═".repeat(60)}${colors.reset}`);
    console.log(
      `${colors.bright}▶ ${taskName}${colors.reset}  ${
        colors.gray
      }[${timestamp()}]${colors.reset}`
    );
    if (details) {
      Object.entries(details).forEach(([key, value]) => {
        console.log(
          `   ${colors.dim}├─${colors.reset} ${key}: ${colors.yellow}${value}${colors.reset}`
        );
      });
    }
    console.log(`${colors.cyan}${"─".repeat(60)}${colors.reset}`);
  },

  /**
   * Task done
   */
  taskEnd(taskName: string, duration?: number, result?: string) {
    console.log(`${colors.cyan}${"─".repeat(60)}${colors.reset}`);
    console.log(
      `${colors.green}✔ ${taskName} finished${colors.reset}` +
        (duration
          ? `  ${colors.gray}time: ${formatDuration(duration)}${colors.reset}`
          : "") +
        (result ? `  ${colors.dim}→ ${result}${colors.reset}` : "")
    );
    console.log(`${colors.cyan}${"═".repeat(60)}${colors.reset}`);
    console.log("");
  },

  /**
   * Task failed
   */
  taskError(taskName: string, error: Error | string) {
    console.log(`${colors.cyan}${"─".repeat(60)}${colors.reset}`);
    console.log(`${colors.red}✖ ${taskName} failed${colors.reset}`);
    console.log(
      `   ${colors.red}${typeof error === "string" ? error : error.message}${
        colors.reset
      }`
    );
    console.log(`${colors.cyan}${"═".repeat(60)}${colors.reset}`);
    console.log("");
  },

  /**
   * Step start
   */
  step(icon: string, message: string, details?: Record<string, any>) {
    console.log(
      `${colors.bright}${icon}${colors.reset} ${message}  ${
        colors.gray
      }[${timestamp()}]${colors.reset}`
    );
    if (details) {
      Object.entries(details).forEach(([key, value]) => {
        console.log(
          `   ${colors.dim}├─${colors.reset} ${key}: ${colors.yellow}${value}${colors.reset}`
        );
      });
    }
  },

  /**
   * Step done
   */
  stepDone(message: string, duration?: number) {
    console.log(
      `   ${colors.green}└─ ${message}${colors.reset}` +
        (duration
          ? ` ${colors.gray}(${formatDuration(duration)})${colors.reset}`
          : "")
    );
  },

  /**
   * Info
   */
  info(message: string) {
    console.log(`   ${colors.dim}│${colors.reset} ${message}`);
  },

  /**
   * Debug
   */
  debug(label: string, value: any) {
    const valueStr =
      typeof value === "object" ? JSON.stringify(value) : String(value);
    const truncated =
      valueStr.length > 100 ? valueStr.slice(0, 100) + "..." : valueStr;
    console.log(
      `   ${colors.dim}│ ${label}: ${colors.gray}${truncated}${colors.reset}`
    );
  },

  /**
   * Warning
   */
  warn(message: string) {
    console.log(`   ${colors.yellow}! ${message}${colors.reset}`);
  },

  /**
   * Error
   */
  error(message: string, error?: Error) {
    console.log(`   ${colors.red}✗ ${message}${colors.reset}`);
    if (error?.stack) {
      console.log(
        `   ${colors.dim}${error.stack.split("\n").slice(1, 3).join("\n   ")}${
          colors.reset
        }`
      );
    }
  },
};

export default logger;
