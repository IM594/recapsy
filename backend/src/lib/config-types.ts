/**
 * 配置类型定义
 */

export interface GitConfig {
  /** 项目根目录列表 */
  rootPaths: string[];
  /** 默认选中的仓库路径列表 */
  defaultRepos?: string[];
  /** Git 作者匹配模式 (正则表达式) */
  authorPattern?: string;
  /** 时间配置模式: 'relative' 使用相对时间, 'absolute' 使用具体时间 */
  timeMode?: "relative" | "absolute";
  /** 默认开始时间 (相对时间,如 'yesterday', '24 hours ago') */
  since?: string;
  /** 默认结束时间 (相对时间) */
  until?: string;
  /** 具体开始时间 (ISO 格式,如 '2024-12-10T00:00:00') */
  absoluteSince?: string;
  /** 具体结束时间 (ISO 格式) */
  absoluteUntil?: string;
  /** 最大提交数量 */
  maxCommits?: number;
  /** 是否包含 diffstat */
  includeStat?: boolean;
  /** fallback 时间范围 */
  sinceFallback?: string;
}

export interface OutputConfig {
  /** 输出目录 */
  directory: string;
  /** 输出格式 */
  format: "markdown" | "json" | "html";
}

export interface ScheduleConfig {
  /** 是否启用定时任务 */
  enabled: boolean;
  /** Cron 表达式 */
  cron: string;
  /** 时区 */
  timezone: string;
}

export interface ExternalApiConfig {
  /** Todoist API Key */
  todoistApiKey?: string;
}

export interface ProfileConfig {
  /** 配置名称 */
  name: string;
  /** Git 配置 */
  git: GitConfig;
  /** 输出配置 */
  output: OutputConfig;
  /** 定时任务配置 */
  schedule?: ScheduleConfig;
  /** 外部 API 配置 */
  externalApi?: ExternalApiConfig;
}

export interface AppConfig {
  /** 配置版本 */
  version: string;
  /** 配置 Profile 列表 */
  profiles: Record<string, ProfileConfig>;
  /** 当前激活的 Profile 名称 */
  activeProfile: string;
}
