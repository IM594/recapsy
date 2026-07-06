export type DesktopConfig = {
  serverEndpoint: string;
};

export type DesktopConfigErrorCode = 'server_endpoint_required' | 'server_endpoint_invalid';

export type DesktopConfigError = {
  code: DesktopConfigErrorCode;
  message: string;
};

export type DesktopConfigInput = {
  serverEndpoint?: string;
  env?: Partial<Record<string, string | undefined>>;
};

export type DesktopConfigResult =
  | {
      ok: true;
      config: DesktopConfig;
    }
  | {
      ok: false;
      error: DesktopConfigError;
    };

export function parseDesktopConfig(input: DesktopConfigInput): DesktopConfigResult {
  const rawEndpoint = input.serverEndpoint ?? input.env?.RECAPSY_SERVER_ENDPOINT;
  const endpoint = rawEndpoint?.trim();

  if (!endpoint) {
    return {
      ok: false,
      error: {
        code: 'server_endpoint_required',
        message: 'Server endpoint is required to start the desktop runtime.',
      },
    };
  }

  try {
    const url = new URL(endpoint);

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return invalidServerEndpoint();
    }

    return {
      ok: true,
      config: {
        serverEndpoint: url.toString(),
      },
    };
  } catch {
    return invalidServerEndpoint();
  }
}

function invalidServerEndpoint(): DesktopConfigResult {
  return {
    ok: false,
    error: {
      code: 'server_endpoint_invalid',
      message: 'Server endpoint must be a valid HTTP or HTTPS URL.',
    },
  };
}
