import { EventEmitter } from "events";

export interface ProgressEvent {
  step: string;
  status: "pending" | "running" | "completed" | "error";
  message?: string;
  summary?: string;
  outputPath?: string;
  timestamp: number;
  isCritical?: boolean; // 标记错误是否是致命的
}

class ProgressTracker extends EventEmitter {
  private static instance: ProgressTracker;
  private activeThreads: Map<string, ProgressEvent[]> = new Map();

  private constructor() {
    super();
  }

  static getInstance(): ProgressTracker {
    if (!ProgressTracker.instance) {
      ProgressTracker.instance = new ProgressTracker();
    }
    return ProgressTracker.instance;
  }

  startThread(threadId: string) {
    this.activeThreads.set(threadId, []);
  }

  updateProgress(threadId: string, event: ProgressEvent) {
    const events = this.activeThreads.get(threadId) || [];
    events.push(event);
    this.activeThreads.set(threadId, events);

    // 发送事件
    this.emit(`progress:${threadId}`, event);
    console.log(`[Progress] ${threadId} - ${event.step}: ${event.status}`);
  }

  getProgress(threadId: string): ProgressEvent[] {
    return this.activeThreads.get(threadId) || [];
  }

  endThread(threadId: string) {
    // 保留一段时间后清理
    setTimeout(() => {
      this.activeThreads.delete(threadId);
    }, 60000); // 1分钟后清理
  }
}

export const progressTracker = ProgressTracker.getInstance();
