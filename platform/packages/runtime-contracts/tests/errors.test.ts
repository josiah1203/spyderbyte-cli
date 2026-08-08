import { describe, expect, it } from 'vitest';
import { getErrorDefinition, runtimeError } from '../src/errors.js';

describe('stable error taxonomy', () => {
  it('exposes retry behavior, ownership, and safe user text', () => {
    const error = runtimeError('EXTERNAL_DEPENDENCY_UNAVAILABLE', 'catalog timeout', ['request-1']);
    expect(error.retryable).toBe(true);
    expect(error.owningTier).toBe('control-plane');
    expect(error.userMessage).not.toContain('catalog timeout');
    expect(error.evidence).toEqual(['request-1']);
  });

  it('defines a non-retryable security failure', () => {
    const definition = getErrorDefinition('SECRET_EXPOSURE_BLOCKED');
    expect(definition.category).toBe('secret_handling');
    expect(definition.retryable).toBe(false);
    expect(definition.evidenceRequired).toBe(true);
  });
});
