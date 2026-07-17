/**
 * macOS Privacy panes for the capture process identity. Deep links open the
 * System Settings / System Preferences privacy panel; they never grant access
 * themselves. Accessibility still requires the user to add the capture app
 * manually (ADR 0009).
 */
export const MACOS_SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export const MACOS_ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

export type PrivacySettingsPane = 'screen_recording' | 'accessibility';

export type OpenExternalUrl = (url: string) => Promise<void>;

export type PrivacySettingsOpener = {
  open(pane: PrivacySettingsPane): Promise<{ opened: true }>;
};

export function createPrivacySettingsOpener(openExternal: OpenExternalUrl): PrivacySettingsOpener {
  return {
    async open(pane) {
      const url =
        pane === 'screen_recording'
          ? MACOS_SCREEN_RECORDING_SETTINGS_URL
          : MACOS_ACCESSIBILITY_SETTINGS_URL;
      await openExternal(url);
      return { opened: true as const };
    },
  };
}
