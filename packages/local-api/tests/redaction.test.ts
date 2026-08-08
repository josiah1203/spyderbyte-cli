import { describe, expect, it } from 'vitest';
import { sanitizeDiagnosticValue } from '../src/index.js';

describe('local diagnostic redaction', () => {
  it('redacts secret-shaped keys, assignments, query parameters, and bearer values', () => {
    expect(
      sanitizeDiagnosticValue({
        environment: 'OPENAI_API_KEY=env-secret',
        requestUrl: 'https://provider.example/v1?token=query-secret&keep=1',
        headers: { authorization: 'Bearer bearer-secret' },
        nested: { password: 'field-secret', safe: 'value' },
      }),
    ).toEqual({
      environment: 'OPENAI_API_KEY=[REDACTED]',
      requestUrl: 'https://provider.example/v1?token=[REDACTED]&keep=1',
      headers: { authorization: '[REDACTED]' },
      nested: { password: '[REDACTED]', safe: 'value' },
    });
  });
});
