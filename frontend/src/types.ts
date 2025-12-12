/**
 * 前端共享类型定义
 */

export interface GitConfig {
  rootPaths: string[];
  defaultRepos?: string[];
  authorPattern?: string;
  timeMode?: "relative" | "absolute";
  since?: string;
  until?: string;
  absoluteSince?: string;
  absoluteUntil?: string;
  _scannedRepos?: Array<{ name: string; path: string }>; // 临时存储扫描结果
}

export interface OutputConfig {
  directory: string;
  format: string;
}

export interface AIConfig {
  modelName: string;
  baseURL?: string;
  apiKey?: string;
  temperature?: number;
}

export interface AINodeConfigs {
  default: AIConfig;
  diffPreprocessor?: AIConfig;
  aiProcessor?: AIConfig;
  technicalAnalyst?: AIConfig;
  contextAnalyst?: AIConfig;
  synthesizer?: AIConfig;
}

export interface ProfileConfig {
  name: string;
  git: GitConfig;
  output: OutputConfig;
  ai?: AINodeConfigs;
}
