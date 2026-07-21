import { describe, expect, it } from 'bun:test';
import { CLIENT_SENT_AT_HEADER } from '@recapsy/contracts';
import { createInMemoryTokenStore } from '../../auth/index';
import { assertRendererSafeDto } from '../../ipc/index';
import { ServerApiError, createServerApiClient } from '../client';
import type { ServerApiTransport, ServerApiTransportRequest } from '../types';

const now = '2026-07-06T00:00:00.000Z';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const captureId = '33333333-3333-4333-8333-333333333333';
const assetId = '44444444-4444-4444-8444-444444444444';
const timelineEventId = '55555555-5555-4555-8555-555555555555';
const searchDocumentId = '66666666-6666-4666-8666-666666666666';
const ocrJobId = '77777777-7777-4777-8777-777777777777';
const ocrResultId = '88888888-8888-4888-8888-888888888888';
const policySnapshotId = '99999999-9999-4999-8999-999999999999';
const storagePolicyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('desktop server API client', () => {
  it('fails closed when auth is missing and never exposes a token in the renderer response', async () => {
    const client = createServerApiClient({
      accessTokenProvider: {
        getAccessToken: async () => null,
      },
      endpoint: 'https://api.example.test',
      transport: async () => {
        throw new Error('transport should not be called without auth');
      },
    });

    await expect(
      client.createCapture({
        appName: 'Code',
        asset: createLocalAsset(),
        captureType: 'screen',
        capturedAt: now,
        deviceId: 'device_1',
        idempotencyKey: 'idem_1',
        observedAt: now,
        privacyDecision: createPrivacyDecision(),
        workspaceId,
      }),
    ).rejects.toMatchObject({
      code: 'unauthenticated',
      retryable: false,
      safeMessage: 'Authentication is required.',
    });
  });

  it('accepts the consumer-owned access token provider without depending on an auth token store', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createServerApiClient({
      accessTokenProvider: {
        getAccessToken: async () => 'access-token-secret',
      },
      endpoint: 'https://api.example.test',
      transport: async (request) => {
        calls.push(request);
        return createJsonResponse(createCapabilitiesResponse());
      },
    });

    await expect(client.getCapabilities()).resolves.toMatchObject({ workspaceId });
    expect(calls[0]?.headers.authorization).toBe('Bearer access-token-secret');
  });

  it('stamps every request with the device clock via CLIENT_SENT_AT_HEADER', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createServerApiClient({
      accessTokenProvider: {
        getAccessToken: async () => 'access-token-secret',
      },
      endpoint: 'https://api.example.test',
      now: () => '2026-07-20T08:00:00.000Z',
      transport: async (request) => {
        calls.push(request);
        return createJsonResponse(createCapabilitiesResponse());
      },
    });

    await client.getCapabilities();

    expect(calls[0]?.headers[CLIENT_SENT_AT_HEADER]).toBe('2026-07-20T08:00:00.000Z');
  });

  it('defaults the device clock header to the current time when none is supplied', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createServerApiClient({
      accessTokenProvider: {
        getAccessToken: async () => 'access-token-secret',
      },
      endpoint: 'https://api.example.test',
      transport: async (request) => {
        calls.push(request);
        return createJsonResponse(createCapabilitiesResponse());
      },
    });

    await client.getCapabilities();

    expect(Number.isNaN(Date.parse(calls[0]?.headers[CLIENT_SENT_AT_HEADER] ?? ''))).toBe(false);
  });

  it('passes capture creation idempotency keys through the public API boundary', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async (request) => {
      expect(request.body).toMatchObject({
        idempotencyKey: 'capture-idem-1',
        workspaceId,
      });
      return createJsonResponse(createCaptureCreateResponse());
    });

    const response = await client.createCapture({
      appName: 'Code',
      asset: createLocalAsset(),
      captureType: 'screen',
      capturedAt: now,
      deviceId: 'device_1',
      idempotencyKey: 'capture-idem-1',
      observedAt: now,
      privacyDecision: createPrivacyDecision(),
      workspaceId,
    });

    expect(calls[0]?.path).toBe('/v1/captures');
    expect(calls[0]?.headers.authorization).toBe('Bearer access-token-secret');
    expect(response).toMatchObject({
      captureId,
      inputAssetId: assetId,
      nextAction: 'queue_ocr',
      timelineEventId,
    });
    expect(JSON.stringify(calls)).not.toContain('provider-token');
  });

  it('sends only the fixed OCR input asset shape owned by the client', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async () =>
      createJsonResponse(createCaptureCreateResponse()),
    );

    await client.createCapture(createCaptureCreateInput());

    expect(calls[0]?.body).toMatchObject({
      localAssets: [
        {
          role: 'ocr_input_image',
        },
      ],
    });
    expect(calls[0]?.body).not.toHaveProperty('userId');
  });

  it('rejects retired temporary-upload commands in capture creation responses', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const retiredNextAction = ['create', 'temporary', 'upload'].join('_');
    const client = createClient(calls, async () =>
      createJsonResponse({
        ...createCaptureCreateResponse(),
        nextAction: retiredNextAction,
      }),
    );

    await expect(
      client.createCapture({
        appName: 'Code',
        asset: createLocalAsset(),
        captureType: 'screen',
        capturedAt: now,
        deviceId: 'device_1',
        idempotencyKey: 'capture-idem-1',
        observedAt: now,
        privacyDecision: createPrivacyDecision(),
        workspaceId,
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      retryable: false,
    });
  });

  it('validates capture creation against contracts and rejects missing privacyDecision.decidedAt', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async () => {
      throw new Error('transport should not be called for an invalid contract payload');
    });
    const privacyDecisionWithoutDecidedAt = {
      action: 'allow' as const,
      policyVersion: 'policy_desktop_1',
      reasons: [],
    };

    await expect(
      client.createCapture({
        appName: 'Code',
        asset: createLocalAsset(),
        captureType: 'screen',
        capturedAt: now,
        deviceId: 'device_1',
        idempotencyKey: 'capture-idem-1',
        observedAt: now,
        privacyDecision: privacyDecisionWithoutDecidedAt as never,
        workspaceId,
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      retryable: false,
      safeMessage: 'Request validation failed.',
    });
    expect(calls).toEqual([]);
  });

  it('forwards timeline and search queries as renderer-safe cloud results', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async (request) => {
      if (request.path === '/v1/timeline') {
        expect(request.query).toMatchObject({
          cursor: 'cursor_1',
          limit: '10',
          workspaceId: 'workspace_1',
        });
        return createJsonResponse(createTimelineListResponse());
      }

      expect(request.path).toBe('/v1/search');
      expect(request.query).toMatchObject({
        limit: '5',
        q: 'quarterly plan',
        workspaceId: 'workspace_1',
      });
      return createJsonResponse(createSearchResponse());
    });

    const timeline = await client.queryTimeline({
      cursor: 'cursor_1',
      limit: 10,
      workspaceId: 'workspace_1',
    });
    const search = await client.querySearch({
      limit: 5,
      query: 'quarterly plan',
      workspaceId: 'workspace_1',
    });

    expect(timeline).toEqual({
      incomplete: false,
      items: [
        {
          capturedAt: now,
          id: timelineEventId,
          sourceApp: 'Code',
          title: 'Project notes',
        },
      ],
      nextCursor: 'cursor_2',
    });
    expect(search).toEqual({
      incomplete: false,
      items: [
        {
          capturedAt: now,
          id: searchDocumentId,
          score: 1.2,
          snippet: 'quarterly plan draft',
          sourceApp: 'Code',
          title: 'Project notes',
        },
      ],
      nextCursor: 'cursor_3',
    });
    expect(assertRendererSafeDto(timeline)).toEqual({ ok: true });
    expect(assertRendererSafeDto(search)).toEqual({ ok: true });
  });

  it('reads full policy snapshots in the trusted main-process boundary without exposing secrets', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async (request) => {
      if (request.path === '/v1/capabilities') {
        return createJsonResponse(createCapabilitiesResponse());
      }

      if (request.path === '/v1/capture/policies') {
        expect(request.query).toMatchObject({
          deviceId: 'device_1',
          workspaceId,
        });
        return createJsonResponse(createCapturePoliciesResponse());
      }

      expect(request.path).toBe('/v1/ax/allowlist');
      return createJsonResponse(createAxAllowlistResponse());
    });

    const capabilities = await client.getCapabilities();
    const policies = await client.getCapturePolicies({
      deviceId: 'device_1',
      workspaceId,
    });
    const axAllowlist = await client.getAxAllowlist(workspaceId);
    const serialized = JSON.stringify({ axAllowlist, capabilities, policies });

    expect(capabilities).toMatchObject({
      features: {
        visionOcr: { enabled: true },
      },
      providers: [
        {
          hasSecret: false,
          service: 'ocr',
        },
      ],
      workspaceId,
    });
    expect(policies).toMatchObject({
      capturePolicy: {
        actionCounts: {
          block_ocr: 1,
        },
        axTextUploadEnabled: false,
        version: 'policy_1',
      },
      storagePolicy: {
        authoritativeOriginalLocation: 'local_device',
      },
      workspaceId,
    });
    expect(axAllowlist).toMatchObject({
      axTextUploadEnabled: false,
      enabled: false,
      status: 'disabled',
    });
    expect(policies.capturePolicy.rules).toEqual([
      expect.objectContaining({
        action: 'block_ocr',
        pattern: 'secret.example.test',
      }),
    ]);
    expect(serialized).not.toContain('access-token-secret');
  });

  it('redacts token, full query strings, and provider bodies from server errors', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async () => {
      return createJsonResponse(
        {
          error: {
            code: 'provider.provider_unavailable',
            details: {
              providerResponseBody: 'upstream body with provider-token-secret and OCR words',
            },
            message: 'Provider unavailable for https://api.example.test/v1/search?q=secret',
          },
        },
        503,
      );
    });

    try {
      await client.querySearch({
        limit: 5,
        query: 'secret query',
        workspaceId: 'workspace_1',
      });
      throw new Error('Expected querySearch to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ServerApiError);
      const serialized = JSON.stringify(error);
      expect(serialized).toContain('provider_unavailable');
      expect(serialized).not.toContain('access-token-secret');
      expect(serialized).not.toContain('provider-token-secret');
      expect(serialized).not.toContain('q=secret');
      expect(serialized).not.toContain('OCR words');
    }
  });

  it('does not trust arbitrary server error messages as renderer-safe messages', async () => {
    const leakedText = 'Patient Magnolia Rivera belongs to Project Blue Meridian oncology plan.';
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async () => {
      return createJsonResponse(
        {
          error: {
            code: 'provider.timeout',
            message: leakedText,
          },
        },
        503,
      );
    });

    try {
      await client.querySearch({
        limit: 5,
        query: 'anything',
        workspaceId: 'workspace_1',
      });
      throw new Error('Expected querySearch to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ServerApiError);
      const json = (error as ServerApiError).toJSON();
      const serialized = JSON.stringify(json);

      expect(json).toMatchObject({
        code: 'provider_timeout',
        retryable: true,
        safeMessage: 'Provider timed out.',
      });
      expect(serialized).not.toContain('Magnolia Rivera');
      expect(serialized).not.toContain('Project Blue Meridian');
      expect(serialized).not.toContain('oncology plan');
    }
  });

  it('treats non-retryable semantic server codes as terminal even when the HTTP status is retryable', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async () => {
      return createJsonResponse(
        {
          error: {
            code: 'ocr.provider_not_configured',
            message: 'Provider missing even though this came back as 503.',
          },
        },
        503,
      );
    });

    await expect(
      client.querySearch({
        limit: 5,
        query: 'anything',
        workspaceId: 'workspace_1',
      }),
    ).rejects.toMatchObject({
      code: 'provider_not_configured',
      retryable: false,
    });
  });

  it('parses capture detail responses for OCR reconcile', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async (request) => {
      expect(request.path).toBe('/v1/captures/capture_1');
      expect(request.query).toMatchObject({ workspaceId: 'workspace_1' });
      return createJsonResponse(createCaptureDetailResponse());
    });

    const capture = await client.getCapture('workspace_1', 'capture_1');

    expect(capture).toEqual({
      captureId,
      ocrJobId,
      ocrStatus: 'succeeded',
    });
  });

  it('rejects malformed success responses for every server resource', async () => {
    const malformedResponses: MalformedSuccessResponseScenario[] = [
      {
        createClient: () =>
          createClient([], async () => {
            const response = createCapabilitiesResponse();
            return createJsonResponse({
              ...response,
              features: {
                ...response.features,
                visionOcr: { enabled: 'true' },
              },
            });
          }),
        request: (client: ReturnType<typeof createClient>) => client.getCapabilities(),
      },
      {
        createClient: () =>
          createClient([], async () => {
            const response = createCapturePoliciesResponse();
            return createJsonResponse({
              ...response,
              capturePolicy: {
                ...response.capturePolicy,
                policy: { ...response.capturePolicy.policy, paused: 'true' },
              },
            });
          }),
        request: (client: ReturnType<typeof createClient>) =>
          client.getCapturePolicies({ deviceId: 'device_1', workspaceId }),
      },
      {
        createClient: () =>
          createClient([], async () => {
            const response = createCapturePoliciesResponse();
            return createJsonResponse({
              ...response,
              capturePolicy: {
                ...response.capturePolicy,
                policy: {
                  ...response.capturePolicy.policy,
                  rules: [{ ...response.capturePolicy.policy.rules[0], enabled: 'true' }],
                },
              },
            });
          }),
        request: (client: ReturnType<typeof createClient>) =>
          client.getCapturePolicies({ deviceId: 'device_1', workspaceId }),
      },
      {
        createClient: () =>
          createClient([], async () =>
            createJsonResponse({ ...createAxAllowlistResponse(), enabled: true }),
          ),
        request: (client: ReturnType<typeof createClient>) => client.getAxAllowlist(workspaceId),
      },
      {
        createClient: () =>
          createClient([], async () =>
            createJsonResponse({ ...createCaptureCreateResponse(), syncState: 'invalid' }),
          ),
        request: (client: ReturnType<typeof createClient>) =>
          client.createCapture(createCaptureCreateInput()),
      },
      {
        createClient: () =>
          createClient([], async () => {
            const response = createCaptureDetailResponse();
            return createJsonResponse({
              ...response,
              ocr: { ...response.ocr, resultVersion: '1' },
            });
          }),
        request: (client: ReturnType<typeof createClient>) =>
          client.getCapture(workspaceId, captureId),
      },
      {
        createClient: () =>
          createClient([], async () =>
            createJsonResponse({ ...createTimelineListResponse(), generatedAt: 'not-a-date' }),
          ),
        request: (client: ReturnType<typeof createClient>) => client.queryTimeline({ workspaceId }),
      },
      {
        createClient: () =>
          createClient([], async () =>
            createJsonResponse({ ...createSearchResponse(), modeUsed: 'invalid' }),
          ),
        request: (client: ReturnType<typeof createClient>) =>
          client.querySearch({ query: 'quarterly plan', workspaceId }),
      },
    ];

    for (const scenario of malformedResponses) {
      await expect(scenario.request(scenario.createClient())).rejects.toMatchObject({
        code: 'validation_failed',
        retryable: false,
      });
    }
  });

  it('maps OCR result_invalid server codes without collapsing them to unknown', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async () => {
      return createJsonResponse(
        {
          error: {
            code: 'ocr.result_invalid',
            message: 'OCR output failed semantic validation.',
          },
        },
        400,
      );
    });

    await expect(client.getCapture('workspace_1', 'capture_1')).rejects.toMatchObject({
      code: 'result_invalid',
      retryable: false,
      safeMessage: 'OCR result is invalid.',
    });
  });

  it('runs the OCR proxy with raw bytes and validates the normalized response', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async (request) => {
      expect(request.path).toBe('/v1/ai/ocr');
      expect(request.method).toBe('POST');
      expect(request.body).toBeInstanceOf(Uint8Array);
      expect(request.headers['content-type']).toBe('image/webp');
      expect(request.headers['idempotency-key']).toBe('ocr-operation-1');
      expect(request.query).toMatchObject({ workspaceId });
      return createJsonResponse({
        blocks: [{ order: 0, text: 'quarterly plan draft' }],
        durationMs: 1200,
        model: 'ocr-model-1',
        providerName: 'openai',
        text: 'quarterly plan draft',
      });
    });

    const result = await client.runOcrProxy({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/webp',
      operationKey: 'ocr-operation-1',
      workspaceId,
    });

    expect(result).toEqual({
      blocks: [{ order: 0, text: 'quarterly plan draft' }],
      durationMs: 1200,
      model: 'ocr-model-1',
      providerName: 'openai',
      text: 'quarterly plan draft',
    });
  });

  it('maps proxy rate_limit.exceeded to a retryable throttle instead of a server outage', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async () => {
      return createJsonResponse(
        {
          error: {
            code: 'rate_limit.exceeded',
            message: 'Too many concurrent OCR requests for this user.',
          },
        },
        429,
      );
    });

    await expect(
      client.runOcrProxy({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'image/webp',
        operationKey: 'ocr-operation-1',
        workspaceId,
      }),
    ).rejects.toMatchObject({
      code: 'provider_rate_limited',
      retryable: true,
    });
  });

  it('maps workspace.forbidden to a terminal policy block instead of unknown', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async () => {
      return createJsonResponse(
        {
          error: {
            code: 'workspace.forbidden',
            message: 'Workspace access is forbidden.',
          },
        },
        403,
      );
    });

    await expect(
      client.runOcrProxy({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'image/webp',
        operationKey: 'ocr-operation-1',
        workspaceId,
      }),
    ).rejects.toMatchObject({
      code: 'policy_denied',
      retryable: false,
    });
  });

  it('submits the locally parsed OCR result and validates the summary response', async () => {
    const sourceAssetHash =
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const resultId = '33333333-3333-4333-8333-333333333333';
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async (request) => {
      expect(request.path).toBe('/v1/captures/capture_1/ocr-result');
      expect(request.method).toBe('POST');
      expect(request.body).toMatchObject({
        durationMs: 1200,
        model: 'ocr-model-1',
        providerName: 'openai',
        sourceAssetHash,
        workspaceId,
      });
      return createJsonResponse({
        result: {
          createdAt: now,
          id: resultId,
          qualityFlags: [],
          resultVersion: 1,
          sourceAssetHash,
        },
      });
    });

    const result = await client.submitOcrResult({
      captureId: 'capture_1',
      durationMs: 1200,
      model: 'ocr-model-1',
      providerName: 'openai',
      qualityFlags: [],
      screenText: {
        blocks: [
          { kind: 'text', readingOrder: 0, source: 'image_ocr', text: 'quarterly plan draft' },
        ],
        source: 'image_ocr',
        readingOrder: 'top_to_bottom_left_to_right',
      },
      sourceAssetHash,
      workspaceId,
    });

    expect(result.result).toMatchObject({
      id: resultId,
      resultVersion: 1,
      sourceAssetHash,
    });
  });

  it('rejects an OCR result submission that violates the public contract before any transport call', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async () => {
      throw new Error('transport should not be called for an invalid contract payload');
    });

    await expect(
      client.submitOcrResult({
        captureId: 'capture_1',
        durationMs: 1200,
        model: 'ocr-model-1',
        providerName: 'openai',
        qualityFlags: [],
        screenText: {
          blocks: [
            { kind: 'text', readingOrder: 0, source: 'image_ocr', text: 'quarterly plan draft' },
          ],
          source: 'image_ocr',
          readingOrder: 'top_to_bottom_left_to_right',
        },
        sourceAssetHash: 'short',
        workspaceId,
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      retryable: false,
    });
    expect(calls).toEqual([]);
  });
});

