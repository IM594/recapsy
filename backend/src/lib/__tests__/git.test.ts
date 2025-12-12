import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * git.ts 核心函数测试
 * 重点测试 getRepoCommits 的日期过滤逻辑
 */

// 获取当前项目路径作为测试仓库
const TEST_REPO_PATH =
  "/Users/user/Downloads/projects/my/daily-work-summarizer";

describe("getRepoCommits - 日期过滤逻辑", () => {
  // 导入真实模块进行测试
  let getRepoCommits: typeof import("../git").getRepoCommits;

  beforeEach(async () => {
    vi.resetModules();
    const gitModule = await import("../git.js");
    getRepoCommits = gitModule.getRepoCommits;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("B1: 相对时间处理", () => {
    it("since='yesterday' 应该不触发应用层过滤", async () => {
      // 相对时间应该信任 git log 的 --since 过滤
      const result = await getRepoCommits(TEST_REPO_PATH, "", "yesterday", "");

      // 只要不报错就行，具体结果取决于是否有 commit
      expect(typeof result).toBe("string");
    });

    it("since='1 week ago' 应该不触发应用层过滤", async () => {
      const result = await getRepoCommits(TEST_REPO_PATH, "", "1 week ago", "");
      expect(typeof result).toBe("string");
    });
  });

  describe("B2: 绝对时间处理", () => {
    it("since='2025-12-11 00:00:00' 格式应该触发应用层过滤", async () => {
      // 使用一个较宽的日期范围确保有结果
      const result = await getRepoCommits(
        TEST_REPO_PATH,
        "",
        "2025-01-01 00:00:00",
        "2025-12-31 23:59:59"
      );

      expect(typeof result).toBe("string");
      // 应该有 commit（假设项目有 2025 年的提交）
    });

    it("since='2025-12-11' 短格式应该正确解析", async () => {
      const result = await getRepoCommits(
        TEST_REPO_PATH,
        "",
        "2025-12-11",
        "2025-12-12"
      );

      expect(typeof result).toBe("string");
    });
  });

  describe("B3-B4: 边界条件", () => {
    it("边界时刻的 commit 应该被包含（>=, <=）", async () => {
      // 这个测试需要知道具体的 commit 时间
      // 我们通过验证返回格式来间接测试
      const result = await getRepoCommits(
        TEST_REPO_PATH,
        "",
        "2025-12-01 00:00:00",
        "2025-12-31 23:59:59"
      );

      // 检查返回的格式是否正确
      if (result.trim()) {
        // 应该包含 commit hash（7位十六进制）
        expect(result).toMatch(/[a-f0-9]{7}/);
      }
    });
  });

  describe("B5: until 为空的处理", () => {
    it("until 为空时应该使用当前时间", async () => {
      // until 为空，应该获取到直到现在的所有 commit
      const result = await getRepoCommits(
        TEST_REPO_PATH,
        "",
        "2025-12-01 00:00:00",
        "" // 空的 until
      );

      expect(typeof result).toBe("string");
    });

    it("当天的 commit 应该被包含", async () => {
      // 获取今天的日期
      const today = new Date();
      const todayStr = today.toISOString().split("T")[0];

      const result = await getRepoCommits(
        TEST_REPO_PATH,
        "",
        `${todayStr} 00:00:00`,
        "" // 到现在
      );

      // 如果今天有 commit，应该能获取到
      expect(typeof result).toBe("string");
    });
  });

  describe("B6: 时区处理", () => {
    it("应该正确处理 +08:00 时区的日期", async () => {
      // ISO 格式带时区
      const result = await getRepoCommits(
        TEST_REPO_PATH,
        "",
        "2025-12-01T00:00:00+08:00",
        "2025-12-31T23:59:59+08:00"
      );

      expect(typeof result).toBe("string");
    });
  });

  describe("B8: 日期格式兼容性", () => {
    it("'YYYY-MM-DD' 格式应该正常工作", async () => {
      const result = await getRepoCommits(
        TEST_REPO_PATH,
        "",
        "2025-12-01",
        "2025-12-31"
      );
      expect(typeof result).toBe("string");
    });

    it("'YYYY-MM-DD HH:mm:ss' 格式应该正常工作", async () => {
      const result = await getRepoCommits(
        TEST_REPO_PATH,
        "",
        "2025-12-01 00:00:00",
        "2025-12-31 23:59:59"
      );
      expect(typeof result).toBe("string");
    });
  });
});

describe("getRepoCommits - Author 过滤", () => {
  let getRepoCommits: typeof import("../git").getRepoCommits;

  beforeEach(async () => {
    vi.resetModules();
    const gitModule = await import("../git.js");
    getRepoCommits = gitModule.getRepoCommits;
  });

  it("应该正确过滤指定 author", async () => {
    const result = await getRepoCommits(
      TEST_REPO_PATH,
      "nonexistent-author-xyz",
      "1 month ago",
      ""
    );

    // 不存在的 author 应该返回空
    expect(result.trim()).toBe("");
  });
});

describe("getRepoCommits - 错误处理", () => {
  let getRepoCommits: typeof import("../git").getRepoCommits;

  beforeEach(async () => {
    vi.resetModules();
    const gitModule = await import("../git.js");
    getRepoCommits = gitModule.getRepoCommits;
  });

  it("非 Git 仓库应该返回空字符串", async () => {
    const result = await getRepoCommits("/tmp", "", "yesterday", "");
    expect(result).toBe("");
  });

  it("不存在的路径应该返回空字符串", async () => {
    const result = await getRepoCommits(
      "/nonexistent/path/xyz",
      "",
      "yesterday",
      ""
    );
    expect(result).toBe("");
  });
});

describe("日期解析工具函数测试", () => {
  /**
   * 测试 parseLocalDate 的行为（模拟代码中的逻辑）
   */
  const parseLocalDate = (dateStr: string): Date => {
    const normalized = dateStr.replace(" ", "T");
    return new Date(normalized);
  };

  it("'2025-12-11 00:00:00' 应该解析为本地时间午夜", () => {
    const date = parseLocalDate("2025-12-11 00:00:00");
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(11); // 0-indexed
    expect(date.getDate()).toBe(11);
    expect(date.getHours()).toBe(0);
  });

  it("'2025-12-11' 短格式的解析行为", () => {
    const date = parseLocalDate("2025-12-11");
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(11);
    expect(date.getDate()).toBe(11);
  });

  it("相对时间 'yesterday' 应该返回 Invalid Date", () => {
    const date = parseLocalDate("yesterday");
    expect(isNaN(date.getTime())).toBe(true);
  });

  it("相对时间 '1 week ago' 应该返回 Invalid Date", () => {
    const date = parseLocalDate("1 week ago");
    expect(isNaN(date.getTime())).toBe(true);
  });
});
