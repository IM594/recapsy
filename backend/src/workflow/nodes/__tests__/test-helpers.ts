import { vi } from "vitest";
import { WorkflowState } from "../../state";

/**
 * 创建一个基础的 WorkflowState 用于测试
 */
export function createMockState(
  overrides?: Partial<WorkflowState>
): WorkflowState {
  const baseState: WorkflowState = {
    threadId: "test-thread-id",
    selectedRepos: [],
    since: "yesterday",
    until: "",
    summaryType: "custom",
    userInput: "",
    gitCommits: "",
    gitDiffs: [],
    externalData: "",
    processedContent: {
      markdownContent: "",
    },
    collectorProgress: [],
    deepAnalysis: false,
    aiConfigs: {
      aiProcessor: {
        modelName: "gpt-4",
        temperature: 0.7,
        baseURL: "https://api.openai.com/v1",
        apiKey: "test-api-key",
      },
      diffPreprocessor: {
        modelName: "gpt-3.5-turbo",
        temperature: 0.3,
        baseURL: "https://api.openai.com/v1",
        apiKey: "test-api-key",
      },
    },
  };

  return { ...baseState, ...overrides };
}

/**
 * Mock 进度追踪器
 */
export function mockProgressTracker() {
  return {
    updateProgress: vi.fn(),
    getProgress: vi.fn(),
    clearProgress: vi.fn(),
  };
}

/**
 * Mock Git commits 输出
 */
export function createMockGitCommits(
  repoName: string,
  count: number = 3
): string {
  const commits: string[] = [];
  for (let i = 0; i < count; i++) {
    commits.push(
      `abc123${i} 2025-12-${10 + i} John Doe feat: add feature ${i}\n` +
        `  - Implement feature ${i}\n` +
        `  - Add tests for feature ${i}`
    );
  }
  return `### ${repoName}\n${commits.join("\n\n")}`;
}

/**
 * Mock Git diffs 输出
 */
export function createMockGitDiffs(fileCount: number = 2) {
  const diffs = [];
  for (let i = 0; i < fileCount; i++) {
    diffs.push({
      file: `src/file${i}.ts`,
      diff:
        `diff --git a/src/file${i}.ts b/src/file${i}.ts\n` +
        `--- a/src/file${i}.ts\n` +
        `+++ b/src/file${i}.ts\n` +
        `@@ -1,3 +1,5 @@\n` +
        ` export function test() {\n` +
        `+  console.log('new line ${i}');\n` +
        `   return true;\n` +
        ` }`,
      tokenCount: 100 + i * 50,
    });
  }
  return diffs;
}

/**
 * Mock AI 响应
 */
export function createMockAIResponse(content: string) {
  return {
    content,
    response_metadata: {},
    id: "mock-response-id",
  };
}

/**
 * Mock ConfigManager
 */
export function createMockConfigManager(config?: any) {
  const defaultConfig = {
    git: {
      authorPattern: "test-author",
      since: "yesterday",
    },
    todoist: {
      apiToken: "",
    },
  };

  return {
    getInstance: vi.fn(() => ({
      getActiveProfile: vi.fn(() => ({ ...defaultConfig, ...config })),
      setActiveProfile: vi.fn(),
      getProfiles: vi.fn(() => []),
    })),
  };
}

/**
 * Mock Todoist API 响应
 */
export function createMockTodoistTasks(count: number = 3) {
  const tasks = [];
  for (let i = 0; i < count; i++) {
    tasks.push({
      id: `task-${i}`,
      content: `Test task ${i}`,
      description: `Description for task ${i}`,
      created_at: `2025-12-${10 + i}T10:00:00Z`,
      completed_at: `2025-12-${10 + i}T15:00:00Z`,
    });
  }
  return tasks;
}

/**
 * 等待一段时间（用于异步测试）
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
