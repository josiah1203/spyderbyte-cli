import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeError } from '@agentic-platform/runtime-contracts';

const execFileAsync = promisify(execFile);

export interface TranscriptionRequest {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly language?: string;
  readonly signal?: AbortSignal;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly language?: string;
  readonly durationMs?: number;
  readonly local: true;
}

export interface WhisperBackend {
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
  /** False means the adapter is present but no executable/model is configured. */
  readonly available?: boolean;
}

export class UnavailableWhisperBackend implements WhisperBackend {
  readonly available = false;

  async transcribe(): Promise<TranscriptionResult> {
    throw runtimeError(
      'COMPUTE_RESOURCE_UNAVAILABLE',
      'The local Whisper runtime is not configured',
    );
  }
}

export class FunctionWhisperBackend implements WhisperBackend {
  readonly available = true;

  constructor(
    private readonly handler: (request: TranscriptionRequest) => Promise<TranscriptionResult>,
  ) {}

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    return this.handler(request);
  }
}

export interface CommandWhisperBackendOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly tempRoot?: string;
  readonly timeoutMs?: number;
}

/** Runs a locally installed/bundled Whisper executable without a network fallback. */
export class CommandWhisperBackend implements WhisperBackend {
  readonly available = true;

  constructor(private readonly options: CommandWhisperBackendOptions) {}

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const directory = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), 'agentic-whisper-'));
    const extension = request.mimeType.split('/')[1]?.replace(/[^a-zA-Z0-9]/g, '') || 'audio';
    const inputPath = join(directory, `input.${extension}`);
    await writeFile(inputPath, request.audio, { mode: 0o600 });
    try {
      const args = (this.options.args ?? ['--input', '%INPUT%', '--output-format', 'json']).map(
        (arg) => arg.replaceAll('%INPUT%', inputPath),
      );
      const result = await execFileAsync(this.options.command, args, {
        timeout: this.options.timeoutMs ?? 120_000,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        maxBuffer: 4 * 1024 * 1024,
      });
      const output = result.stdout.trim();
      let payload: unknown;
      try {
        payload = JSON.parse(output);
      } catch {
        payload = { text: output };
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw runtimeError(
          'COMPUTE_RESOURCE_UNAVAILABLE',
          'Whisper runtime returned invalid output',
        );
      }
      const record = payload as Record<string, unknown>;
      if (typeof record['text'] !== 'string') {
        throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Whisper runtime returned no text');
      }
      return {
        text: record['text'],
        local: true,
        ...(typeof record['language'] === 'string' ? { language: record['language'] } : {}),
        ...(typeof record['durationMs'] === 'number' ? { durationMs: record['durationMs'] } : {}),
      };
    } catch (error) {
      if (request.signal?.aborted) {
        throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Transcription was cancelled');
      }
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export class SpeechTranscriptionService {
  constructor(private readonly backend: WhisperBackend = new UnavailableWhisperBackend()) {}

  get available(): boolean {
    return this.backend.available !== false;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    if (request.audio.byteLength === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Audio input is empty');
    if (request.audio.byteLength > 25 * 1024 * 1024)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Audio input is too large');
    if (!request.mimeType.startsWith('audio/'))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Audio mimeType is required');
    if (request.signal?.aborted)
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Transcription was cancelled');
    const result = await this.backend.transcribe(request);
    if (!result.text.trim())
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'The local Whisper runtime returned no speech',
      );
    return { ...result, text: result.text.trim(), local: true };
  }
}
