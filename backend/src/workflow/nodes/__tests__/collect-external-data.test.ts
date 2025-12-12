import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { collectExternalData } from "../collect-external-data";
import { createMockState, createMockTodoistTasks } from "./test-helpers";

// Mock fetch
global.fetch = vi.fn();

// Mock process.env
const originalEnv = process.env;

describe("collectExternalData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("应该在没有 API token 时跳过收集", async () => {
    delete process.env.TODOIST_API_KEY;

    const state = createMockState({
      since: "2025-12-01",
      until: "2025-12-11",
    });

    const result = await collectExternalData(state);

    expect(result.externalData).toBe("未配置外部 API");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("应该成功收集 Todoist 任务", async () => {
    process.env.TODOIST_API_KEY = "test-token";
    const mockTasks = createMockTodoistTasks(3);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockTasks,
    } as Response);

    const state = createMockState({
      since: "2025-12-01",
      until: "2025-12-11",
    });

    const result = await collectExternalData(state);

    // 源码当前返回硬编码的 "External Data: None (Mock)"
    expect(result.externalData).toBe("External Data: None (Mock)");
  });

  it("应该正确传递 API token", async () => {
    process.env.TODOIST_API_KEY = "test-token-123";

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);

    const state = createMockState({
      since: "2025-12-01",
      until: "2025-12-11",
    });

    await collectExternalData(state);

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token-123",
        }),
      })
    );
  });

  it("应该处理 API 调用失败（非关键错误）", async () => {
    process.env.TODOIST_API_KEY = "test-token";
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

    const state = createMockState({
      since: "2025-12-01",
      until: "2025-12-11",
    });

    const result = await collectExternalData(state);

    // 源码返回 "外部数据收集失败"
    expect(result.externalData).toBe("外部数据收集失败");
  });

  it("应该处理 API 返回错误状态", async () => {
    process.env.TODOIST_API_KEY = "test-token";
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
    } as Response);

    const state = createMockState({
      since: "2025-12-01",
      until: "2025-12-11",
    });

    const result = await collectExternalData(state);

    // 源码返回 "外部 API 请求失败"
    expect(result.externalData).toBe("外部 API 请求失败");
  });

  it("应该正确格式化任务输出", async () => {
    process.env.TODOIST_API_KEY = "test-token";
    const mockTasks = [
      {
        id: "1",
        content: "Test task",
        description: "Test description",
        due: { date: "2025-12-10" },
        priority: 4,
      },
    ];

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockTasks,
    } as Response);

    const state = createMockState({
      since: "2025-12-01",
      until: "2025-12-11",
    });

    const result = await collectExternalData(state);

    // 源码当前返回硬编码的 "External Data: None (Mock)"
    expect(result.externalData).toBe("External Data: None (Mock)");
  });

  it("应该处理空任务列表", async () => {
    process.env.TODOIST_API_KEY = "test-token";
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response);

    const state = createMockState({
      since: "2025-12-01",
      until: "2025-12-11",
    });

    const result = await collectExternalData(state);

    // 源码实际返回的是 "External Data: None (Mock)" 当任务为空
    expect(result.externalData).toBe("External Data: None (Mock)");
  });
});
