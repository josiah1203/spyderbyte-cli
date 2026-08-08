export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function toUtcInstant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid UTC instant: ${String(value)}`);
  }
  return date.toISOString();
}

export function isUtcInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && toUtcInstant(date) === value;
}

export function compareUtcInstants(left: string, right: string): number {
  return new Date(left).getTime() - new Date(right).getTime();
}
