import fs from "fs/promises";
import path from "path";
import { AppConfig, ProfileConfig } from "./config-types";

/**
 * 配置管理器 - 单例模式
 * 负责加载、保存和管理应用配置
 */
export class ConfigManager {
  private static instance: ConfigManager;
  private config: AppConfig | null = null;
  private configPath: string;

  private constructor() {
    this.configPath = path.join(process.cwd(), "config.json");
  }

  /**
   * 获取 ConfigManager 单例实例
   */
  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * 加载配置文件
   * 如果配置文件不存在,则创建默认配置
   */
  public async load(): Promise<void> {
    try {
      const configData = await fs.readFile(this.configPath, "utf-8");
      this.config = JSON.parse(configData);
      console.log(
        `[ConfigManager] 配置加载成功, activeProfile=${this.config?.activeProfile}`
      );
    } catch (error: any) {
      if (error.code === "ENOENT") {
        console.log("[ConfigManager] 配置文件不存在,创建默认配置");
        await this.createDefaultConfig();
      } else {
        console.error("[ConfigManager] 配置加载失败:", error);
        throw error;
      }
    }
  }

  /**
   * 创建默认配置文件
   */
  private async createDefaultConfig(): Promise<void> {
    const defaultConfig: AppConfig = {
      version: "1.0",
      profiles: {
        default: {
          name: "默认配置",
          git: {
            rootPaths: [],
            defaultRepos: [],
            authorPattern: "",
            timeMode: "relative",
            since: "yesterday",
            until: "",
            absoluteSince: "",
            absoluteUntil: "",
            maxCommits: 20,
            includeStat: true,
            sinceFallback: "30 days ago",
          },
          output: {
            directory: "./outputs",
            format: "markdown",
          },
          schedule: {
            enabled: false,
            cron: "0 18 * * *",
            timezone: "Asia/Shanghai",
          },
          ai: {
            default: {
              modelName:
                process.env.AI_MODEL_NAME || "claude-opus-4-5-20251101",
              baseURL: process.env.OPENAI_BASE_URL,
              apiKey: process.env.OPENAI_API_KEY,
              temperature: 0.7,
            },
          },
        },
      },
      activeProfile: "default",
    };

    this.config = defaultConfig;
    await this.save();
  }

  /**
   * 保存配置到文件
   */
  public async save(): Promise<void> {
    if (!this.config) {
      throw new Error("配置未加载");
    }

    await fs.writeFile(
      this.configPath,
      JSON.stringify(this.config, null, 2),
      "utf-8"
    );
    console.log("[ConfigManager] 配置保存成功");
  }

  /**
   * 获取当前激活的配置 Profile
   */
  public getActiveProfile(): ProfileConfig {
    if (!this.config) {
      throw new Error("配置未加载,请先调用 load()");
    }

    const profile = this.config.profiles[this.config.activeProfile];
    if (!profile) {
      throw new Error(`配置 Profile 不存在: ${this.config.activeProfile}`);
    }

    return profile;
  }

  /**
   * 获取指定名称的配置 Profile
   */
  public getProfile(name: string): ProfileConfig {
    if (!this.config) {
      throw new Error("配置未加载,请先调用 load()");
    }

    const profile = this.config.profiles[name];
    if (!profile) {
      throw new Error(`配置 Profile 不存在: ${name}`);
    }

    return profile;
  }

  /**
   * 获取所有配置
   */
  public getAllConfig(): AppConfig {
    if (!this.config) {
      throw new Error("配置未加载,请先调用 load()");
    }

    return this.config;
  }

  /**
   * 获取所有 Profile 名称列表
   */
  public getProfileNames(): string[] {
    if (!this.config) {
      throw new Error("配置未加载,请先调用 load()");
    }

    return Object.keys(this.config.profiles);
  }

  /**
   * 设置激活的配置 Profile
   */
  public async setActiveProfile(name: string): Promise<void> {
    if (!this.config) {
      throw new Error("配置未加载,请先调用 load()");
    }

    if (!this.config.profiles[name]) {
      throw new Error(`配置 Profile 不存在: ${name}`);
    }

    this.config.activeProfile = name;
    await this.save();
    console.log(`[ConfigManager] 切换激活配置: ${name}`);
  }

  /**
   * 创建新的配置 Profile
   */
  public async createProfile(
    name: string,
    config: ProfileConfig
  ): Promise<void> {
    if (!this.config) {
      throw new Error("配置未加载,请先调用 load()");
    }

    if (this.config.profiles[name]) {
      throw new Error(`配置 Profile 已存在: ${name}`);
    }

    this.config.profiles[name] = config;
    await this.save();
    console.log(`[ConfigManager] 创建配置 Profile: ${name}`);
  }

  /**
   * 更新配置 Profile
   */
  public async updateProfile(
    name: string,
    config: Partial<ProfileConfig>
  ): Promise<void> {
    if (!this.config) {
      throw new Error("配置未加载,请先调用 load()");
    }

    if (!this.config.profiles[name]) {
      throw new Error(`配置 Profile 不存在: ${name}`);
    }

    this.config.profiles[name] = {
      ...this.config.profiles[name],
      ...config,
      git: {
        ...this.config.profiles[name].git,
        ...(config.git || {}),
      },
      output: {
        ...this.config.profiles[name].output,
        ...(config.output || {}),
      },
      schedule: config.schedule
        ? {
            ...this.config.profiles[name].schedule,
            ...config.schedule,
          }
        : this.config.profiles[name].schedule,
    };

    await this.save();
    console.log(`[ConfigManager] 更新配置 Profile: ${name}`);
  }

  /**
   * 删除配置 Profile
   */
  public async deleteProfile(name: string): Promise<void> {
    if (!this.config) {
      throw new Error("配置未加载,请先调用 load()");
    }

    if (name === "default") {
      throw new Error("不能删除默认配置");
    }

    if (!this.config.profiles[name]) {
      throw new Error(`配置 Profile 不存在: ${name}`);
    }

    if (this.config.activeProfile === name) {
      this.config.activeProfile = "default";
    }

    delete this.config.profiles[name];
    await this.save();
    console.log(`[ConfigManager] 删除配置 Profile: ${name}`);
  }

  /**
   * 获取指定节点的 AI 配置
   * 如果节点没有特定配置,返回默认配置
   * 如果没有配置 AI 字段,抛出错误
   */
  public getAIConfig(nodeName: string): any {
    const profile = this.getActiveProfile();

    if (!profile.ai) {
      throw new Error(
        `配置 Profile "${this.config?.activeProfile}" 缺少 AI 配置。请在配置文件中添加 "ai" 字段。`
      );
    }

    if (!profile.ai.default) {
      throw new Error(
        `配置 Profile "${this.config?.activeProfile}" 缺少默认 AI 配置。请在 "ai" 字段中添加 "default" 配置。`
      );
    }

    // 根据节点名称获取特定配置,如果没有则使用默认配置
    const nodeConfig = (profile.ai as any)[nodeName] || profile.ai.default;

    // 合并默认配置和节点配置
    return {
      ...profile.ai.default,
      ...nodeConfig,
    };
  }
}
