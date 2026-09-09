import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { menuBarMenu } from '../menu.js';

describe('menuBarMenu', () => {
  const items: MenuItemConstructorOptions[] = menuBarMenu('1.2.3');

  it('first item shows the version and is disabled', () => {
    expect(items[0]?.label).toContain('1.2.3');
    expect(items[0]?.enabled).toBe(false);
  });

  it('last item is quit', () => {
    expect(items[items.length - 1]?.role).toBe('quit');
  });

  it('has exactly three items', () => {
    expect(items).toHaveLength(3);
  });
});
