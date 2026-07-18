import path from 'node:path';
import type {
  HelperCaptureIdentity,
  HelperCapturePolicy,
  HelperEnvelope,
  MainToHelperType,
} from '../helper/index';
import { createHelperProcessClient } from '../helper/index';
import type {
  CaptureHelperClient,
  CaptureHelperCommandClient,
  CaptureHelperStartOptions,
} from '../helper/index';

export const CAPTURE_BUNDLE_IDENTIFIER = 'one.recapsy.desktop.capture';

export type CaptureBundlePaths = {
  bundlePath: string;
  launcherPath: string;
  capturePath: string;
};

export type CaptureBundleLayoutOptions = {
  isPackaged: boolean;
  packageRoot: string;
  resourcesPath: string;
};

export type CaptureBundleValidationAdapter = {
  readBundleIdentifier(bundlePath: string): Promise<string>;
  isExecutable(executablePath: string): Promise<boolean>;
  verifyCodeSignature(bundlePath: string): Promise<boolean>;
};

export type CaptureProcessLaunch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export type CaptureBundleClientOptions = CaptureBundleLayoutOptions & {
  validationAdapter: CaptureBundleValidationAdapter;
  captureEnvironment?: NodeJS.ProcessEnv;
  override?: { command: string; args?: string[] };
  createProcessClient?: (
    options: CaptureProcessLaunch,
  ) => CaptureHelperClient & CaptureHelperCommandClient;
};

export type CaptureBundleErrorCode =
  | 'application_signature_invalid'
  | 'bundle_identity_invalid'
  | 'bundle_executable_invalid'
  | 'bundle_override_not_allowed'
  | 'bundle_protocol_invalid'
  | 'bundle_signature_invalid';

export class CaptureBundleError extends Error {
  constructor(readonly code: CaptureBundleErrorCode) {
    super(code);
    this.name = 'CaptureBundleError';
  }
}

/**
 * Resolves the two supported capture layouts. Development uses the real bundle
 * built inside this package. A packaged Electron application uses the nested
 * code location reserved for signed child applications, outside app.asar.
 */
export function resolveCaptureBundlePaths(options: CaptureBundleLayoutOptions): CaptureBundlePaths {
  const bundlePath = options.isPackaged
    ? path.resolve(options.resourcesPath, '..', 'Frameworks', 'RecapsyCapture.app')
    : path.join(options.packageRoot, 'macos', 'build', 'Recapsy.app');

  return {
    bundlePath,
    capturePath: path.join(bundlePath, 'Contents', 'MacOS', 'Recapsy'),
    launcherPath: path.join(bundlePath, 'Contents', 'MacOS', 'CaptureLauncher'),
  };
}

/**
 * Owns the trust gate between Electron and the independently signed capture
 * process. The real bundle is never spawned until its frozen identity,
 * executable bits, and code signature have all been verified. An explicit
 * command override is a development escape hatch and is never selected by a
 * fallback.
 */
export function createCaptureBundleClient(
  options: CaptureBundleClientOptions,
): CaptureHelperClient & CaptureHelperCommandClient {
  let processClient: (CaptureHelperClient & CaptureHelperCommandClient) | undefined;

  const getProcessClient = async (): Promise<CaptureHelperClient & CaptureHelperCommandClient> => {
    if (processClient) {
      return processClient;
    }

    if (options.isPackaged && options.override) {
      throw new CaptureBundleError('bundle_override_not_allowed');
    }

    const launch = options.override
      ? {
          args: [...(options.override.args ?? [])],
          command: options.override.command,
          env: { ...options.captureEnvironment },
        }
      : await createValidatedBundleLaunch(options);
    const createProcessClient =
      options.createProcessClient ??
      ((processOptions: CaptureProcessLaunch) => createHelperProcessClient(processOptions));

    processClient = createProcessClient(launch);
    return processClient;
  };

  return {
    async start(startOptions?: CaptureHelperStartOptions): Promise<void> {
      const client = await getProcessClient();
      if (options.override) {
        await client.start(startOptions);
        return;
      }

      let invalidBundleHello = false;
      await client.start({
        ...startOptions,
        onEnvelope: async (envelope) => {
          if (envelope.type === 'helper.hello') {
            const hello = envelope as HelperEnvelope<'helper.hello'>;
            if (hello.payload.capabilities.mock) {
              invalidBundleHello = true;
              return;
            }
          }
          await startOptions?.onEnvelope?.(envelope);
        },
      });

      if (invalidBundleHello) {
        await client.stop();
        throw new CaptureBundleError('bundle_protocol_invalid');
      }
    },
    async stop(): Promise<void> {
      await processClient?.stop();
    },
    async configureCapture(
      policy: HelperCapturePolicy,
      identity?: HelperCaptureIdentity,
    ): Promise<void> {
      const client = await getProcessClient();
      if (!client.configureCapture) {
        throw new Error('capture_helper_policy_configuration_unsupported');
      }
      await client.configureCapture(policy, identity);
    },
    async beginCapture(reason: 'runtime_started' | 'user_resumed'): Promise<void> {
      await processClient?.beginCapture(reason);
    },
    async pauseCapture(): Promise<void> {
      await processClient?.pauseCapture();
    },
    async resumeCapture(): Promise<void> {
      await processClient?.resumeCapture();
    },
    async sendCommand(command: HelperEnvelope<MainToHelperType>): Promise<void> {
      await processClient?.sendCommand(command);
    },
  };
}

async function createValidatedBundleLaunch(
  options: CaptureBundleClientOptions,
): Promise<CaptureProcessLaunch> {
  const paths = resolveCaptureBundlePaths(options);
  let bundleIdentifier: string;

  try {
    bundleIdentifier = await options.validationAdapter.readBundleIdentifier(paths.bundlePath);
  } catch {
    throw new CaptureBundleError('bundle_identity_invalid');
  }

  if (bundleIdentifier !== CAPTURE_BUNDLE_IDENTIFIER) {
    throw new CaptureBundleError('bundle_identity_invalid');
  }

  for (const executablePath of [paths.launcherPath, paths.capturePath]) {
    let executable = false;
    try {
      executable = await options.validationAdapter.isExecutable(executablePath);
    } catch {
      executable = false;
    }
    if (!executable) {
      throw new CaptureBundleError('bundle_executable_invalid');
    }
  }

  let signatureValid = false;
  try {
    signatureValid = await options.validationAdapter.verifyCodeSignature(paths.bundlePath);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw new CaptureBundleError('bundle_signature_invalid');
  }

  if (options.isPackaged) {
    let applicationSignatureValid = false;
    try {
      const outerApplicationPath = path.resolve(options.resourcesPath, '..', '..');
      applicationSignatureValid =
        await options.validationAdapter.verifyCodeSignature(outerApplicationPath);
    } catch {
      applicationSignatureValid = false;
    }
    if (!applicationSignatureValid) {
      throw new CaptureBundleError('application_signature_invalid');
    }
  }

  return {
    args: [paths.capturePath],
    command: paths.launcherPath,
    env: { ...options.captureEnvironment },
  };
}
