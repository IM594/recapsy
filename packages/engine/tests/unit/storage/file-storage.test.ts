import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalFileStorage } from "../../../src/storage/file-storage";
import pino from "pino";

describe("FileStorage", () => {
  let tempDir: string;
  let storage: ReturnType<typeof createLocalFileStorage>;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "recaply-test-"));
    storage = createLocalFileStorage({
      config: { baseDir: tempDir, screenshotsDir: "screenshots", thumbnailsDir: "thumbnails" },
      logger: pino({ level: "silent" }),
    });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("write and read a file", async () => {
    const data = Buffer.from("hello world");
    await storage.write("test/file.txt", data);
    const result = await storage.read("test/file.txt");
    expect(result.toString()).toBe("hello world");
  });

  test("exists returns true for existing file", async () => {
    await storage.write("exists.txt", Buffer.from("x"));
    expect(await storage.exists("exists.txt")).toBe(true);
  });

  test("exists returns false for missing file", async () => {
    expect(await storage.exists("no-such-file.txt")).toBe(false);
  });

  test("delete removes file", async () => {
    await storage.write("to-delete.txt", Buffer.from("bye"));
    expect(await storage.exists("to-delete.txt")).toBe(true);
    await storage.delete("to-delete.txt");
    expect(await storage.exists("to-delete.txt")).toBe(false);
  });

  test("getAbsolutePath returns full path", () => {
    const abs = storage.getAbsolutePath("screenshots/001.webp");
    expect(abs).toBe(join(tempDir, "screenshots/001.webp"));
  });
});
