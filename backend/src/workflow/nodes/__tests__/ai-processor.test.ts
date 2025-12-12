import { describe, it, expect, vi, beforeEach } from "vitest";
import { aiProcessor } from "../ai-processor";
import { createMockState } from "./test-helpers";

// Mock dependencies
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({
      content:
        "# 今日工作总结\n\n## 今日事项\n- 完成功能开发\n\n## 今日总结\n今天完成了主要功能。",
    }),
  })),
}));

import { ChatOpenAI } from "@langchain/openai";

describe("aiProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("应该成功生成今日总结", async () => {
    const state = createMockState({
      gitCommits: "abc1234 feat: add feature",
      userInput: "今天完成了新功能",
      summaryType: "today",
      aiConfigs: {
        aiProcessor: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    const result = await aiProcessor(state);

    expect(result.processedContent?.markdownContent).toBeDefined();
    expect(result.processedContent?.markdownContent).toContain("今日工作总结");
    expect(ChatOpenAI).toHaveBeenCalled();
  });

  it("应该处理缺少 AI 配置的情况", async () => {
    const state = createMockState({
      gitCommits: "test commits",
      aiConfigs: {},
    });

    // 源码不再抛出错误，而是返回错误提示
    const result = await aiProcessor(state);
    expect(result.processedContent?.markdownContent).toContain("处理失败");
  });

  it("应该处理 AI 调用失败的情况", async () => {
    vi.mocked(ChatOpenAI).mockImplementationOnce(
      () =>
        ({
          invoke: vi.fn().mockRejectedValue(new Error("API error")),
        } as any)
    );

    const state = createMockState({
      gitCommits: "test commits",
      aiConfigs: {
        aiProcessor: {
          modelName: "gpt-4",
          temperature: 0.7,
          baseURL: "https://api.openai.com/v1",
          apiKey: "test-key",
        },
      },
    });

    // 源码不再抛出错误，而是返回错误提示
    const result = await aiProcessor(state);
    expect(result.processedContent?.markdownContent).toContain("处理失败");
  });
});