function createClient(calls: ServerApiTransportRequest[], handler: ServerApiTransport) {
  const tokenStore = createInMemoryTokenStore({
    accessToken: 'access-token-secret',
    refreshToken: 'refresh-token-secret',
  });

  return createServerApiClient({
    accessTokenProvider: {
      getAccessToken: async () => (await tokenStore.getTokens())?.accessToken ?? null,
    },
    endpoint: 'https://api.example.test',
    transport: async (request) => {
      calls.push(request);
      return handler(request);
    },
  });
}

function createJsonResponse(body: unknown, status = 200) {
  return {
    body,
    headers: {},
    status,
  };
}

function createLocalAsset() {
  return {
    assetRefId: 'asset_ref_1',
    hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    mimeType: 'image/png',
    sizeBytes: 12,
  };
}

function createCaptureCreateInput() {
  return {
    appName: 'Code',
    asset: createLocalAsset(),
    captureType: 'screen' as const,
    capturedAt: now,
    deviceId: 'device_1',
    idempotencyKey: 'capture-idem-1',
    observedAt: now,
    privacyDecision: createPrivacyDecision(),
    workspaceId,
  };
}

function createPrivacyDecision() {
  return {
    action: 'allow' as const,
    decidedAt: now,
    policyVersion: 'policy_desktop_1',
    reasons: [],
  };
}

