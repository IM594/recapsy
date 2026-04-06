import { EventEmitter } from "node:events";
import type { EngineEventMap } from "./types";

export interface EventBus {
  emit<K extends keyof EngineEventMap>(event: K, data: EngineEventMap[K]): void;
  on<K extends keyof EngineEventMap>(event: K, handler: (data: EngineEventMap[K]) => void): void;
  off<K extends keyof EngineEventMap>(event: K, handler: (data: EngineEventMap[K]) => void): void;
  once<K extends keyof EngineEventMap>(event: K, handler: (data: EngineEventMap[K]) => void): void;
}

export function createEventBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  return {
    emit(event, data) {
      emitter.emit(event as string, data);
    },
    on(event, handler) {
      emitter.on(event as string, handler as (...args: unknown[]) => void);
    },
    off(event, handler) {
      emitter.off(event as string, handler as (...args: unknown[]) => void);
    },
    once(event, handler) {
      emitter.once(event as string, handler as (...args: unknown[]) => void);
    },
  };
}
