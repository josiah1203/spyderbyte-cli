import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/data/profiles';
import { PAGE_REGISTRY, pageAvailability } from '../src/runtime/page-registry';

const connected = {
  connection: 'connected' as const,
  capabilities: {
    capabilities: Object.fromEntries(
      Object.keys(PAGE_REGISTRY).map((page) => [page, { enabled: true }]),
    ),
  },
};

describe('frontend page capability registry', () => {
  it('covers every profile-visible route with a declared definition', () => {
    for (const profile of Object.values(PROFILES)) {
      for (const page of [...profile.nav, ...profile.secondaryNav, ...(profile.adminNav ?? [])]) {
        expect(PAGE_REGISTRY[page], `${profile.id}:${page}`).toBeDefined();
      }
    }
  });

  it('keeps unsupported pages visible but locked with requirements', () => {
    const result = pageAvailability('sql', 'connected', {
      capabilities: {
        queries: { enabled: false, reason: 'query backend unavailable' },
      },
    });
    expect(result.state).toBe('locked');
    expect(result.missing).toContain('queries');
  });

  it('keeps platform navigation discoverable for every dashboard profile', () => {
    const profileIds = Object.values(PROFILES).map((profile) => profile.id);
    expect(PAGE_REGISTRY.sql.profiles).toEqual(profileIds);
    expect(PAGE_REGISTRY.models.profiles).toEqual(profileIds);
    expect(PAGE_REGISTRY.governance.profiles).toEqual(profileIds);
  });

  it('distinguishes booting, disconnected, and enabled states', () => {
    expect(pageAvailability('models', 'booting', undefined).state).toBe('loading');
    expect(pageAvailability('models', 'disconnected', undefined).state).toBe('unavailable');
    expect(pageAvailability('models', connected.connection, { capabilities: {} }).state).toBe(
      'locked',
    );
    expect(
      pageAvailability('models', connected.connection, {
        capabilities: { 'model-runtime': { enabled: true } },
      }).state,
    ).toBe('ready');
  });
});
