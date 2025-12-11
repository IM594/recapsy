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

  // 最终的 Markdown 文件路径
  outputPath: Annotation<string>(),
});

export type WorkflowState = typeof WorkflowStateAnnotation.State;
