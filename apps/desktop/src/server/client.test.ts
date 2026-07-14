import { describe, expect, it } from 'bun:test';
import { createInMemoryTokenStore } from '../auth/tokens';
import { assertRendererSafeDto } from '../ipc/dto';
import { ServerApiError, createServerApiClient } from './client';
import type { ServerApiTransport, ServerApiTransportRequest } from './types';

const now = '2026-07-06T00:00:00.000Z';
const workspaceId = '22222222-2222-4222-8222-222222222222';

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
      client.ingestCapture({
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
        return createJsonResponse({
          features: {},
          generatedAt: now,
          providers: [],
          workspaceId,
        });
      },
    });

    await expect(client.getCapabilities()).resolves.toMatchObject({ workspaceId });
    expect(calls[0]?.headers.authorization).toBe('Bearer access-token-secret');
  });

  it('passes capture ingest idempotency keys through the public API boundary', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async (request) => {
      expect(request.body).toMatchObject({
        idempotencyKey: 'capture-idem-1',
        workspaceId,
      });
      return createJsonResponse({
        capture: {
          id: 'capture_1',
          workspaceId,
        },
        assets: [{ id: 'asset_server_1', role: 'ocr_input_image' }],
        nextAction: 'queue_ocr',
        timelineEvent: { id: 'timeline_1' },
      });
    });

    const response = await client.ingestCapture({
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

    expect(calls[0]?.path).toBe('/v1/captures/ingest');
    expect(calls[0]?.headers.authorization).toBe('Bearer access-token-secret');
    expect(response).toMatchObject({
      captureId: 'capture_1',
      inputAssetId: 'asset_server_1',
      nextAction: 'queue_ocr',
      timelineEventId: 'timeline_1',
    });
    expect(JSON.stringify(calls)).not.toContain('provider-token');
  });

  it('rejects retired temporary-upload commands in capture ingest responses', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const retiredNextAction = ['create', 'temporary', 'upload'].join('_');
    const client = createClient(calls, async () =>
      createJsonResponse({
        capture: {
          id: 'capture_1',
          workspaceId,
        },
        assets: [{ id: 'asset_server_1', role: 'ocr_input_image' }],
        nextAction: retiredNextAction,
        timelineEvent: { id: 'timeline_1' },
      }),
    );

    await expect(
      client.ingestCapture({
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

  it('validates capture ingest against contracts and rejects missing privacyDecision.decidedAt', async () => {
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
      client.ingestCapture({
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
        return createJsonResponse({
          events: [
            {
              context: {
                appName: 'Code',
                documentPathSafe: { displayName: 'notes.md' },
                windowTitleSafe: 'Project notes',
              },
              id: 'timeline_1',
              occurredAt: now,
              sourceCaptureId: 'capture_1',
            },
          ],
          pageInfo: { nextCursor: 'cursor_2' },
          workspaceId: 'workspace_1',
        });
      }

      expect(request.path).toBe('/v1/search');
      expect(request.query).toMatchObject({
        limit: '5',
        q: 'quarterly plan',
        workspaceId: 'workspace_1',
      });
      return createJsonResponse({
        pageInfo: { nextCursor: 'cursor_3' },
        query: 'quarterly plan',
        results: [
          {
            appName: 'Code',
            captureId: 'capture_1',
            capturedAt: now,
            score: 1.2,
            searchDocumentId: 'search_1',
            snippet: { text: 'quarterly plan draft', source: 'screen_text_image_ocr' },
            timelineEventId: 'timeline_1',
            windowTitleSafe: 'Project notes',
          },
        ],
        workspaceId: 'workspace_1',
      });
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
          id: 'timeline_1',
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
          id: 'search_1',
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

  it('reads capabilities and policy boundaries without exposing policy patterns or secrets', async () => {
    const calls: ServerApiTransportRequest[] = [];
    const client = createClient(calls, async (request) => {
      if (request.path === '/v1/capabilities') {
        return createJsonResponse({
          features: {
            temporaryOcr: { enabled: true },
            textSearch: { enabled: true },
          },
          generatedAt: now,
          providers: [
            {
              enabled: false,
              hasSecret: false,
              reason: 'provider_not_configured',
              service: 'ocr',
            },
          ],
          workspaceId: 'workspace_1',
        });
      }

      if (request.path === '/v1/capture/policies') {
        expect(request.query).toMatchObject({
          deviceId: 'device_1',
          workspaceId: 'workspace_1',
        });
        return createJsonResponse({
          axAllowlist: {
            axTextUploadEnabled: false,
            enabled: false,
            reason: 'ax_text_upload_disabled',
            status: 'disabled',
          },
          capturePolicy: {
            expiresAt: '2026-07-06T00:30:00.000Z',
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
          },
          generatedAt: now,
          storagePolicy: {
            allowLongTermRemoteOriginal: false,
            authoritativeOriginalLocation: 'local_device',
          },
          workspaceId: 'workspace_1',
        });
      }

      expect(request.path).toBe('/v1/ax/allowlist');
      return createJsonResponse({
        axTextUploadEnabled: false,
        enabled: false,
        generatedAt: now,
        policyVersion: 'policy_1',
        reason: 'ax_text_upload_disabled',
        status: 'disabled',
        workspaceId: 'workspace_1',
      });
    });

    const capabilities = await client.getCapabilities();
    const policies = await client.getCapturePolicies({
      deviceId: 'device_1',
      workspaceId: 'workspace_1',
    });
    const axAllowlist = await client.getAxAllowlist('workspace_1');
    const serialized = JSON.stringify({ axAllowlist, capabilities, policies });

    expect(capabilities).toMatchObject({
      features: {
        temporaryOcr: { enabled: true },
      },
      providers: [
        {
          hasSecret: false,
          service: 'ocr',
        },
      ],
      workspaceId: 'workspace_1',
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
      workspaceId: 'workspace_1',
    });
    expect(axAllowlist).toMatchObject({
      axTextUploadEnabled: false,
      enabled: false,
      status: 'disabled',
    });
    expect(serialized).not.toContain('secret.example.test');
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
      return createJsonResponse({
        assetLocations: [],
        assets: [],
        capture: {
          appName: 'Code',
          captureStatus: 'synced',
          captureType: 'screen',
          capturedAt: now,
          contextConfidence: 'unknown',
          createdAt: now,
          deviceId: 'device_1',
          id: 'capture_1',
          indexStatus: 'indexed',
          metadata: {},
          observedAt: now,
          ocrStatus: 'succeeded',
          privacyDecision: createPrivacyDecision(),
          timelineStatus: 'projected',
          updatedAt: now,
          workspaceId: 'workspace_1',
        },
        captureAssets: [],
        ocr: {
          jobId: 'ocr_job_1',
          resultId: 'ocr_result_1',
          resultVersion: 1,
          status: 'succeeded',
        },
        search: {
          bodySource: 'screen_text_image_ocr',
          searchDocumentId: 'search_1',
          status: 'indexed',
        },
        timeline: {
          status: 'projected',
          timelineEventId: 'timeline_1',
        },
      });
    });

    const capture = await client.getCapture('workspace_1', 'capture_1');

    expect(capture).toEqual({
      captureId: 'capture_1',
      ocrJobId: 'ocr_job_1',
      ocrStatus: 'succeeded',
    });
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
    role: 'ocr_input' as const,
    sizeBytes: 12,
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
