import { describe, it, expect, vi, beforeEach } from "vitest";
import { synthesizer } from "../synthesizer";
import { createMockState } from "../../__tests__/test-helpers";

// Mock dependencies
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({
      content:
        "# Daily Work Summary\n\n## Overview\nCompleted feature development and bug fixes.\n\n## Details\n- Feature A: Implemented authentication\n- Bug B: Fixed login issue",
    }),
  })),
}));

import { ChatOpenAI } from "@langchain/openai";

describe("synthesizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("应该在 deepAnalysis 为 false 时跳过综合分析", async () => {
    const state = createMockState({
      deepAnalysis: false,
    });

    const result = await synthesizer(state);

    expect(result.processedContent).toEqual({});
    expect(ChatOpenAI).not.toHaveBeenCalled();
  });

  it("应该在 deepAnalysis 为 true 时执行综合分析", async () => {
    const state = createMockState({
      deepAnalysis: true,
      contextualAnalysis: "# Context\nMain focus: Feature development",
      technicalAnalysis: "# Technical\nRefactored auth module",
      gitCommits: "abc1234 feat: add auth",
      userInput: "完成了认证功能",
      aiConfigs: {
        synthesizer: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await synthesizer(state);

    expect(result.processedContent?.markdownContent).toBeDefined();
    expect(result.processedContent?.markdownContent).toContain(
      "Daily Work Summary"
    );
    expect(ChatOpenAI).toHaveBeenCalled();
  });

  it("应该在 prompt 中包含所有分析结果", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({
      content: "# Summary",
    });

    vi.mocked(ChatOpenAI).mockImplementationOnce(
      () =>
        ({
          invoke: mockInvoke,
        } as any)
    );

    const state = createMockState({
      deepAnalysis: true,
      contextualAnalysis: "Context analysis content",
      technicalAnalysis: "Technical analysis content",
      gitCommits: "Git commits",
      userInput: "User input",
      aiConfigs: {
        synthesizer: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    await synthesizer(state);

    const prompt = mockInvoke.mock.calls[0][0];
    expect(prompt).toContain("Context analysis content");
    expect(prompt).toContain("Technical analysis content");
  });

  it("应该处理缺少 AI 配置的情况", async () => {
    const state = createMockState({
      deepAnalysis: true,
      contextualAnalysis: "Context",
      technicalAnalysis: "Technical",
      aiConfigs: {},
    });

    const result = await synthesizer(state);

    expect(result.processedContent?.markdownContent).toContain(
      "Error Generating Report"
    );
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
      contextualAnalysis: "Context",
      technicalAnalysis: "Technical",
      aiConfigs: {
        synthesizer: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await synthesizer(state);

    expect(result.processedContent?.markdownContent).toContain(
      "Error Generating Report"
    );
  });

  it("应该正确传递 AI 配置", async () => {
    const state = createMockState({
      deepAnalysis: true,
      contextualAnalysis: "Context",
      technicalAnalysis: "Technical",
      aiConfigs: {
        synthesizer: {
          modelName: "gpt-4-turbo",
          temperature: 0.8,
          baseURL: "https://custom-api.com/v1",
          apiKey: "custom-key",
        },
      },
    });

    await synthesizer(state);

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

  it("应该处理缺少分析结果的情况", async () => {
    const state = createMockState({
      deepAnalysis: true,
      contextualAnalysis: undefined,
      technicalAnalysis: undefined,
      aiConfigs: {
        synthesizer: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await synthesizer(state);

    expect(result).toEqual({});
  });

  it("应该处理 AI 返回空内容的情况", async () => {
    vi.mocked(ChatOpenAI).mockImplementationOnce(
      () =>
        ({
          invoke: vi.fn().mockResolvedValue({ content: "" }),
        } as any)
    );

    const state = createMockState({
      deepAnalysis: true,
      contextualAnalysis: "Context",
      technicalAnalysis: "Technical",
      aiConfigs: {
        synthesizer: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await synthesizer(state);

    expect(result.processedContent?.markdownContent).toBe("");
  });
});
