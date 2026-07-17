import { describe, expect, it } from 'bun:test';
import {
  MACOS_ACCESSIBILITY_SETTINGS_URL,
  MACOS_SCREEN_RECORDING_SETTINGS_URL,
  createPrivacySettingsOpener,
} from '../privacy-settings';

describe('privacy settings opener', () => {
  it('opens the screen-recording pane through the injected external opener', async () => {
    const opened: string[] = [];
    const opener = createPrivacySettingsOpener(async (url) => {
      opened.push(url);
    });

    await expect(opener.open('screen_recording')).resolves.toEqual({ opened: true });
    expect(opened).toEqual([MACOS_SCREEN_RECORDING_SETTINGS_URL]);
  });

  it('opens the accessibility pane through the injected external opener', async () => {
    const opened: string[] = [];
    const opener = createPrivacySettingsOpener(async (url) => {
      opened.push(url);
    });

    await expect(opener.open('accessibility')).resolves.toEqual({ opened: true });
    expect(opened).toEqual([MACOS_ACCESSIBILITY_SETTINGS_URL]);
  });
});
