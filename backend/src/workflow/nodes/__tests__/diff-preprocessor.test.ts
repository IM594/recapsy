import { describe, it, expect, vi, beforeEach } from "vitest";
import { diffPreprocessor } from "../diff-preprocessor";
import { createMockState, createMockGitDiffs } from "./test-helpers";

// Mock dependencies
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({
      content: "AI summarized diff content",
    }),
  })),
}));

import { ChatOpenAI } from "@langchain/openai";

describe("diffPreprocessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("应该在 deepAnalysis 为 false 时直接通过", async () => {
    const mockDiffs = createMockGitDiffs(2);
    const state = createMockState({
      deepAnalysis: false,
      gitDiffs: mockDiffs,
    });

    const result = await diffPreprocessor(state);

    expect(result.gitDiffs).toEqual(mockDiffs);
    expect(ChatOpenAI).not.toHaveBeenCalled();
  });

  it("应该在 gitDiffs 为空时直接通过", async () => {
    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: [],
    });

    const result = await diffPreprocessor(state);

    expect(result.gitDiffs).toEqual([]);
    expect(ChatOpenAI).not.toHaveBeenCalled();
  });

  it("应该在总 tokens 小于阈值时直接通过", async () => {
    const mockDiffs = [
      { file: "file1.ts", diff: "small diff 1", tokenCount: 100 },
      { file: "file2.ts", diff: "small diff 2", tokenCount: 200 },
    ];

    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: mockDiffs,
    });

    const result = await diffPreprocessor(state);

    expect(result.gitDiffs).toEqual(mockDiffs);
    expect(ChatOpenAI).not.toHaveBeenCalled();
  });

  it("应该在总 tokens 超过阈值时触发 AI 摘要", async () => {
    const mockDiffs = [
      {
        file: "large-file.ts",
        diff: "very large diff content",
        tokenCount: 5000,
      },
      { file: "huge-file.ts", diff: "extremely large diff", tokenCount: 26000 },
    ];

    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: mockDiffs,
      aiConfigs: {
        diffPreprocessor: {
          modelName: "gpt-4",
          temperature: 0.3,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await diffPreprocessor(state);

    expect(ChatOpenAI).toHaveBeenCalled();
    expect(result.gitDiffs).toBeDefined();
    expect(result.gitDiffs?.length).toBeGreaterThan(0);

    const summarizedFile = result.gitDiffs?.find(
      (d: any) => d.file === "huge-file.ts"
    );
    expect(summarizedFile?.diff).toContain("[AI SUMMARIZED DIFF]");
  });

  it("应该只摘要超过阈值的文件", async () => {
    const mockDiffs = [
      { file: "small.ts", diff: "small diff", tokenCount: 500 },
      { file: "large.ts", diff: "large diff content", tokenCount: 25000 },
      { file: "medium.ts", diff: "medium diff", tokenCount: 1500 },
      { file: "huge.ts", diff: "huge diff content", tokenCount: 5000 },
    ];

    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: mockDiffs,
      aiConfigs: {
        diffPreprocessor: {
          modelName: "gpt-4",
          temperature: 0.3,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await diffPreprocessor(state);

    const largeFile = result.gitDiffs?.find((d: any) => d.file === "large.ts");
    const hugeFile = result.gitDiffs?.find((d: any) => d.file === "huge.ts");
    const smallFile = result.gitDiffs?.find((d: any) => d.file === "small.ts");
    const mediumFile = result.gitDiffs?.find(
      (d: any) => d.file === "medium.ts"
    );

    expect(largeFile?.diff).toContain("[AI SUMMARIZED DIFF]");
    expect(hugeFile?.diff).toContain("[AI SUMMARIZED DIFF]");
    expect(smallFile?.diff).toBe("small diff");
    expect(mediumFile?.diff).toBe("medium diff");
  });

  it("应该处理 AI 调用失败的情况", async () => {
    // 重置 mock 并设置失败响应
    vi.mocked(ChatOpenAI).mockReset();
    vi.mocked(ChatOpenAI).mockImplementation(
      () =>
        ({
          invoke: vi.fn().mockRejectedValue(new Error("AI API failed")),
        } as any)
    );

    // 确保总 tokens 超过 30000 以触发处理，且单文件超过 2000 以触发摘要
    const mockDiffs = [
      { file: "large.ts", diff: "large diff", tokenCount: 35000 },
    ];

    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: mockDiffs,
      aiConfigs: {
        diffPreprocessor: {
          modelName: "gpt-4",
          temperature: 0.3,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await diffPreprocessor(state);

    const file = result.gitDiffs?.find((d: any) => d.file === "large.ts");
    expect(file?.diff).toContain("[Error Summarizing Diff]");
  });

  it("应该抛出错误如果缺少 AI 配置", async () => {
    const mockDiffs = [
      { file: "large.ts", diff: "large diff", tokenCount: 31000 },
    ];

    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: mockDiffs,
      aiConfigs: {},
    });

    await expect(diffPreprocessor(state)).rejects.toThrow(
      "缺少 diffPreprocessor 的 AI 配置"
    );
  });
});
