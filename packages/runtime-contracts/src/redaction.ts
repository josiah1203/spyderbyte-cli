import type { JsonValue } from './json.js';

const secretKey = /(secret|token|password|api[_-]?key|private[_-]?key|authorization|cookie)/i;
const secretValue =
  /(bearer\s+[A-Za-z0-9._~+/=-]+|(?:postgres|mysql|mongodb):\/\/[^\s]+|-----BEGIN [A-Z ]+PRIVATE KEY-----|\b(?:sk|pk|rk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{16,})/gi;
const secretAssignment =
  /(^|[?&#\s"'({[,;_-])((?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret|token|authorization|cookie|private[-_]?key|x-api-key))(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}\])]+)/gi;

export function isSensitiveKey(key: string): boolean {
  return secretKey.test(key);
}

/** Redact common credential-bearing text without changing the surrounding log or URL shape. */
export function redactSecretText(input: string, knownSecrets: readonly string[] = []): string {
  let output = input.replace(secretValue, '[REDACTED]');
  output = output.replace(
    secretAssignment,
    (_match, prefix: string, key: string, separator: string, rawValue: string) => {
      const redactedValue = rawValue.startsWith('"')
        ? '"[REDACTED]"'
        : rawValue.startsWith("'")
          ? "'[REDACTED]'"
          : '[REDACTED]';
      return `${prefix}${key}${separator}${redactedValue}`;
    },
  );
  for (const secret of knownSecrets) {
    if (secret.length > 0) output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

export function redactJsonValue(value: JsonValue, knownSecrets: readonly string[] = []): JsonValue {
  if (typeof value === 'string') return redactSecretText(value, knownSecrets);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, knownSecrets));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        isSensitiveKey(key) ? '[REDACTED]' : redactJsonValue(child, knownSecrets),
      ]),
    ) as JsonValue;
  }
  return value;
}
