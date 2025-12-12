import { Annotation } from "@langchain/langgraph";

export const WorkflowStateAnnotation = Annotation.Root({
  // Thread ID for progress tracking
  threadId: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  // 各个数据源收集的原始数据
  gitCommits: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  userInput: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  // 用户选择的仓库路径列表
  selectedRepos: Annotation<string[]>({
    reducer: (prev, next) => next || prev || [],
  }),

  since: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  until: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  externalData: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  // AI 处理后的结构化内容
  processedContent: Annotation<{
    markdownContent?: string;
    summary?: string;
    achievements?: string[];
    challenges?: string[];
    nextSteps?: string[];
  }>(),

  // 总结类型
  summaryType: Annotation<"today" | "week" | "month" | "custom">({
    reducer: (prev, next) => next || prev || "custom",
  }),

  // Feature Flags
  deepAnalysis: Annotation<boolean>({
    reducer: (prev, next) => next ?? prev ?? false,
  }),

  // High-Volume Data for Deep Analysis
  gitDiffs: Annotation<any>({
    reducer: (prev, next) => next || prev || null,
  }),

  // Intermediate Agent Outputs
  technicalAnalysis: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  contextualAnalysis: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  // Track which collectors have finished
  collectorProgress: Annotation<string[]>({
    reducer: (prev, next) => {
      if (!prev) return next || [];
      if (!next) return prev;
      return Array.from(new Set([...prev, ...next]));
    },
  }),

  // AI 节点配置 (从 ConfigManager 传入)
  aiConfigs: Annotation<Record<string, any>>({
    reducer: (prev, next) => next || prev || {},
  }),

  // 最终的 Markdown 文件路径
  outputPath: Annotation<string>(),
});

export type WorkflowState = typeof WorkflowStateAnnotation.State;
