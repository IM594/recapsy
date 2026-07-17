/**
 * Minimal 16×16 black PNG used as a macOS menu-bar template icon.
 * Kept as an inlined buffer so packaging does not require a separate asset
 * pipeline for the first tray shell.
 */
const TRAY_ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVR42mNgGJbgPwFMlGZy5QnbQHcD/uMQo58BAxMGFEUjxQlpCAIAu7wn2RVQNowAAAAASUVORK5CYII=',
  'base64',
);

export function createTrayIconPngBuffer(): Buffer {
  return Buffer.from(TRAY_ICON_PNG);
}
