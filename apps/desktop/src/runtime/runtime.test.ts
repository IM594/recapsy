import { describe, expect, it } from 'bun:test';
import { createRuntimeHarness } from '../harness/runtime-harness';

describe('desktop runtime lifecycle', () => {
  it('enters running after a successful start', async () => {
    const harness = createRuntimeHarness();

    await harness.runtime.start();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(harness.helper.calls).toEqual(['start']);
  });

  it('keeps the runtime running in the menu bar when the last window closes', async () => {
    const harness = createRuntimeHarness();
    await harness.runtime.start();

    await harness.runtime.handleLastWindowClosed();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: true,
    });
    expect(harness.helper.calls).toEqual(['start']);
  });

  it('pauses and resumes capture without stopping the runtime', async () => {
    const harness = createRuntimeHarness();
    await harness.runtime.start();

    await harness.runtime.pause();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      status: 'paused',
      menuBarActive: false,
    });

    await harness.runtime.resume();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      status: 'running',
      menuBarActive: false,
    });
    expect(harness.helper.calls).toEqual(['start', 'pauseCapture', 'resumeCapture']);
  });

  it('shuts the helper down and stops the runtime on quit', async () => {
    const harness = createRuntimeHarness();
    await harness.runtime.start();

    await harness.runtime.requestQuit();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      status: 'stopped',
      menuBarActive: false,
    });
    expect(harness.helper.calls).toEqual(['start', 'shutdown']);
  });
});