function createCapabilitiesResponse() {
  return {
    features: {
      auth: { enabled: true },
      captureCreation: { enabled: true },
      cloudSync: { enabled: false },
      embeddingSearch: { enabled: true },
      hybridSearch: { enabled: false },
      invite: { enabled: true },
      manualSubscription: { enabled: true },
      providerSettings: { enabled: true },
      visionOcr: { enabled: true },
      textSearch: { enabled: true },
    },
    generatedAt: now,
    limits: {},
    providers: [
      {
        enabled: false,
        hasSecret: false,
        reason: 'provider_not_configured',
        service: 'ocr',
      },
    ],
    server: {
      contractVersion: 'v1',
      supportedPlatforms: ['macos'],
    },
    usage: {},
    workspaceId,
  };
}

function createCapturePoliciesResponse() {
  return {
    axAllowlist: {
      axTextUploadEnabled: false,
      enabled: false,
      reason: 'ax_text_upload_disabled',
      status: 'disabled',
    },
    capturePolicy: {
      axAllowlistStatus: 'disabled',
      deviceId: 'device_1',
      expiresAt: '2026-07-06T00:30:00.000Z',
      generatedAt: now,
      id: policySnapshotId,
      metadata: {},
      policy: {
        axTextUploadEnabled: false,
        defaultAction: 'allow',
        paused: false,
        rules: [
          {
            action: 'block_ocr',
            enabled: true,
            id: 'rule_1',
            kind: 'domain',
            pattern: 'secret.example.test',
            scope: 'local_user',
          },
        ],
      },
      ttlSeconds: 1800,
      version: 'policy_1',
      workspaceId,
    },
    deliveryPolicy: {
      maxConcurrentOcr: 2,
    },
    deviceId: 'device_1',
    generatedAt: now,
    storagePolicy: {
      allowLongTermRemoteOriginal: false,
      authoritativeOriginalLocation: 'local_device',
      createdAt: now,
      id: storagePolicyId,
      metadata: {},
      updatedAt: now,
      workspaceId,
    },
    workspaceId,
  };
}

