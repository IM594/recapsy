import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const releaseScript = path.join(scriptsDirectory, 'release-macos.ts');

describe('macOS external release contract', () => {
  test('declares signed dual-architecture, notarization, and rollback stages', async () => {
    const result = await runReleaseCommand('plan');

    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(result.stdout) as {
      commands: Record<string, string>;
      requiredExternalInputs: string[];
    };
    expect(plan.commands).toMatchObject({
      assemble: 'release:assemble',
      notarize: 'release:notarize',
      rollback: 'release:verify-rollback',
      stage: 'release:stage',
      verify: 'release:verify',
    });
    expect(plan.requiredExternalInputs).toEqual([
      'RECAPSY_RELEASE_SIGN_IDENTITY',
      'APPLE_NOTARY_KEY',
      'APPLE_NOTARY_KEY_ID',
      'APPLE_NOTARY_ISSUER_ID',
      'RECAPSY_RELEASE_PREVIOUS_VERSION',
    ]);
  });

  test('fails closed before combining arbitrary architecture paths', async () => {
    const result = await runReleaseCommand('assemble');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('RECAPSY_RELEASE_X64_APP is required');
  });

  test('keeps external signing, notarization, and rollback behind a manual workflow', async () => {
    const workflow = await readFile(
      path.resolve(scriptsDirectory, '../../../.github/workflows/external-macos-release.yml'),
      'utf8',
    );

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('runner: macos-14');
    expect(workflow).toContain('runner: macos-13');
    expect(workflow).toContain('release:stage');
    expect(workflow).toContain('release:assemble');
    expect(workflow).toContain('release:notarize');
    expect(workflow).toContain('release:verify');
    expect(workflow).toContain('release:verify-rollback');
    expect(workflow).toContain('APPLE_NOTARY_KEY_P8');
    expect(workflow).toContain('gh release download');
  });
});

async function runReleaseCommand(command: string) {
  const child = Bun.spawn({
    cmd: [process.execPath, releaseScript, command],
    env: { PATH: process.env.PATH ?? '' },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}
