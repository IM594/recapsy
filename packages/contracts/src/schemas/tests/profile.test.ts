import { describe, expect, it } from 'bun:test';
import { UserProfilePutRequestSchema, UserProfileReadResponseSchema } from '../../index.js';

const validInput = {
  displayName: '  Recapsy User  ',
  aliases: ['  R User  ', 'Recapsy'],
  context: 'Builds privacy-conscious desktop software.',
  locale: 'zh-cn',
  timeZone: 'America/New_York',
};

describe('user profile contracts', () => {
  it('normalizes profile text, locale, aliases, and a DST-observing IANA time zone', () => {
    expect(UserProfilePutRequestSchema.parse(validInput)).toEqual({
      displayName: 'Recapsy User',
      aliases: ['R User', 'Recapsy'],
      context: 'Builds privacy-conscious desktop software.',
      locale: 'zh-CN',
      timeZone: 'America/New_York',
    });
  });

  it('accepts UTC and an empty aliases array', () => {
    const parsed = UserProfilePutRequestSchema.parse({
      ...validInput,
      aliases: [],
      context: undefined,
      timeZone: 'UTC',
    });

    expect(parsed.aliases).toEqual([]);
    expect(parsed.timeZone).toBe('UTC');
    expect(parsed.context).toBeUndefined();
  });

  it('rejects offsets, GMT offsets, and invalid time zones even when Intl is permissive', () => {
    for (const timeZone of ['+08:00', 'GMT+8', 'Mars/Olympus_Mons']) {
      expect(UserProfilePutRequestSchema.safeParse({ ...validInput, timeZone }).success).toBe(
        false,
      );
    }
  });

  it('canonicalizes accepted IANA aliases consistently', () => {
    expect(
      UserProfilePutRequestSchema.parse({ ...validInput, timeZone: 'US/Eastern' }).timeZone,
    ).toBe('America/New_York');
  });

  it('requires the client to provide a time zone and rejects invalid locales', () => {
    const { timeZone: _timeZone, ...withoutTimeZone } = validInput;
    expect(UserProfilePutRequestSchema.safeParse(withoutTimeZone).success).toBe(false);
    expect(
      UserProfilePutRequestSchema.safeParse({ ...validInput, locale: 'not_a_locale' }).success,
    ).toBe(false);
  });

  it('rejects empty and normalized duplicate aliases', () => {
    expect(UserProfilePutRequestSchema.safeParse({ ...validInput, aliases: ['  '] }).success).toBe(
      false,
    );
    expect(
      UserProfilePutRequestSchema.safeParse({ ...validInput, aliases: ['Recapsy', ' recapsy '] })
        .success,
    ).toBe(false);
  });

  it('represents an absent profile explicitly without inventing defaults', () => {
    expect(UserProfileReadResponseSchema.parse({ profile: null })).toEqual({ profile: null });
  });
});
