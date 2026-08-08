import {
  newSortableId,
  runtimeError,
  type HashSha256,
  type Id,
} from '@agentic-platform/runtime-contracts';
import { sha256Digest } from './canonical.js';

export interface LocalConfirmationChallenge {
  challengeId: Id;
  actionDigest: HashSha256;
  issuedAt: string;
  expiresAt: string;
}

export interface LocalConfirmationServiceOptions {
  clock?: () => string;
  ttlMs?: number;
}

/**
 * Device-local confirmation is intentionally separate from organization approvals. A challenge
 * binds to the full action digest, expires quickly, and is removed on successful confirmation.
 */
export class LocalConfirmationService {
  private readonly clock: () => string;
  private readonly ttlMs: number;
  private readonly challenges = new Map<Id, LocalConfirmationChallenge>();
  private readonly confirmed = new Map<Id, string>();

  constructor(options: LocalConfirmationServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.ttlMs = options.ttlMs ?? 2 * 60 * 1000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 15 * 60 * 1000) {
      throw new TypeError('Local confirmation TTL must be between 1 second and 15 minutes');
    }
  }

  issue(action: unknown, now = this.clock()): LocalConfirmationChallenge {
    const issuedAt = Date.parse(now);
    if (!Number.isFinite(issuedAt)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Local confirmation timestamp is invalid');
    }
    const challenge: LocalConfirmationChallenge = {
      challengeId: newSortableId(),
      actionDigest: sha256Digest(action),
      issuedAt: now,
      expiresAt: new Date(issuedAt + this.ttlMs).toISOString(),
    };
    this.challenges.set(challenge.challengeId, challenge);
    return structuredClone(challenge);
  }

  confirm(challengeId: Id, action: unknown, now = this.clock()): LocalConfirmationChallenge {
    if (!Number.isFinite(Date.parse(now))) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Local confirmation timestamp is invalid');
    }
    const challenge = this.challenges.get(challengeId);
    if (challenge === undefined) {
      throw runtimeError(
        'LOCAL_CONFIRMATION_REQUIRED',
        'Local confirmation challenge is unknown or already used',
      );
    }
    if (this.confirmed.has(challengeId)) {
      throw runtimeError(
        'LOCAL_CONFIRMATION_REQUIRED',
        'Local confirmation challenge is unknown or already used',
      );
    }
    if (Date.parse(now) >= Date.parse(challenge.expiresAt)) {
      this.challenges.delete(challengeId);
      throw runtimeError('LOCAL_CONFIRMATION_REQUIRED', 'Local confirmation challenge has expired');
    }
    if (sha256Digest(action) !== challenge.actionDigest) {
      throw runtimeError(
        'LOCAL_CONFIRMATION_REQUIRED',
        'Local confirmation does not match the action digest',
      );
    }
    this.confirmed.set(challengeId, now);
    return structuredClone(challenge);
  }

  /** Consume a challenge after the client has confirmed the exact action. */
  consume(challengeId: Id, action: unknown, now = this.clock()): LocalConfirmationChallenge {
    if (!Number.isFinite(Date.parse(now))) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Local confirmation timestamp is invalid');
    }
    const challenge = this.challenges.get(challengeId);
    if (challenge === undefined || !this.confirmed.has(challengeId)) {
      throw runtimeError(
        'LOCAL_CONFIRMATION_REQUIRED',
        'Local confirmation must be confirmed before the action is executed',
      );
    }
    if (Date.parse(now) >= Date.parse(challenge.expiresAt)) {
      this.challenges.delete(challengeId);
      this.confirmed.delete(challengeId);
      throw runtimeError('LOCAL_CONFIRMATION_REQUIRED', 'Local confirmation challenge has expired');
    }
    if (sha256Digest(action) !== challenge.actionDigest) {
      throw runtimeError(
        'LOCAL_CONFIRMATION_REQUIRED',
        'Local confirmation does not match the action digest',
      );
    }
    this.challenges.delete(challengeId);
    this.confirmed.delete(challengeId);
    return structuredClone(challenge);
  }

  get(challengeId: Id): LocalConfirmationChallenge | undefined {
    const challenge = this.challenges.get(challengeId);
    return challenge === undefined ? undefined : structuredClone(challenge);
  }
}
