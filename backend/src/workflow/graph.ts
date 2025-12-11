import { StateGraph, END, START } from "@langchain/langgraph";
import { WorkflowStateAnnotation } from "./state";
import {
  collectGitCommits,
  collectUserInput,
  collectExternalData,
  aiProcessor,
  exportMarkdown,
} from "./nodes/index";
import { createCheckpointer } from "./checkpointer";

export function createWorkflowGraph() {
  const workflow = new StateGraph(WorkflowStateAnnotation);

  // 添加所有节点
  workflow.addNode("git_collector", collectGitCommits);
  workflow.addNode("user_input", collectUserInput);
  workflow.addNode("external_api", collectExternalData);
  workflow.addNode("ai_processor", aiProcessor);
  workflow.addNode("markdown_exporter", exportMarkdown);

  // 定义流程
  // 1. 三个数据收集节点并行执行
  workflow.addEdge(START, "git_collector" as any);
  workflow.addEdge(START, "user_input" as any);
  workflow.addEdge(START, "external_api" as any);

  // 2. 所有收集器完成后，进入 AI 处理器
  workflow.addEdge("git_collector" as any, "ai_processor" as any);
  workflow.addEdge("user_input" as any, "ai_processor" as any);
  workflow.addEdge("external_api" as any, "ai_processor" as any);

  // 3. AI 处理完成后，导出 Markdown
  workflow.addEdge("ai_processor" as any, "markdown_exporter" as any);

  // 4. 导出完成，结束
  workflow.addEdge("markdown_exporter" as any, END);

  // 编译
  const checkpointer = createCheckpointer();
  return workflow.compile({ checkpointer });
}