function createAxAllowlistResponse() {
  return {
    axTextUploadEnabled: false,
    enabled: false,
    generatedAt: now,
    policyVersion: 'policy_1',
    reason: 'ax_text_upload_disabled',
    status: 'disabled',
    workspaceId,
  };
}

function createCaptureCreateResponse() {
  return {
    assetLocations: [],
    assets: [
      {
        byteSize: 12,
        contentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        createdAt: now,
        id: assetId,
        metadata: {},
        mimeType: 'image/png',
        processingStatus: 'available',
        privacyLevel: 'normal',
        role: 'ocr_input_image',
        type: 'ocr_input',
        updatedAt: now,
        workspaceId,
      },
    ],
    capture: createCapture(),
    captureAssets: [],
    nextAction: 'queue_ocr',
    policyResult: createPrivacyDecision(),
    syncState: 'synced',
    timelineEvent: createTimelineEvent(),
  };
}

function createCaptureDetailResponse() {
  return {
    assetLocations: [],
    assets: [],
    capture: createCapture(),
    captureAssets: [],
    ocr: {
      jobId: ocrJobId,
      resultId: ocrResultId,
      resultVersion: 1,
      status: 'succeeded',
    },
    search: {
      bodySource: 'screen_text_image_ocr',
      searchDocumentId,
      status: 'indexed',
    },
    timeline: {
      status: 'projected',
      timelineEventId,
    },
  };
}

