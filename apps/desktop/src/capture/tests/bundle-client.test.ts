import { describe, expect, it } from 'bun:test';
import type {
  CaptureHelperClient,
  CaptureHelperCommandClient,
  CaptureHelperTransportObserver,
  HelperEnvelope,
  MainToHelperType,
} from '../../helper/index';
import {
  CaptureBundleError,
  type CaptureBundleValidationAdapter,
  createCaptureBundleClient,
  resolveCaptureBundlePaths,
} from '../bundle-client';

const discardTransportEvents: CaptureHelperTransportObserver = {
  async handle() {},
};

describe('capture bundle layout', () => {
  it('resolves the embedded bundle from Electron resources when packaged', () => {
    expect(
      resolveCaptureBundlePaths({
        isPackaged: true,
        packageRoot: '/Applications/Recapsy Preview.app/Contents/Resources/app.asar',
        resourcesPath: '/Applications/Recapsy Preview.app/Contents/Resources',
      }),
    ).toEqual({
      bundlePath:
        '/Applications/Recapsy Preview.app/Contents/Frameworks/Recapsy Preview Capture.app',
      capturePath:
        '/Applications/Recapsy Preview.app/Contents/Frameworks/Recapsy Preview Capture.app/Contents/MacOS/Recapsy Preview Capture',
      launcherPath:
        '/Applications/Recapsy Preview.app/Contents/Frameworks/Recapsy Preview Capture.app/Contents/MacOS/CaptureLauncher',
    });
  });

  it('resolves the real built bundle from the desktop package during development', () => {
    expect(
      resolveCaptureBundlePaths({
        isPackaged: false,
        packageRoot: '/workspace/apps/desktop',
        resourcesPath: '/electron/Resources',
      }),
    ).toEqual({
      bundlePath: '/workspace/apps/desktop/macos/build/Recapsy Preview Capture.app',
      capturePath:
        '/workspace/apps/desktop/macos/build/Recapsy Preview Capture.app/Contents/MacOS/Recapsy Preview Capture',
      launcherPath:
        '/workspace/apps/desktop/macos/build/Recapsy Preview Capture.app/Contents/MacOS/CaptureLauncher',
    });
  });
});

