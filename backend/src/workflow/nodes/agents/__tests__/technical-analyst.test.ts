import { describe, it, expect, vi, beforeEach } from "vitest";
import { technicalAnalyst } from "../technical-analyst";
import {
  createMockState,
  createMockGitDiffs,
} from "../../__tests__/test-helpers";

// Mock dependencies
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({
      content: "# Technical Analysis\n\nRefactored authentication module.",
    }),
  })),
}));

import { ChatOpenAI } from "@langchain/openai";

describe("technicalAnalyst", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("应该在 deepAnalysis 为 false 时跳过分析", async () => {
    const state = createMockState({
      deepAnalysis: false,
    });

    const result = await technicalAnalyst(state);

    expect(result.technicalAnalysis).toBe("Skipped (Deep Analysis disabled)");
    expect(ChatOpenAI).not.toHaveBeenCalled();
  });

  it("应该在没有 gitDiffs 时跳过分析", async () => {
    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: null as any,
      aiConfigs: {},
    });

    const result = await technicalAnalyst(state);

    expect(result.technicalAnalysis).toBe("Skipped (Deep Analysis disabled)");
  });

  it("应该在有 gitDiffs 时执行技术分析", async () => {
    const mockDiffs = createMockGitDiffs(2);

    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: mockDiffs,
      aiConfigs: {
        technicalAnalyst: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await technicalAnalyst(state);

    expect(result.technicalAnalysis).toBeDefined();
    expect(result.technicalAnalysis).toContain("Technical Analysis");
    expect(ChatOpenAI).toHaveBeenCalled();
  });

  it("应该在 prompt 中包含所有 diffs", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({
      content: "# Analysis",
    });

    vi.mocked(ChatOpenAI).mockImplementationOnce(
      () =>
        ({
          invoke: mockInvoke,
        } as any)
    );

    const mockDiffs = [
      { file: "file1.ts", diff: "diff content 1", tokenCount: 100 },
      { file: "file2.ts", diff: "diff content 2", tokenCount: 200 },
    ];

    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: mockDiffs,
      aiConfigs: {
        technicalAnalyst: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    await technicalAnalyst(state);

    const prompt = mockInvoke.mock.calls[0][0];
    expect(prompt).toContain("file1.ts");
    expect(prompt).toContain("file2.ts");
    expect(prompt).toContain("diff content 1");
    expect(prompt).toContain("diff content 2");
  });

  it("应该处理缺少 AI 配置的情况", async () => {
    const mockDiffs = createMockGitDiffs(1);

    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: mockDiffs,
      aiConfigs: {},
    });

    const result = await technicalAnalyst(state);

    expect(result.technicalAnalysis).toBe("Analysis Failed");
  });

  it("应该处理 AI 调用失败的情况", async () => {
    vi.mocked(ChatOpenAI).mockImplementationOnce(
      () =>
        ({
          invoke: vi.fn().mockRejectedValue(new Error("API error")),
        } as any)
    );

    const mockDiffs = createMockGitDiffs(1);

    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: mockDiffs,
      aiConfigs: {
        technicalAnalyst: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await technicalAnalyst(state);

    expect(result.technicalAnalysis).toBe("Analysis Failed");
  });

  it("应该正确传递 AI 配置", async () => {
    const mockDiffs = createMockGitDiffs(1);

    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: mockDiffs,
      aiConfigs: {
        technicalAnalyst: {
          modelName: "gpt-4-turbo",
          temperature: 0.8,
          baseURL: "https://custom-api.com/v1",
          apiKey: "custom-key",
        },
      },
    });

    await technicalAnalyst(state);

    expect(ChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: "gpt-4-turbo",
        temperature: 0.8,
        openAIApiKey: "custom-key",
        configuration: {
          baseURL: "https://custom-api.com/v1",
        },
      })
    );
  });

  it("应该处理大量 diffs", async () => {
    const mockDiffs = createMockGitDiffs(10);

    const state = createMockState({
      deepAnalysis: true,
      gitDiffs: mockDiffs,
      aiConfigs: {
        technicalAnalyst: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await technicalAnalyst(state);

    expect(result.technicalAnalysis).toBeDefined();
    expect(ChatOpenAI).toHaveBeenCalled();
  });
});
