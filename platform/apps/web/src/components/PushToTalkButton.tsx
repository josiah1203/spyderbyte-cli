import type { KeyboardEvent, PointerEvent } from 'react';
import { IconButton } from './primitives';
import { usePushToTalk } from '../hooks/usePushToTalk';

export default function PushToTalkButton({ onText }: { onText: (text: string) => void }) {
  const voice = usePushToTalk(onText);
  const begin = (event?: PointerEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    event?.preventDefault();
    void voice.start();
  };
  const end = (event?: PointerEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    event?.preventDefault();
    voice.stop();
  };
  return (
    <span className="push-to-talk-control">
      <IconButton
        icon="microphone"
        label={voice.listening ? 'Release to transcribe' : 'Hold to speak'}
        variant={voice.listening ? 'primary' : 'secondary'}
        disabled={voice.transcribing}
        onPointerDown={begin}
        onPointerUp={end}
        onPointerLeave={end}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') begin(event);
        }}
        onKeyUp={(event) => {
          if (event.key === ' ' || event.key === 'Enter') end(event);
        }}
      />
      {voice.transcribing && (
        <>
          <IconButton icon="close" label="Cancel transcription" onClick={voice.cancel} />
          <span className="push-to-talk-status">Transcribing locally…</span>
        </>
      )}
      {voice.listening && <span className="push-to-talk-status">Listening…</span>}
      {voice.error && (
        <button className="push-to-talk-error" type="button" onClick={voice.clearError}>
          {voice.error}
        </button>
      )}
    </span>
  );
}