function createCapture() {
  return {
    appName: 'Code',
    captureStatus: 'ocr_succeeded',
    captureType: 'screen',
    capturedAt: now,
    contextConfidence: 'unknown',
    createdAt: now,
    deviceId: 'device_1',
    id: captureId,
    indexStatus: 'indexed',
    metadata: {},
    observedAt: now,
    ocrStatus: 'succeeded',
    privacyDecision: createPrivacyDecision(),
    sourceType: 'screen_capture',
    timelineStatus: 'projected',
    updatedAt: now,
    workspaceId,
  };
}

function createTimelineListResponse() {
  return {
    events: [createTimelineEvent()],
    generatedAt: now,
    pageInfo: { hasMore: true, nextCursor: 'cursor_2' },
    workspaceId,
  };
}

function createTimelineEvent() {
  return {
    assetAvailability: 'local_device_available',
    context: {
      appName: 'Code',
      contextConfidence: 'unknown',
      documentPathSafe: { displayName: 'notes.md' },
      windowTitleSafe: 'Project notes',
    },
    createdAt: now,
    eventKind: 'capture_updated',
    id: timelineEventId,
    metadata: {},
    occurredAt: now,
    privacyVisibility: 'user_visible',
    sourceCaptureId: captureId,
    sourceType: 'capture',
    statuses: {
      indexStatus: 'indexed',
      ocrStatus: 'succeeded',
      timelineStatus: 'ready',
    },
    updatedAt: now,
    workspaceId,
  };
}

function createSearchResponse() {
  return {
    generatedAt: now,
    indexStatus: 'ready',
    modeRequested: 'text',
    modeUsed: 'text',
    pageInfo: { hasMore: true, nextCursor: 'cursor_3' },
    query: 'quarterly plan',
    results: [
      {
        appName: 'Code',
        assetAvailability: 'local_device_available',
        captureId,
        capturedAt: now,
        indexStatus: 'indexed',
        metadata: {},
        ocrStatus: 'succeeded',
        score: 1.2,
        searchDocumentId,
        snippet: { source: 'screen_text_image_ocr', text: 'quarterly plan draft' },
        syncStatus: 'synced',
        timelineEventId,
        windowTitleSafe: 'Project notes',
      },
    ],
    workspaceId,
  };
}

type MalformedSuccessResponseScenario = {
  createClient: () => ReturnType<typeof createClient>;
  request: (client: ReturnType<typeof createClient>) => Promise<unknown>;
};
