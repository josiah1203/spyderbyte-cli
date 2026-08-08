import { useCallback, useEffect, useRef, useState } from 'react';
import { useRuntime } from '../runtime/RuntimeProvider';

export interface PushToTalkState {
  readonly listening: boolean;
  readonly transcribing: boolean;
  readonly error?: string;
}

export function usePushToTalk(onText: (text: string) => void): PushToTalkState & {
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  clearError: () => void;
} {
  const runtime = useRuntime();
  const onTextRef = useRef(onText);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const transcriptionAbortRef = useRef<AbortController | undefined>(undefined);
  const mountedRef = useRef(true);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      transcriptionAbortRef.current?.abort();
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      chunksRef.current = [];
    };
  }, []);

  const transcribe = useCallback(
    async (blob: Blob): Promise<void> => {
      if (!mountedRef.current) return;
      if (!runtime.client.post) {
        if (mountedRef.current) setError('The connected runtime does not support local speech.');
        return;
      }
      if (blob.size === 0) {
        if (mountedRef.current) setError('No audio was captured. Hold the button while speaking.');
        return;
      }
      const controller = new AbortController();
      transcriptionAbortRef.current = controller;
      setTranscribing(true);
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const result = await runtime.client.post<{ text: string }>(
          '/v1/speech/transcriptions',
          {
            audioBase64: btoa(binary),
            mimeType: blob.type || 'audio/webm',
          },
          { signal: controller.signal },
        );
        const text = result.text.trim();
        if (!text) throw new Error('No speech detected. Try again.');
        onTextRef.current(text);
        if (mountedRef.current) setError(undefined);
      } catch (cause) {
        if (mountedRef.current && !controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (transcriptionAbortRef.current === controller) {
          transcriptionAbortRef.current = undefined;
          if (mountedRef.current) setTranscribing(false);
        }
      }
    },
    [runtime],
  );

  const stop = useCallback((): void => {
    const recorder = recorderRef.current;
    if (recorder === undefined || recorder.state === 'inactive') return;
    recorder.stop();
    setListening(false);
  }, []);

  const cancel = useCallback((): void => {
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = undefined;
    if (mountedRef.current) {
      setTranscribing(false);
      setError(undefined);
    }
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (recorderRef.current?.state === 'recording') return;
    setError(undefined);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice input is not available from this platform connection.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = undefined;
        recorderRef.current = undefined;
        const blob = new Blob(chunksRef.current.splice(0), {
          type: recorder.mimeType || 'audio/webm',
        });
        void transcribe(blob);
      };
      recorderRef.current = recorder;
      recorder.start();
      setListening(true);
    } catch (cause) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = undefined;
      setError(cause instanceof Error ? cause.message : 'Microphone permission was denied.');
    }
  }, [transcribe]);

  return {
    listening,
    transcribing,
    error,
    start,
    stop,
    cancel,
    clearError: () => setError(undefined),
  };
}
