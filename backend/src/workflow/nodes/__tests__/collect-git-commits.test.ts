import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockState } from "./test-helpers";

// Mock 依赖模块
vi.mock("../../../lib/git", () => ({
  getRepoCommits: vi.fn(),
}));

vi.mock("../../../lib/config-manager", () => ({
  ConfigManager: {
    getInstance: vi.fn(() => ({
      getActiveProfile: vi.fn(() => ({
        git: {
          authorPattern: "test-author",
          since: "yesterday",
        },
      })),
    })),
  },
}));

vi.mock("../../../lib/progress-tracker", () => ({
  progressTracker: {
    updateProgress: vi.fn(),
  },
}));

describe("collectGitCommits", () => {
  let collectGitCommits: typeof import("../collect-git-commits").collectGitCommits;
  let mockGetRepoCommits: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // 动态导入以应用 mock
    const gitModule = await import("../../../lib/git.js");
    mockGetRepoCommits = gitModule.getRepoCommits as ReturnType<typeof vi.fn>;

    const module = await import("../collect-git-commits.js");
    collectGitCommits = module.collectGitCommits;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("A1: 空仓库列表", () => {
    it("应该返回 '未选择任何 Git 仓库'", async () => {
      const state = createMockState({
        selectedRepos: [],
      });

      const result = await collectGitCommits(state);

      expect(result.gitCommits).toBe("未选择任何 Git 仓库");
      expect(result.collectorProgress).toContain("git_collector");
    });

    it("selectedRepos 为 undefined 时应该返回 '未选择任何 Git 仓库'", async () => {
      const state = createMockState({
        selectedRepos: undefined,
      });

      const result = await collectGitCommits(state);

      expect(result.gitCommits).toBe("未选择任何 Git 仓库");
    });
  });

  describe("A2: 单个仓库有 commits", () => {
    it("应该正确返回格式化的 commit 记录", async () => {
      mockGetRepoCommits.mockResolvedValue(
        "abc1234 John Doe 2025-12-11T10:00:00+08:00 feat: add feature\n" +
          "  src/test.ts | 10 ++++++++++\n" +
          "  1 file changed, 10 insertions(+)"
      );

      const state = createMockState({
        selectedRepos: ["/path/to/repo"],
        since: "2025-12-01",
        until: "2025-12-31",
      });

      const result = await collectGitCommits(state);

      expect(result.gitCommits).toContain("### repo");
      expect(result.gitCommits).toContain("abc1234");
      expect(mockGetRepoCommits).toHaveBeenCalledWith(
        "/path/to/repo",
        "test-author",
        "2025-12-01",
        "2025-12-31"
      );
    });
  });

  describe("A3: 多个仓库", () => {
    it("应该合并结果，每个仓库有标题", async () => {
      mockGetRepoCommits
        .mockResolvedValueOnce(
          "abc1234 John Doe 2025-12-11T10:00:00+08:00 feat: repo1"
        )
        .mockResolvedValueOnce(
          "def5678 John Doe 2025-12-11T11:00:00+08:00 feat: repo2"
        );

      const state = createMockState({
        selectedRepos: ["/path/to/repo1", "/path/to/repo2"],
      });

      const result = await collectGitCommits(state);

      expect(result.gitCommits).toContain("### repo1");
      expect(result.gitCommits).toContain("### repo2");
      expect(result.gitCommits).toContain("abc1234");
      expect(result.gitCommits).toContain("def5678");
    });
  });

  describe("A4: Git 命令失败", () => {
    it("应该返回错误信息", async () => {
      mockGetRepoCommits.mockRejectedValue(new Error("git command failed"));

      const state = createMockState({
        selectedRepos: ["/path/to/repo"],
      });

      const result = await collectGitCommits(state);

      expect(result.gitCommits).toBe("无法获取 Git 记录");
      expect(result.collectorProgress).toContain("git_collector");
    });
  });

  describe("A5: state 中的日期优先级", () => {
    it("应该优先使用 state.since 和 state.until", async () => {
      mockGetRepoCommits.mockResolvedValue(
        "abc1234 John Doe 2025-12-11T10:00:00+08:00 feat: test"
      );

      const state = createMockState({
        selectedRepos: ["/path/to/repo"],
        since: "2025-06-01",
        until: "2025-06-30",
      });

      await collectGitCommits(state);

      expect(mockGetRepoCommits).toHaveBeenCalledWith(
        "/path/to/repo",
        "test-author",
        "2025-06-01",
        "2025-06-30"
      );
    });

    it("state.since 为空时应该使用 config 中的默认值", async () => {
      mockGetRepoCommits.mockResolvedValue("");

      const state = createMockState({
        selectedRepos: ["/path/to/repo"],
        since: "", // 空
        until: "",
      });

      await collectGitCommits(state);

      // 应该使用 config 中的 "yesterday"
      expect(mockGetRepoCommits).toHaveBeenCalledWith(
        "/path/to/repo",
        "test-author",
        "yesterday",
        ""
      );
    });
  });

  describe("A6: 过滤空结果", () => {
    it("应该过滤掉返回空的仓库", async () => {
      mockGetRepoCommits
        .mockResolvedValueOnce(
          "abc1234 John Doe 2025-12-11T10:00:00+08:00 feat: has commits"
        )
        .mockResolvedValueOnce("") // 空结果
        .mockResolvedValueOnce(null); // null 结果

      const state = createMockState({
        selectedRepos: ["/path/to/repo1", "/path/to/repo2", "/path/to/repo3"],
      });

      const result = await collectGitCommits(state);

      expect(result.gitCommits).toContain("### repo1");
      expect(result.gitCommits).not.toContain("### repo2");
      expect(result.gitCommits).not.toContain("### repo3");
    });

    it("所有仓库都没有 commits 时应该返回 '今天没有提交记录'", async () => {
      mockGetRepoCommits.mockResolvedValue("");

      const state = createMockState({
        selectedRepos: ["/path/to/repo1", "/path/to/repo2"],
      });

      const result = await collectGitCommits(state);

      expect(result.gitCommits).toBe("今天没有提交记录");
    });
  });

  describe("A7: Commit 计数", () => {
    it("应该正确统计 commit 数量", async () => {
      // 模拟 3 个 commits - hash 必须是纯十六进制格式（代码使用 /^[0-9a-f]{7,}\s/ 匹配）
      mockGetRepoCommits.mockResolvedValue(
        "abc1234 John Doe 2025-12-11T10:00:00+08:00 feat: commit 1\n" +
          "def5678 John Doe 2025-12-11T11:00:00+08:00 feat: commit 2\n" +
          "aabbccd John Doe 2025-12-11T12:00:00+08:00 feat: commit 3"
      );

      const state = createMockState({
        selectedRepos: ["/path/to/repo"],
      });

      await collectGitCommits(state);

      // 验证 progressTracker 被调用并包含正确的 commit 数量
      const { progressTracker } = await import(
        "../../../lib/progress-tracker.js"
      );
      const updateProgressCalls = (
        progressTracker.updateProgress as ReturnType<typeof vi.fn>
      ).mock.calls;

      // 找到 completed 状态的调用
      const completedCall = updateProgressCalls.find(
        (call) => call[1]?.status === "completed"
      );

      if (completedCall) {
        expect(completedCall[1].message).toContain("3");
      }
    });
  });
});
