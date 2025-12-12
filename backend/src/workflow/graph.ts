import { StateGraph, END, START } from "@langchain/langgraph";
import { WorkflowStateAnnotation } from "./state";
import { collectGitCommits, aiProcessor, exportMarkdown } from "./nodes/index";

/**
 * 创建简化的工作流图
 * 流程: START → git_collector → ai_processor → markdown_exporter → END
 */
export function createWorkflowGraph() {
  const workflow = new StateGraph(WorkflowStateAnnotation);

  // 添加节点
  workflow.addNode("git_collector", collectGitCommits);
  workflow.addNode("ai_processor", aiProcessor);
  workflow.addNode("markdown_exporter", exportMarkdown);

  // 定义边 - 简单的线性流程
  workflow.addEdge(START, "git_collector" as any);
  workflow.addEdge("git_collector" as any, "ai_processor" as any);
  workflow.addEdge("ai_processor" as any, "markdown_exporter" as any);
  workflow.addEdge("markdown_exporter" as any, END);

  // 编译（不使用 checkpointer）
  return workflow.compile();
}
