import { describe, expect, it } from 'bun:test';
import { createMockHelperController } from './mock-controller';

describe('mock helper controller', () => {
  it('runs capture.result ack flow after ready', async () => {
    const helper = createMockHelperController();

    await helper.start();
    const result = helper.simulateCapture({
      captureId: 'cap_ack',
      assetRef: 'asset:cap_ack:image',
      manifestRef: 'manifest:cap_ack',
      hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      mimeType: 'image/png',
      sizeBytes: 1024,
      observedAt: '2026-07-06T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    expect(helper.getSnapshot()).toMatchObject({
      state: 'ready',
      pendingCaptureCount: 1,
      acknowledgedCaptureCount: 0,
    });

    const ack = helper.ackCapture('cap_ack');

    expect(ack.ok).toBe(true);
    expect(helper.getSnapshot()).toMatchObject({
      pendingCaptureCount: 0,
      acknowledgedCaptureCount: 1,
    });
  });

  it('does not produce new captures while paused and resumes capture afterwards', async () => {
    const helper = createMockHelperController();
    await helper.start();

    await helper.pauseCapture();
    const pausedCapture = helper.simulateCapture({
      captureId: 'cap_paused',
      assetRef: 'asset:cap_paused:image',
      manifestRef: 'manifest:cap_paused',
      hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      mimeType: 'image/png',
      sizeBytes: 2048,
      observedAt: '2026-07-06T00:00:00.000Z',
    });

    expect(pausedCapture).toEqual({
      ok: false,
      error: {
        code: 'capture_paused',
        message: 'Mock helper is paused and will not produce new captures.',
      },
    });
    expect(helper.getSnapshot()).toMatchObject({
      state: 'paused',
      emittedCaptureCount: 0,
    });

    await helper.resumeCapture();
    const resumedCapture = helper.simulateCapture({
      captureId: 'cap_resumed',
      assetRef: 'asset:cap_resumed:image',
      manifestRef: 'manifest:cap_resumed',
      hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      mimeType: 'image/png',
      sizeBytes: 4096,
      observedAt: '2026-07-06T00:00:01.000Z',
    });

    expect(resumedCapture.ok).toBe(true);
    expect(helper.getSnapshot()).toMatchObject({
      state: 'ready',
      emittedCaptureCount: 1,
    });
  });

  it('treats shutdown as terminal', async () => {
    const helper = createMockHelperController();
    await helper.start();

    await helper.shutdown();
    const result = helper.simulateHeartbeat();

    expect(helper.getSnapshot()).toMatchObject({
      state: 'shutdown',
      terminal: true,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'helper_terminal',
        message: 'Mock helper is terminal and cannot emit new messages.',
      },
    });
  });

  it('tracks crash and helper.exiting states as terminal outcomes', async () => {
    const helper = createMockHelperController();
    await helper.start();

    const exiting = helper.simulateExiting('quit_requested');
    expect(exiting.ok).toBe(true);
    expect(helper.getSnapshot()).toMatchObject({
      state: 'exiting',
      terminal: true,
      lastExitReason: 'quit_requested',
    });

    const crashed = createMockHelperController();
    await crashed.start();
    crashed.simulateCrash('process_crashed');

    expect(crashed.getSnapshot()).toMatchObject({
      state: 'crashed',
      terminal: true,
      lastExitReason: 'process_crashed',
    });
  });

  it('projects capture.result payloads without token, AX text, or local absolute paths', async () => {
    const helper = createMockHelperController();
    await helper.start();

    const result = helper.simulateCapture({
      captureId: 'cap_safe',
      assetRef: '/Users/alice/Pictures/private.png',
      manifestRef: '/private/tmp/private-manifest.json',
      hash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      mimeType: 'image/png',
      sizeBytes: 8192,
      observedAt: '2026-07-06T00:00:00.000Z',
      unsafeContext: {
        appName: 'Notes',
        bundleId: 'com.apple.Notes',
        windowTitle: 'Planning',
        url: 'https://example.test/private?token=query-secret',
        documentPath: '/Users/alice/Documents/plan.md',
        axText: 'full AX text must never upload',
        providerToken: 'provider-secret',
        cloudToken: 'cloud-secret',
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result.envelope.payload);

      expect(serialized).toContain('opaque:');
      expect(serialized).not.toContain('/Users/alice');
      expect(serialized).not.toContain('/private/tmp');
      expect(serialized).not.toContain('full AX text');
      expect(serialized).not.toContain('provider-secret');
      expect(serialized).not.toContain('cloud-secret');
      expect(serialized).not.toContain('query-secret');
    }
  });
});
