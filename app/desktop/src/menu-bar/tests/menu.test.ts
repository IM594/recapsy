import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { menuBarMenu } from '../menu.js';

describe('menuBarMenu', () => {
  const items: MenuItemConstructorOptions[] = menuBarMenu('1.2.3');

  it('shows the version in a disabled item', () => {
    expect(items[0]?.label).toContain('1.2.3');
    expect(items[0]?.enabled).toBe(false);
  });

  it('ends with quit', () => {
    expect(items.at(-1)?.role).toBe('quit');
  });

  it('separates the version from the actions', () => {
    expect(items[1]?.type).toBe('separator');
  });
});
