import { Annotation } from "@langchain/langgraph";

export const WorkflowStateAnnotation = Annotation.Root({
  // 选中的仓库路径列表
  selectedRepos: Annotation<string[]>({
    reducer: (prev, next) => next || prev || [],
  }),

  // 日期范围
  since: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  until: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  // Git 提交记录
  gitCommits: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  // 总结类型: today, week, month
  summaryType: Annotation<"today" | "week" | "month">({
    reducer: (prev, next) => next || prev || "today",
  }),

  // AI 处理后的内容
  processedContent: Annotation<{
    markdownContent?: string;
  }>(),

  // 最终输出的文件路径
  outputPath: Annotation<string>(),
});

export type WorkflowState = typeof WorkflowStateAnnotation.State;
