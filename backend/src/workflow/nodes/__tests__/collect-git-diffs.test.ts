import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockState, createMockGitDiffs } from "./test-helpers";

/**
 * collect-git-diffs 测试：
 * 注意：由于 ConfigManager 是单例模式，在 vitest 中难以 mock。
 * 部分测试用例标记为 skip，需要后续重构 ConfigManager 使其可测试。
 */

// 无需 ConfigManager 的测试可以直接导入
import { collectGitDiffs } from "../collect-git-diffs";

describe("collectGitDiffs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("应该在 deepAnalysis 为 false 时跳过收集", async () => {
    const state = createMockState({
      deepAnalysis: false,
      selectedRepos: ["/path/to/repo1"],
    });

    const result = await collectGitDiffs(state);

    // 源码在 deepAnalysis=false 时返回 null
    expect(result.gitDiffs).toBeNull();
    expect(result.collectorProgress).toContain("diff_collector");
  });

  it.skip("应该在 deepAnalysis 为 true 时收集 diffs - 需要 ConfigManager mock", async () => {
    // TODO: 需要重构 ConfigManager 使其可测试
  });

  it.skip("应该处理空仓库列表 - 需要 ConfigManager mock", async () => {
    // TODO: 需要重构 ConfigManager 使其可测试
  });

  it.skip("应该合并多个仓库的 diffs - 需要 ConfigManager mock", async () => {
    // TODO: 需要重构 ConfigManager 使其可测试
  });

  it.skip("应该正确传递参数给 getRepoDiffs - 需要 ConfigManager mock", async () => {
    // TODO: 需要重构 ConfigManager 使其可测试
  });

  it.skip("应该处理 Git 命令失败的情况 - 需要 ConfigManager mock", async () => {
    // TODO: 需要重构 ConfigManager 使其可测试
  });
});
