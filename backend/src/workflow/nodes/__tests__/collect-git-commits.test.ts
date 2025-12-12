import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockState } from "./test-helpers";

/**
 * collect-git-commits 测试：
 * 注意：由于 ConfigManager 是单例模式，在 vitest 中难以 mock。
 * 以下测试用例标记为 skip，需要后续重构 ConfigManager 使其可测试。
 */

describe("collectGitCommits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.skip("应该成功收集多个仓库的 commits - 需要 ConfigManager mock", async () => {
    // TODO: 需要重构 ConfigManager 使其可测试
  });

  it.skip("应该处理空仓库列表 - 需要 ConfigManager mock", async () => {
    // TODO: 需要重构 ConfigManager 使其可测试
  });

  it.skip("应该处理 Git 命令失败的情况 - 需要 ConfigManager mock", async () => {
    // TODO: 需要重构 ConfigManager 使其可测试
  });

  it.skip("应该正确传递 author pattern 和日期范围 - 需要 ConfigManager mock", async () => {
    // TODO: 需要重构 ConfigManager 使其可测试
  });

  it.skip("应该过滤掉返回 null 的仓库 - 需要 ConfigManager mock", async () => {
    // TODO: 需要重构 ConfigManager 使其可测试
  });
});