describe('capture bundle client', () => {
  it('validates identity, executables, and signature before spawning the real bundle', async () => {
    const harness = createHarness();
    const client = createCaptureBundleClient(harness.options);

    await client.start(discardTransportEvents);

    expect(harness.validationCalls).toEqual([
      ['bundle-id', '/workspace/apps/desktop/macos/build/Recapsy Preview Capture.app'],
      [
        'executable',
        '/workspace/apps/desktop/macos/build/Recapsy Preview Capture.app/Contents/MacOS/CaptureLauncher',
      ],
      [
        'executable',
        '/workspace/apps/desktop/macos/build/Recapsy Preview Capture.app/Contents/MacOS/Recapsy Preview Capture',
      ],
      ['signature', '/workspace/apps/desktop/macos/build/Recapsy Preview Capture.app'],
    ]);
    expect(harness.processOptions).toEqual({
      args: [
        '/workspace/apps/desktop/macos/build/Recapsy Preview Capture.app/Contents/MacOS/Recapsy Preview Capture',
      ],
      command:
        '/workspace/apps/desktop/macos/build/Recapsy Preview Capture.app/Contents/MacOS/CaptureLauncher',
      env: { RECAPSY_CAPTURE_ASSET_ROOT: '/assets' },
    });
    expect(harness.processClient.startCalls).toBe(1);
  });

  it('verifies the outer application seal after the nested signature when packaged', async () => {
    const harness = createHarness({ isPackaged: true });
    const client = createCaptureBundleClient(harness.options);

    await client.start(discardTransportEvents);

    expect(harness.validationCalls).toEqual([
      [
        'bundle-id',
        '/Applications/Recapsy Preview.app/Contents/Frameworks/Recapsy Preview Capture.app',
      ],
      [
        'executable',
        '/Applications/Recapsy Preview.app/Contents/Frameworks/Recapsy Preview Capture.app/Contents/MacOS/CaptureLauncher',
      ],
      [
        'executable',
        '/Applications/Recapsy Preview.app/Contents/Frameworks/Recapsy Preview Capture.app/Contents/MacOS/Recapsy Preview Capture',
      ],
      [
        'signature',
        '/Applications/Recapsy Preview.app/Contents/Frameworks/Recapsy Preview Capture.app',
      ],
      ['signature', '/Applications/Recapsy Preview.app'],
    ]);
  });

  it('fails closed before spawn when the frozen bundle id does not match', async () => {
    const harness = createHarness({ bundleId: 'one.recapsy.desktop.capture.changed' });
    const client = createCaptureBundleClient(harness.options);

    await expectRejected(client.start(discardTransportEvents), 'bundle_identity_invalid');

    expect(harness.processOptions).toBeUndefined();
    expect(harness.processClient.startCalls).toBe(0);
  });

  it('fails closed before spawn when either required executable is not executable', async () => {
    const harness = createHarness({ executableResults: [true, false] });
    const client = createCaptureBundleClient(harness.options);

    await expectRejected(client.start(discardTransportEvents), 'bundle_executable_invalid');

    expect(harness.processOptions).toBeUndefined();
  });

  it('fails closed before spawn when codesign verification fails', async () => {
    const harness = createHarness({ signatureValid: false });
    const client = createCaptureBundleClient(harness.options);

    await expectRejected(client.start(discardTransportEvents), 'bundle_signature_invalid');

    expect(harness.processOptions).toBeUndefined();
  });

  it('fails closed when the packaged outer application seal is invalid', async () => {
    const harness = createHarness({ isPackaged: true, signatureResults: [true, false] });
    const client = createCaptureBundleClient(harness.options);

    await expectRejected(client.start(discardTransportEvents), 'application_signature_invalid');

    expect(harness.processOptions).toBeUndefined();
  });

  it('rejects a real bundle that identifies itself as a mock after handshake', async () => {
    const harness = createHarness({ helloMock: true });
    const client = createCaptureBundleClient(harness.options);

    await expectRejected(client.start(discardTransportEvents), 'bundle_protocol_invalid');

    expect(harness.processClient.stopCalls).toBe(1);
  });

  it('uses an explicit custom command without silently consulting the real bundle', async () => {
    const harness = createHarness({
      helloMock: true,
      override: { args: ['src/helper/dev-process.ts'], command: 'bun' },
    });
    const client = createCaptureBundleClient(harness.options);

    await client.start(discardTransportEvents);

    expect(harness.validationCalls).toEqual([]);
    expect(harness.processOptions).toEqual({
      args: ['src/helper/dev-process.ts'],
      command: 'bun',
      env: { RECAPSY_CAPTURE_ASSET_ROOT: '/assets' },
    });
  });

  it('rejects a custom command in a packaged application', async () => {
    const harness = createHarness({
      isPackaged: true,
      override: { args: ['src/helper/dev-process.ts'], command: 'bun' },
    });
    const client = createCaptureBundleClient(harness.options);

    await expectRejected(client.start(discardTransportEvents), 'bundle_override_not_allowed');

    expect(harness.validationCalls).toEqual([]);
    expect(harness.processOptions).toBeUndefined();
  });

  it('maps bundle metadata command failures to a structured identity error', async () => {
    const harness = createHarness({ bundleIdentifierError: true });

    await expectRejected(
      createCaptureBundleClient(harness.options).start(discardTransportEvents),
      'bundle_identity_invalid',
    );

    expect(harness.processOptions).toBeUndefined();
  });

  it('maps codesign command failures to a structured signature error', async () => {
    const harness = createHarness({ signatureError: true });

    await expectRejected(
      createCaptureBundleClient(harness.options).start(discardTransportEvents),
      'bundle_signature_invalid',
    );

    expect(harness.processOptions).toBeUndefined();
  });
});

