import { describe, it, expect } from 'bun:test';
import { sameOrg, assertSameOrg, TenantMismatchError } from '../src/core/index.js';

describe('sameOrg', () => {
  it('matches identical ids', () => {
    expect(sameOrg('org-a', 'org-a')).toBe(true);
  });

  it('does not match different ids', () => {
    expect(sameOrg('org-a', 'org-b')).toBe(false);
  });

  it('matches "no organization" only with "no organization"', () => {
    expect(sameOrg(undefined, undefined)).toBe(true);
    expect(sameOrg('org-a', undefined)).toBe(false);
    expect(sameOrg(undefined, 'org-a')).toBe(false);
  });

  it('is case-sensitive: ids are opaque, not normalized', () => {
    expect(sameOrg('Org-A', 'org-a')).toBe(false);
  });
});

describe('assertSameOrg / TenantMismatchError', () => {
  it('does nothing when the organizations match', () => {
    expect(() => assertSameOrg('org-a', 'org-a', 'nope')).not.toThrow();
    expect(() => assertSameOrg(undefined, undefined, 'nope')).not.toThrow();
  });

  it('throws a TenantMismatchError carrying both ids for host-side logging', () => {
    try {
      assertSameOrg('org-a', 'org-b', 'wrong organization');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TenantMismatchError);
      expect(e).toBeInstanceOf(Error);
      const err = e as TenantMismatchError;
      expect(err.name).toBe('TenantMismatchError');
      expect(err.expectedOrgId).toBe('org-a');
      expect(err.actualOrgId).toBe('org-b');
    }
  });

  it('keeps organization ids out of the message', () => {
    try {
      assertSameOrg('secret-org-1', 'secret-org-2', 'wrong organization');
    } catch (e) {
      expect((e as Error).message).toBe('wrong organization');
      expect((e as Error).message).not.toContain('secret-org');
    }
  });
});
