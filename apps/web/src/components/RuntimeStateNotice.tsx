import type { ReactElement } from 'react';
import { Badge, Button } from './primitives';
import type { RuntimeConnectionState } from '../runtime/contracts';

export default function RuntimeStateNotice({
  state,
  onRetry,
}: {
  state: RuntimeConnectionState;
  onRetry?: () => void;
}): ReactElement | null {
  if (state === 'connected' || state === 'booting') return null;
  const label =
    state === 'stale'
      ? 'Platform data is catching up'
      : state === 'unauthorized'
        ? 'Session authorization required'
        : state === 'disconnected'
          ? 'Platform disconnected'
          : state === 'error'
            ? 'Platform error'
            : 'Platform unavailable';
  const description =
    state === 'stale'
      ? 'The page is showing the last authoritative snapshot while the platform catches up.'
      : state === 'unauthorized'
        ? 'Reconnect the workspace session before submitting commands.'
        : 'Read and write actions will resume when the platform service is reachable.';
  return (
    <div className="runtime-state-notice" role="status" data-state={state}>
      <div>
        <Badge color={state === 'stale' ? 'amber' : 'gray'}>{label}</Badge>
        <span>{description}</span>
      </div>
      {onRetry && (
        <Button variant="tertiary" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
