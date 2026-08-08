import { runtimeError } from '@agentic-platform/runtime-contracts';

export interface PaginationRequest {
  readonly offset: number;
  readonly limit: number;
}

export interface PaginationPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/**
 * Parse the additive cursor pagination parameters used by collection routes.
 * Collection routes retain their historical array response when neither query
 * parameter is present; callers that need bounded reads opt into this envelope.
 */
export function parsePagination(
  rawPath: string,
  maxLimit = MAX_PAGE_LIMIT,
): PaginationRequest | undefined {
  const query = new URL(rawPath, 'http://local').searchParams;
  const cursor = query.get('cursor');
  const limit = query.get('limit');
  if (cursor === null && limit === null) return undefined;

  const offset = parseNonNegativeInteger(cursor ?? '0', 'cursor');
  const pageLimit = parsePositiveInteger(limit ?? String(DEFAULT_PAGE_LIMIT), 'limit');
  if (pageLimit > maxLimit) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `limit must not exceed ${maxLimit}`);
  }
  return { offset, limit: pageLimit };
}

export function paginate<T>(items: readonly T[], request: PaginationRequest): PaginationPage<T> {
  const pageItems = items.slice(request.offset, request.offset + request.limit);
  const nextOffset = request.offset + pageItems.length;
  const hasMore = nextOffset < items.length;
  return {
    items: pageItems,
    hasMore,
    ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
  };
}

function parseNonNegativeInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${name} is outside the safe integer range`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = parseNonNegativeInteger(value, name);
  if (parsed < 1) throw runtimeError('VALIDATION_INVALID_INPUT', `${name} must be positive`);
  return parsed;
}
