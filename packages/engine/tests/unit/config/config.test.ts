import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../../src/config";

describe("loadConfig", () => {
  test("returns default values when no overrides", () => {
    const config = loadConfig();
    expect(config.port).toBe(21890);
    expect(config.db.namespace).toBe("recaply");
    expect(config.db.database).toBe("sense");
  });

  test("accepts valid overrides", () => {
    const config = loadConfig({ port: 9999, db: { url: "ws://localhost:9999" } });
    expect(config.port).toBe(9999);
    expect(config.db.url).toBe("ws://localhost:9999");
  });

  test("rejects invalid port", () => {
    expect(() => loadConfig({ port: "not-a-number" })).toThrow();
  });

  test("expands tilde in storage baseDir", () => {
    const config = loadConfig();
    expect(config.storage.baseDir).not.toContain("~");
    expect(config.storage.baseDir).toContain("RecaplySense");
  });
});
