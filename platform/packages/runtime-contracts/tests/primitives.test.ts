import { describe, expect, it } from 'vitest';
import { addMoney, makeMoney, makeQuantity, makeCurrency } from '../src/primitives.js';

describe('contract primitives', () => {
  it('does exact minor-unit money arithmetic', () => {
    expect(addMoney(makeMoney(10, 'USD'), makeMoney(15, 'USD'))).toEqual({
      amountMinor: 25,
      currency: 'USD',
    });
    expect(() => addMoney(makeMoney(10, 'USD'), makeMoney(15, 'EUR'))).toThrow(
      'different currencies',
    );
  });

  it('rejects unsafe or unsupported values', () => {
    expect(() => makeMoney(-1, 'USD')).toThrow();
    expect(() => makeCurrency('usd')).toThrow();
    expect(() => makeQuantity(1.5, 'tokens')).toThrow();
  });
});
