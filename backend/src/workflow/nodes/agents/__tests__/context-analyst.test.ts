import { describe, it, expect, vi, beforeEach } from "vitest";
import { contextAnalyst } from "../context-analyst";
import { createMockState } from "../../__tests__/test-helpers";

// Mock dependencies
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({
      content:
        "# Contextual Analysis\n\nMain focus: Feature development and bug fixes.",
    }),
  })),
}));

import { ChatOpenAI } from "@langchain/openai";

describe("contextAnalyst", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("应该在 deepAnalysis 为 false 时跳过分析", async () => {
    const state = createMockState({
      deepAnalysis: false,
    });

    const result = await contextAnalyst(state);

    expect(result.contextualAnalysis).toBe("Skipped");
    expect(ChatOpenAI).not.toHaveBeenCalled();
  });

  it("应该在 deepAnalysis 为 true 时执行上下文分析", async () => {
    const state = createMockState({
      deepAnalysis: true,
      gitCommits: "abc1234 feat: add feature",
      userInput: "今天完成了新功能",
      externalData: "Task: Implement feature A",
      aiConfigs: {
        contextAnalyst: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await contextAnalyst(state);

    expect(result.contextualAnalysis).toBeDefined();
    expect(result.contextualAnalysis).toContain("Contextual Analysis");
    expect(ChatOpenAI).toHaveBeenCalled();
  });

  it("应该在 prompt 中包含所有数据源", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({
      content: "# Analysis",
    });

    vi.mocked(ChatOpenAI).mockImplementationOnce(
      () =>
        ({
          invoke: mockInvoke,
        } as any)
    );

    const state = createMockState({
      deepAnalysis: true,
      gitCommits: "Git commits",
      userInput: "User input",
      externalData: "External data",
      aiConfigs: {
        contextAnalyst: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    await contextAnalyst(state);

    const prompt = mockInvoke.mock.calls[0][0];
    expect(prompt).toContain("Git commits");
    expect(prompt).toContain("User input");
    expect(prompt).toContain("External data");
  });

  it("应该处理缺少 AI 配置的情况", async () => {
    const state = createMockState({
      deepAnalysis: true,
      gitCommits: "test commits",
      aiConfigs: {},
    });

    const result = await contextAnalyst(state);

    expect(result.contextualAnalysis).toBe("Analysis Failed");
  });

  it("应该处理 AI 调用失败的情况", async () => {
    vi.mocked(ChatOpenAI).mockImplementationOnce(
      () =>
        ({
          invoke: vi.fn().mockRejectedValue(new Error("API error")),
        } as any)
    );

    const state = createMockState({
      deepAnalysis: true,
      gitCommits: "test commits",
      aiConfigs: {
        contextAnalyst: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await contextAnalyst(state);

    expect(result.contextualAnalysis).toBe("Analysis Failed");
  });

  it("应该正确传递 AI 配置", async () => {
    const state = createMockState({
      deepAnalysis: true,
      gitCommits: "test commits",
      aiConfigs: {
        contextAnalyst: {
          modelName: "gpt-4-turbo",
          temperature: 0.8,
          baseURL: "https://custom-api.com/v1",
          apiKey: "custom-key",
        },
      },
    });

    await contextAnalyst(state);

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
});
