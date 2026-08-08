import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  SectionLabel,
  Textarea,
} from '../components/primitives';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
  local: true;
}

interface ArtifactUpload {
  stagedUploadId: string;
}

interface ProviderAction {
  providerId: string;
  displayName: string;
  operations: string[];
}

interface LocalBridge {
  bridgeId: string;
  displayName: string;
  operations: string[];
  available: boolean;
  signed: boolean;
  reason?: string;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return globalThis.btoa(binary);
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function Media(): ReactElement {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [language, setLanguage] = useState('');
  const [artifactName, setArtifactName] = useState('');
  const [transcript, setTranscript] = useState('');
  const [result, setResult] = useState<TranscriptionResult>();
  const [artifactId, setArtifactId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [providerActions, setProviderActions] = useState<ProviderAction[]>([]);
  const [bridges, setBridges] = useState<LocalBridge[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [providerMessage, setProviderMessage] = useState<string>();
  const speechReady = snapshot.capabilities?.capabilities['speech-transcription']?.enabled === true;

  useEffect(() => {
    if (!runtime.client.get) return;
    void Promise.all([
      runtime.client.get<ProviderAction[]>('/v1/provider-actions/catalog'),
      runtime.client.get<LocalBridge[]>('/v1/local-bridges/catalog'),
    ])
      .then(([actions, localBridges]) => {
        setProviderActions(actions);
        setBridges(localBridges);
      })
      .catch(() => {
        // Optional provider and bridge runtimes should not block local transcription.
      });
  }, [runtime]);

  async function runProviderAction(providerId: string, operation: string): Promise<void> {
    if (!runtime.client.post || !connectionId.trim()) {
      setProviderMessage(
        'Connect the provider and enter its connection ID before running an action.',
      );
      return;
    }
    try {
      await runtime.client.post('/v1/provider-actions/execute', {
        providerId,
        connectionId: connectionId.trim(),
        operation,
      });
      setProviderMessage(`${operation} completed through ${providerId}.`);
    } catch (error) {
      setProviderMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function runBridge(bridgeId: string): Promise<void> {
    if (!runtime.client.post) return;
    try {
      await runtime.client.post(`/v1/local-bridges/${encodeURIComponent(bridgeId)}/execute`, {
        operation: 'listProjects',
        input: {},
      });
      setProviderMessage(`${bridgeId} returned its project list.`);
    } catch (error) {
      setProviderMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setResult(undefined);
    setTranscript('');
    setArtifactId(undefined);
    setMessage(undefined);
  }

  async function transcribe(): Promise<void> {
    if (!file || !runtime.client.post) {
      setMessage('Choose a local audio file first.');
      return;
    }
    if (!file.type.startsWith('audio/')) {
      setMessage('The local transcription runtime accepts audio files.');
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await runtime.client.post<TranscriptionResult>('/v1/speech/transcriptions', {
        audioBase64: base64(new Uint8Array(await file.arrayBuffer())),
        mimeType: file.type,
        ...(language.trim() ? { language: language.trim() } : {}),
      });
      setResult(result);
      setTranscript(result.text);
      setArtifactName(`${file.name.replace(/\.[^.]+$/, '')} transcript`);
      setMessage('Transcript generated locally. Review it before publishing.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function publishTranscript(): Promise<void> {
    if (!runtime.client.post || !transcript.trim()) {
      setMessage('Generate or write a transcript before publishing.');
      return;
    }
    const actor = snapshot.session?.actor;
    if (!actor) {
      setMessage('The platform session is not ready to publish an artifact.');
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const upload = await runtime.client.post<ArtifactUpload>('/v1/artifacts/uploads', {
        content: transcript,
        mediaType: 'text/plain',
      });
      const id = globalThis.crypto?.randomUUID?.() ?? `transcript-${Date.now()}`;
      await runtime.client.post(`/v1/artifacts/${id}/versions`, {
        stagedUploadId: upload.stagedUploadId,
        mediaType: 'text/plain',
        createdBy: { ...actor },
      });
      setArtifactId(id);
      setMessage('Transcript published as an immutable artifact.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-scroll">
      <div className="page stack">
        <div className="page-heading">
          <div>
            <SectionLabel>Creator workspace</SectionLabel>
            <h1>Media Workspace</h1>
            <p className="page-subtitle">
              Connect approved cloud media services or local editors, transcribe audio locally, and
              publish reproducible transcript artifacts for outlines, captions, or project notes.
            </p>
          </div>
          <Button variant="secondary" onClick={() => navigate('/connections')}>
            Browse media connectors
          </Button>
        </div>
        <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
        {message && (
          <div className="home-error" role="status">
            {message}
          </div>
        )}
        <div className="resource-editor-grid">
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Local transcription</h2>
                <p>Audio stays inside the local Whisper boundary. No hosted fallback is used.</p>
              </div>
              <Badge color={speechReady ? 'green' : 'gray'}>
                {speechReady ? 'Local only' : 'Setup required'}
              </Badge>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="audio/*"
              hidden
              aria-label="Choose an audio file"
              onChange={chooseFile}
            />
            <Button variant="secondary" onClick={() => inputRef.current?.click()}>
              Choose audio file
            </Button>
            <div className="home-state">{file?.name ?? 'No audio selected'}</div>
            <Field label="Language hint" hint="Optional ISO language code, such as en or es.">
              <Input
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                placeholder="Optional"
              />
            </Field>
            <Button
              loading={busy}
              disabled={!file || !speechReady}
              onClick={() => void transcribe()}
            >
              {speechReady ? 'Transcribe locally' : 'Configure transcription'}
            </Button>
            {!speechReady && (
              <div className="home-state">
                Configure a bundled or local Whisper executable in Settings to enable this
                operation. The connector and bridge surfaces remain available below.
              </div>
            )}
            {result && (
              <small>
                {result.language ?? 'Language detected'}
                {result.durationMs === undefined
                  ? ''
                  : ` · ${Math.round(result.durationMs / 1000)}s`}
              </small>
            )}
          </Card>
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Media connections</h2>
                <p>
                  Cloud provider actions and desktop editing adapters are permissioned separately.
                </p>
              </div>
            </div>
            <ul className="connection-operation-list">
              <li>Cloud media APIs use one-click OAuth and explicit operation scopes.</li>
              <li>
                Local editors use signed bridges with list, import, render, and export operations.
              </li>
              <li>
                Large media files remain local until an approved connector operation transfers them.
              </li>
            </ul>
            <Button variant="tertiary" onClick={() => navigate('/connections')}>
              Open connector gallery
            </Button>
          </Card>
        </div>
        <div className="resource-editor-grid">
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Cloud media actions</h2>
                <p>OAuth accounts are required for every provider action.</p>
              </div>
              <Badge color="blue">Scoped actions</Badge>
            </div>
            <Field
              label="Connected account ID"
              hint="Connect Google Drive, YouTube, Frame.io, or GitHub from Connections."
            >
              <Input
                value={connectionId}
                onChange={(event) => setConnectionId(event.target.value)}
                placeholder="connection ID"
              />
            </Field>
            {providerMessage && (
              <div className="home-error" role="status">
                {providerMessage}
              </div>
            )}
            {providerActions.map((action) => (
              <div className="home-list-button" key={action.providerId}>
                <span>
                  <strong>{action.displayName}</strong>
                  <small>{action.operations.join(' · ')}</small>
                </span>
                <Button
                  variant="tertiary"
                  onClick={() =>
                    void runProviderAction(action.providerId, action.operations[0] ?? 'listFiles')
                  }
                >
                  Browse
                </Button>
              </div>
            ))}
            {providerActions.length === 0 && (
              <div className="home-state">Provider actions are not loaded.</div>
            )}
          </Card>
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Desktop editor bridges</h2>
                <p>
                  Premiere, Resolve, Final Cut, and the local media bridge speak an explicit signed
                  JSON protocol.
                </p>
              </div>
              <Button variant="tertiary" onClick={() => navigate('/connections')}>
                Manage bridges
              </Button>
            </div>
            {bridges.map((bridge) => (
              <div className="home-list-button" key={bridge.bridgeId}>
                <span>
                  <strong>{bridge.displayName}</strong>
                  <small>
                    {bridge.signed ? 'Signed package' : (bridge.reason ?? 'Setup required')}
                  </small>
                </span>
                <Button
                  variant="tertiary"
                  disabled={!bridge.available}
                  onClick={() => void runBridge(bridge.bridgeId)}
                >
                  List projects
                </Button>
              </div>
            ))}
            {bridges.length === 0 && (
              <div className="home-state">No local bridge packages are configured.</div>
            )}
          </Card>
        </div>
        <Card className="stack">
          <div className="card-heading">
            <div>
              <h2>Transcript artifact</h2>
              <p>Edit the generated text before making it available to notebooks and workflows.</p>
            </div>
            {artifactId && <Badge color="green">Published</Badge>}
          </div>
          <Field label="Artifact name">
            <Input
              value={artifactName}
              onChange={(event) => setArtifactName(event.target.value)}
              placeholder="Episode transcript"
            />
          </Field>
          <Field label="Transcript">
            <Textarea
              value={transcript}
              onChange={(event) => setTranscript(event.target.value)}
              rows={16}
              placeholder="Your local transcript will appear here."
            />
          </Field>
          <div className="resource-editor-actions">
            <Button
              variant="secondary"
              disabled={!transcript.trim()}
              onClick={() => downloadText(`${artifactName || 'transcript'}.txt`, transcript)}
            >
              Export text
            </Button>
            <Button
              loading={busy}
              disabled={!transcript.trim()}
              onClick={() => void publishTranscript()}
            >
              Publish immutable artifact
            </Button>
          </div>
          {artifactId && <small>Artifact ID: {artifactId}</small>}
        </Card>
      </div>
    </div>
  );
}