type HarnessOverrides = {
  bundleId?: string;
  executableResults?: boolean[];
  bundleIdentifierError?: boolean;
  helloMock?: boolean;
  isPackaged?: boolean;
  override?: { command: string; args: string[] };
  signatureError?: boolean;
  signatureResults?: boolean[];
  signatureValid?: boolean;
};

function createHarness(overrides: HarnessOverrides = {}) {
  const validationCalls: Array<[string, string]> = [];
  const executableResults = [...(overrides.executableResults ?? [true, true])];
  const signatureResults = [...(overrides.signatureResults ?? [])];
  const validationAdapter: CaptureBundleValidationAdapter = {
    async readBundleIdentifier(bundlePath) {
      validationCalls.push(['bundle-id', bundlePath]);
      if (overrides.bundleIdentifierError) {
        throw new Error(`raw plist error for ${bundlePath}`);
      }
      return overrides.bundleId ?? 'one.recapsy.desktop.capture';
    },
    async isExecutable(executablePath) {
      validationCalls.push(['executable', executablePath]);
      return executableResults.shift() ?? true;
    },
    async verifyCodeSignature(bundlePath) {
      validationCalls.push(['signature', bundlePath]);
      if (overrides.signatureError) {
        throw new Error(`raw codesign error for ${bundlePath}`);
      }
      return signatureResults.shift() ?? overrides.signatureValid ?? true;
    },
  };
  const processClient = new FakeProcessClient(overrides.helloMock ?? false);
  let processOptions: { args: string[]; command: string; env: NodeJS.ProcessEnv } | undefined;

  return {
    options: {
      captureEnvironment: { RECAPSY_CAPTURE_ASSET_ROOT: '/assets' },
      createProcessClient(options: {
        args: string[];
        command: string;
        env: NodeJS.ProcessEnv;
      }) {
        processOptions = options;
        return processClient;
      },
      isPackaged: overrides.isPackaged ?? false,
      override: overrides.override,
      packageRoot: overrides.isPackaged
        ? '/Applications/Recapsy Preview.app/Contents/Resources/app.asar'
        : '/workspace/apps/desktop',
      resourcesPath: overrides.isPackaged
        ? '/Applications/Recapsy Preview.app/Contents/Resources'
        : '/electron/Resources',
      validationAdapter,
    },
    processClient,
    get processOptions() {
      return processOptions;
    },
    validationCalls,
  };
}

class FakeProcessClient implements CaptureHelperClient, CaptureHelperCommandClient {
  async configureCapture(): Promise<void> {}
  startCalls = 0;
  stopCalls = 0;

  constructor(private readonly helloMock: boolean) {}

  async start(observer: CaptureHelperTransportObserver): Promise<void> {
    this.startCalls += 1;
    await observer.handle({
      envelope: {
        correlationId: null,
        messageId: 'hello_1',
        payload: {
          capabilities: { capture: true, mock: this.helloMock, permissions: true },
          helperVersion: '0.0.1',
          pid: 42,
        },
        protocolVersion: 'recapsy.capture-helper',
        sentAt: '2026-07-15T00:00:00.000Z',
        type: 'helper.hello',
      },
      type: 'envelope',
    });
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
  async beginCapture(_reason: 'runtime_started' | 'user_resumed'): Promise<void> {}
  async pauseCapture(): Promise<void> {}
  async resumeCapture(): Promise<void> {}
  async sendCommand(_command: HelperEnvelope<MainToHelperType>): Promise<void> {}
  async refreshPermissions() {
    return { accessibility: 'unknown' as const, screenRecording: 'unknown' as const };
  }
  async requestScreenRecordingPermission() {
    return { accessibility: 'unknown' as const, screenRecording: 'unknown' as const };
  }
}

async function expectRejected(
  promise: Promise<unknown>,
  code?: CaptureBundleError['code'],
): Promise<void> {
  try {
    await promise;
    throw new Error('expected capture bundle startup to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(CaptureBundleError);
    if (code) {
      expect(error).toMatchObject({ code });
    }
  }
}
