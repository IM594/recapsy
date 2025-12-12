import { StateGraph, END, START } from "@langchain/langgraph";
import { WorkflowStateAnnotation } from "./state";
import {
  collectGitCommits,
  collectUserInput,
  collectExternalData,
  aiProcessor,
  exportMarkdown,
  collectGitDiffs,
  diffPreprocessor,
  technicalAnalyst,
  contextAnalyst,
  synthesizer,
  dataBarrier,
} from "./nodes/index";
import { createCheckpointer } from "./checkpointer";

export function createWorkflowGraph() {
  const workflow = new StateGraph(WorkflowStateAnnotation);

  // --- Add Nodes ---
  // Shared Nodes
  workflow.addNode("git_collector", collectGitCommits);
  workflow.addNode("user_input", collectUserInput);
  workflow.addNode("external_api", collectExternalData);

  // Legacy Nodes
  workflow.addNode("ai_processor", aiProcessor);

  // Deep Mode Nodes
  workflow.addNode("diff_collector", collectGitDiffs);
  workflow.addNode("diff_preprocessor", diffPreprocessor);
  workflow.addNode("technical_analyst", technicalAnalyst);
  workflow.addNode("context_analyst", contextAnalyst);
  workflow.addNode("synthesizer", synthesizer);

  // Barrier Node
  workflow.addNode("data_barrier", dataBarrier);

  // Common Exporter
  workflow.addNode("markdown_exporter", exportMarkdown);

  // --- Define Edges ---

  // 1. Initial Parallel Collection
  workflow.addEdge(START, "git_collector" as any);
  workflow.addEdge(START, "user_input" as any);
  workflow.addEdge(START, "external_api" as any);
  workflow.addEdge(START, "diff_collector" as any);

  // 2. All collectors feed into DataBarrier
  workflow.addEdge("git_collector" as any, "data_barrier" as any);
  workflow.addEdge("user_input" as any, "data_barrier" as any);
  workflow.addEdge("external_api" as any, "data_barrier" as any);
  workflow.addEdge("diff_collector" as any, "data_barrier" as any);

  // 3. Routing from DataBarrier
  const routeAfterBarrier = (state: any) => {
    const completed = state.collectorProgress || [];
    const expected = ["git_collector", "user_input", "external_api"];
    if (state.deepAnalysis) expected.push("diff_collector");

    const allReady = expected.every((c) => completed.includes(c));

    if (!allReady) {
      // Not ready, stop this branch
      return END;
    }

    // All ready, proceed to analysis
    if (state.deepAnalysis) {
      // Deep Analysis: Fork to Context and Technical
      // We can't return an array here for parallel execution in LangGraph conditional edges usually...
      // Wait, LangGraph *does* support returning an array of nodes for parallel execution!
      return ["context_analyst", "diff_preprocessor"];
    } else {
      return "ai_processor";
    }
  };

  workflow.addConditionalEdges("data_barrier" as any, routeAfterBarrier);

  // 4. Deep Analysis Chain
  workflow.addEdge("diff_preprocessor" as any, "technical_analyst" as any);
  workflow.addEdge("technical_analyst" as any, "synthesizer" as any);
  workflow.addEdge("context_analyst" as any, "synthesizer" as any);

  // 5. Legacy AI Processor feeds into Exporter
  workflow.addEdge("ai_processor" as any, "markdown_exporter" as any);

  // 6. Synthesizer Routing (unchanged logic, but now inputs are guaranteed)
  const routeAfterSynthesizer = (state: any) => {
    // In deep analysis mode, only proceed if we have both analyses
    if (state.deepAnalysis) {
      if (state.technicalAnalysis && state.contextualAnalysis) {
        return "markdown_exporter";
      }
      return END;
    }
    return "markdown_exporter";
  };

  workflow.addConditionalEdges("synthesizer" as any, routeAfterSynthesizer);

  // End
  workflow.addEdge("markdown_exporter" as any, END);

  // Compile
  const checkpointer = createCheckpointer();
  return workflow.compile({ checkpointer });
}
