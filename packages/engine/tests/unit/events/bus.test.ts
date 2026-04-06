import { describe, expect, test } from "bun:test";
import { createEventBus } from "../../../src/events/bus";

describe("EventBus", () => {
  test("emit and on", () => {
    const bus = createEventBus();
    let received: unknown = null;
    bus.on("db:connected", (data) => {
      received = data;
    });
    bus.emit("db:connected", { url: "ws://localhost" });
    expect(received).toEqual({ url: "ws://localhost" });
  });

  test("off removes listener", () => {
    const bus = createEventBus();
    let count = 0;
    const handler = () => {
      count++;
    };
    bus.on("db:connected", handler);
    bus.emit("db:connected", { url: "ws://localhost" });
    expect(count).toBe(1);

    bus.off("db:connected", handler);
    bus.emit("db:connected", { url: "ws://localhost" });
    expect(count).toBe(1); // still 1
  });

  test("once fires only once", () => {
    const bus = createEventBus();
    let count = 0;
    bus.once("db:disconnected", () => {
      count++;
    });
    bus.emit("db:disconnected", { reason: "test" });
    bus.emit("db:disconnected", { reason: "test" });
    expect(count).toBe(1);
  });
});
