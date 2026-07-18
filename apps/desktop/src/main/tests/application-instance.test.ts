import { describe, expect, it } from 'bun:test';
import { startDesktopSingleInstance } from '../application-instance';

describe('desktop single-instance boundary', () => {
  it('quits a secondary process before constructing the desktop runtime', () => {
    let quitCalls = 0;
    let runtimeStarts = 0;
    const listeners: Array<() => void> = [];

    const result = startDesktopSingleInstance({
      app: {
        on(_event, listener) {
          listeners.push(listener);
        },
        quit() {
          quitCalls += 1;
        },
        requestSingleInstanceLock() {
          return false;
        },
      },
      onSecondInstance() {},
      start() {
        runtimeStarts += 1;
        return { id: 'runtime' };
      },
    });

    expect(result).toBeUndefined();
    expect(quitCalls).toBe(1);
    expect(runtimeStarts).toBe(0);
    expect(listeners).toEqual([]);
  });

  it('constructs one primary runtime and routes later launches to it', () => {
    const calls: string[] = [];
    let secondInstanceListener: (() => void) | undefined;

    const runtime = startDesktopSingleInstance<{ id: string }>({
      app: {
        on(event, listener) {
          expect(event).toBe('second-instance');
          secondInstanceListener = listener;
        },
        quit() {
          calls.push('quit');
        },
        requestSingleInstanceLock() {
          calls.push('lock');
          return true;
        },
      },
      onSecondInstance(activeRuntime) {
        calls.push(`focus:${activeRuntime.id}`);
      },
      start() {
        calls.push('start');
        return { id: 'runtime' };
      },
    });

    secondInstanceListener?.();

    expect(runtime).toEqual({ id: 'runtime' });
    expect(calls).toEqual(['lock', 'start', 'focus:runtime']);
  });
});
