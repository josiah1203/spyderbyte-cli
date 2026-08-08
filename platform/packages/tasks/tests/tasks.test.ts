import { describe, expect, it } from 'vitest';
import { profileDataset, validateDataset } from '../src/index.js';

describe('deterministic dataset tasks', () => {
  it('profiles CSV content with typed columns, PII markers, duplicates, and stable splits', () => {
    const content = [
      'id,email,label',
      '1,a@example.com,yes',
      '2,b@example.com,no',
      '2,b@example.com,no',
    ].join('\n');
    const first = profileDataset(content, { splitSeed: 'fixture-seed' });
    const second = profileDataset(content, { splitSeed: 'fixture-seed' });

    expect(first).toEqual(second);
    expect(first.columns.find((column) => column.name === 'email')).toMatchObject({
      inferredType: 'string',
      pii: true,
    });
    expect(first.duplicateRows).toBe(1);
    expect(first.rowCount).toBe(3);
    expect(first.splitCounts.train + first.splitCounts.validation + first.splitCounts.test).toBe(3);
  });

  it('rejects missing schema and detects duplicate leakage across deterministic splits', () => {
    const rows = ['id,value'];
    for (let index = 0; index < 120; index += 1) rows.push('1,duplicate');
    const result = validateDataset(rows.join('\n'), {
      requiredColumns: ['id', 'label'],
      expectedTypes: { id: 'number' },
      leakageThreshold: 0,
      splitSeed: 'leakage-fixture',
    });

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('Required column is missing: label');
    expect(result.profile.crossSplitDuplicateRows).toBeGreaterThan(0);
    expect(result.violations.some((violation) => violation.includes('leakage'))).toBe(true);
  });
});
