import { vi } from "vitest";

/**
 * Mock @langchain/openai ChatOpenAI
 */
export const mockChatOpenAI = vi.fn().mockImplementation(() => ({
  invoke: vi.fn().mockResolvedValue({
    content: "# Test Summary\n\nThis is a test summary.",
  }),
}));

/**
 * Mock git 模块
 */
export const mockGitModule = {
  getRepoCommits: vi
    .fn()
    .mockResolvedValue(
      "abc1234 2025-12-11 John Doe feat: test commit\n  - Test change"
    ),
  getRepoDiffs: vi.fn().mockResolvedValue([
    {
      file: "src/test.ts",
      diff: 'diff --git a/src/test.ts b/src/test.ts\n+console.log("test");',
      tokenCount: 100,
    },
  ]),
};

/**
 * Mock progress-tracker 模块
 */
export const mockProgressTrackerModule = {
  progressTracker: {
    updateProgress: vi.fn(),
    getProgress: vi.fn(),
    clearProgress: vi.fn(),
  },
};

/**
 * Mock config-manager 模块
 */
export const mockConfigManagerModule = {
  ConfigManager: {
    getInstance: vi.fn(() => ({
      getActiveProfile: vi.fn(() => ({
        git: {
          authorPattern: "test-author",
          since: "yesterday",
        },
        todoist: {
          apiToken: "",
        },
      })),
    })),
  },
};

/**
 * Mock fs 模块（用于测试文件写入）
 */
export const mockFsModule = {
  promises: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
};

/**
 * Mock fetch（用于测试 Todoist API）
 */
export const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: vi.fn().mockResolvedValue([
    {
      id: "task-1",
      content: "Test task",
      completed_at: "2025-12-11T10:00:00Z",
    },
  ]),
});

/**
 * 设置所有常用的 mocks
 */
export function setupCommonMocks() {
  vi.mock("@langchain/openai", () => ({
    ChatOpenAI: mockChatOpenAI,
  }));

  vi.mock("../../lib/git", () => mockGitModule);
  vi.mock("../../lib/progress-tracker", () => mockProgressTrackerModule);
  vi.mock("../../lib/config-manager", () => mockConfigManagerModule);
  vi.mock("fs", () => mockFsModule);

  global.fetch = mockFetch as any;
}

/**
 * 重置所有 mocks
 */
export function resetAllMocks() {
  vi.clearAllMocks();
  mockChatOpenAI.mockClear();
  mockGitModule.getRepoCommits.mockClear();
  mockGitModule.getRepoDiffs.mockClear();
  mockProgressTrackerModule.progressTracker.updateProgress.mockClear();
  mockFsModule.promises.writeFile.mockClear();
  mockFetch.mockClear();
}
