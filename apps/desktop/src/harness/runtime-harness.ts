import { createDesktopRuntime } from '../runtime/lifecycle-controller';
import type { HelperLifecycle } from '../runtime/types';

export type HarnessHelperCall = 'start' | 'pauseCapture' | 'resumeCapture' | 'shutdown';

export type RuntimeHarness = {
  helper: RecordingHelper;
  runtime: ReturnType<typeof createDesktopRuntime>;
};

export class RecordingHelper implements HelperLifecycle {
  readonly calls: HarnessHelperCall[] = [];

  async start(): Promise<void> {
    this.calls.push('start');
  }

  async pauseCapture(): Promise<void> {
    this.calls.push('pauseCapture');
  }

  async resumeCapture(): Promise<void> {
    this.calls.push('resumeCapture');
  }

  async shutdown(): Promise<void> {
    this.calls.push('shutdown');
  }
}

export function createRuntimeHarness(): RuntimeHarness {
  const helper = new RecordingHelper();

  return {
    helper,
    runtime: createDesktopRuntime({
      helper,
    }),
  };
}
