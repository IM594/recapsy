import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('desktop acceptance composition', () => {
  test('constructs one gated publisher and reuses one shell summary per status tick', () => {
    const source = readFileSync(resolve(import.meta.dir, '../electron-entry.ts'), 'utf8');
    const createShellStart = source.indexOf('createShell: (context) => {');
    const createShellEnd = source.indexOf('\n  createStore:', createShellStart);
    const createShellSource = source.slice(createShellStart, createShellEnd);
    const statusSourceStart = createShellSource.indexOf('async getStatus()');
    const statusSource = createShellSource.slice(statusSourceStart);

    expect(createShellStart).toBeGreaterThan(-1);
    expect(createShellEnd).toBeGreaterThan(createShellStart);
    expect(source).toContain("from '../acceptance/index'");
    expect(occurrences(createShellSource, 'createDesktopAcceptancePublisher(')).toBe(1);
    expect(createShellSource.indexOf('createDesktopAcceptancePublisher(')).toBeLessThan(
      statusSourceStart,
    );
    expect(createShellSource).toContain('environment: process.env');
    expect(createShellSource).toContain('isPackaged: app.isPackaged');
    expect(createShellSource).toContain('workspaceIdVerified: context.workspaceIdVerified');

    expect(occurrences(statusSource, 'createSyncQueueSummary(')).toBe(1);
    expect(statusSource).toContain('void acceptancePublisher.tick({');
    expect(statusSource).toContain('capturePauseReasons: [...(snapshot.pauseReasons ?? [])]');
    expect(statusSource).toContain('syncInputPerMinute: sync.inputPerMinute');
    expect(statusSource).toContain('syncWorkerCapacity: sync.workerCapacity');
  });
});

function occurrences(value: string, pattern: string): number {
  return value.split(pattern).length - 1;
}
