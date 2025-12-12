import { describe, it, expect, vi, beforeEach } from "vitest";
import { exportMarkdown } from "../export-markdown";
import { createMockState } from "./test-helpers";
import path from "path";

// Mock dependencies
vi.mock("fs/promises", () => ({
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

import fs from "fs/promises";

describe("exportMarkdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("应该成功导出 Markdown 文件", async () => {
    const state = createMockState({
      processedContent: {
        markdownContent: "# 今日工作总结\n\n完成了功能开发。",
      },
      summaryType: "today",
    });

    const result = await exportMarkdown(state);

    expect(fs.mkdir).toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalled();
    expect(result.outputPath).toBeDefined();
    expect(result.outputPath).toContain(".md");
  });

  it("应该根据日期生成文件名", async () => {
    const state = createMockState({
      processedContent: {
        markdownContent: "# 测试总结",
      },
      summaryType: "today",
    });

    const result = await exportMarkdown(state);

    expect(result.outputPath).toContain("summary_");
    expect(result.outputPath).toContain(".md");
  });

  it("应该在文件名中包含日期", async () => {
    const state = createMockState({
      processedContent: {
        markdownContent: "# 测试总结",
      },
    });

    const result = await exportMarkdown(state);

    expect(result.outputPath).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("应该创建输出目录", async () => {
    const state = createMockState({
      processedContent: {
        markdownContent: "# 测试总结",
      },
    });

    await exportMarkdown(state);

    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining("outputs"), {
      recursive: true,
    });
  });

  it("应该写入正确的内容", async () => {
    const markdownContent =
      "# 今日工作总结\n\n## 今日事项\n- 完成功能 A\n- 修复 bug B";

    const state = createMockState({
      processedContent: {
        markdownContent,
      },
    });

    await exportMarkdown(state);

    expect(fs.writeFile).toHaveBeenCalled();
    const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
    const writtenContent = writeCall[1] as string;
    expect(writtenContent).toContain(markdownContent);
  });

  it("应该处理文件写入失败的情况", async () => {
    vi.mocked(fs.writeFile).mockRejectedValueOnce(
      new Error("Permission denied")
    );

    const state = createMockState({
      processedContent: {
        markdownContent: "# 测试总结",
      },
    });

    const result = await exportMarkdown(state);

    expect(result.outputPath).toBe("");
  });

  it("应该处理目录创建失败的情况", async () => {
    vi.mocked(fs.mkdir).mockRejectedValueOnce(new Error("Disk full"));

    const state = createMockState({
      processedContent: {
        markdownContent: "# 测试总结",
      },
    });

    const result = await exportMarkdown(state);

    expect(result.outputPath).toBe("");
  });

  it("应该处理空的 markdown 内容", async () => {
    const state = createMockState({
      processedContent: {
        markdownContent: "",
      },
    });

    const result = await exportMarkdown(state);

    expect(result.outputPath).toBe("");
  });

  it("应该使用正确的输出路径", async () => {
    const state = createMockState({
      processedContent: {
        markdownContent: "# 测试总结",
      },
    });

    await exportMarkdown(state);

    const writeFileCall = vi.mocked(fs.writeFile).mock.calls[0];
    if (writeFileCall) {
      const filePath = writeFileCall[0] as string;

      expect(filePath).toContain("outputs");
      expect(filePath).toMatch(/\.md$/);
    }
  });
});
