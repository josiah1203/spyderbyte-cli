import { useRef, useState } from 'react';
import { Badge, Button, Card, Divider, SectionLabel, Textarea } from '../components/primitives';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';
import type { JsonValue } from '../runtime/contracts';

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (value.includes('license_import_not_configured')) {
    return 'License import has not been enabled for this platform deployment.';
  }
  if (value.includes('POLICY_DENIED') || value.toLowerCase().includes('not valid')) {
    return 'The signed license could not be verified. Check the file and try again.';
  }
  return value;
}

export default function License() {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const license = snapshot.license;
  const fileRef = useRef<HTMLInputElement>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string>();

  async function submit(candidate: unknown): Promise<void> {
    if (!runtime.client.post || candidate === null || typeof candidate !== 'object') {
      setMessage('Choose a signed license JSON file or paste its contents first.');
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      await runtime.client.post('/v1/license/import', candidate as JsonValue);
      setPasted('');
      if (fileRef.current) fileRef.current.value = '';
      await runtime.refreshStatus();
      setMessage('License imported and verified.');
    } catch (error) {
      setMessage(safeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      await submit(JSON.parse(await file.text()) as unknown);
    } catch {
      setMessage('The selected file is not valid JSON.');
    }
  }

  async function importPasted(): Promise<void> {
    try {
      await submit(JSON.parse(pasted) as unknown);
    } catch {
      setMessage('Paste a valid signed license JSON envelope.');
    }
  }

  return (
    <div className="page-scroll">
      <div className="page page-narrow stack">
        <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
        <SectionLabel>License</SectionLabel>
        {message && (
          <div className="home-error" role="status">
            {message}
          </div>
        )}
        <Card>
          <div className="license-heading">
            <div>
              <h2>Platform license</h2>
              <div className="license-reason">
                {license?.reason ?? 'Waiting for the license status.'}
              </div>
            </div>
            <Badge color={license?.status === 'valid' ? 'green' : 'amber'}>
              {license?.status ?? 'loading'}
            </Badge>
          </div>
          <Divider />
          <dl className="license-details">
            {[
              ['License ID', license?.licenseId ?? '—'],
              ['Expires', license?.expiresAt ?? '—'],
              ['Checked', snapshot.health ? 'Connected to platform' : '—'],
            ].map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card>
          <div className="card-heading">
            <div>
              <h2>Import a signed license</h2>
              <p>Choose the license file supplied by your platform administrator.</p>
            </div>
          </div>
          <div
            className="license-dropzone"
            data-dragging={dragging}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void importFile(event.dataTransfer.files[0]);
            }}
          >
            <input
              ref={fileRef}
              className="license-file-input"
              type="file"
              accept="application/json,.json"
              onChange={(event) => void importFile(event.target.files?.[0])}
              disabled={busy}
              aria-label="Choose signed license file"
            />
            <strong>Drop a signed license file here</strong>
            <span>
              JSON entitlement files are validated by the platform before they are stored.
            </span>
            <Button variant="secondary" loading={busy} onClick={() => fileRef.current?.click()}>
              Choose license file
            </Button>
          </div>
          <div className="license-paste">
            <Textarea
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder="Optional signed license JSON for hosted deployments"
              rows={5}
              spellCheck={false}
              disabled={busy}
            />
            <Button variant="tertiary" loading={busy} onClick={() => void importPasted()}>
              Import pasted license
            </Button>
          </div>
          <p className="home-card-subtitle">
            License contents are sent only to the platform verifier and cleared after import.
          </p>
        </Card>
        <section>
          <SectionLabel>Cloud services</SectionLabel>
          <Card className="machine-unavailable">
            Cloud execution is not enabled for this platform deployment.
          </Card>
        </section>
      </div>
    </div>
  );
}
