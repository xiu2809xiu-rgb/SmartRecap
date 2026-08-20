import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, Spinner, useToast } from './ui.jsx';

/**
 * Read this recap aloud.
 *
 * The audio arrives base64-encoded in the JSON response rather than as a plain
 * URL, because the endpoint is behind the Bearer session and an <audio src>
 * cannot carry an Authorization header. It is turned into a blob URL here and
 * revoked on unmount, so a student who generates narration for several
 * materials in one sitting does not accumulate megabytes of leaked blobs.
 *
 * The transcript is always shown, never optional. Audio with no text
 * alternative is unusable for a deaf student, and it also lets anyone check
 * that what was spoken matches their own notes.
 */
export default function NarrationButton({ materialId }) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [narration, setNarration] = useState(null);
  const [open, setOpen] = useState(false);
  const audioUrl = useRef(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    api.narration.available()
      .then((res) => { if (!cancelled) setAvailable(Boolean(res.available)); })
      .catch(() => { if (!cancelled) setAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  // One owner for the blob URL, released whenever it is replaced or the panel
  // goes away.
  useEffect(() => () => {
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
  }, []);

  const listen = async () => {
    if (busy) return;
    if (narration) {
      setOpen((value) => !value);
      return;
    }
    setBusy(true);
    try {
      const res = await api.narration.create(materialId);

      if (res.audio) {
        const bytes = Uint8Array.from(atob(res.audio), (c) => c.charCodeAt(0));
        if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
        audioUrl.current = URL.createObjectURL(new Blob([bytes], { type: res.mimeType || 'audio/mpeg' }));
      }
      setNarration({ ...res, url: res.audio ? audioUrl.current : null });
      setOpen(true);
      if (res.audioFailed) {
        toast.error('The speech model did not answer, so this is the script only.');
      }
    } catch (err) {
      toast.error(err.message ?? 'Could not read these notes aloud.');
    } finally {
      setBusy(false);
    }
  };

  if (!available) return null;

  return (
    <>
      <button
        type="button"
        className={`btn btn-ghost btn-sm narrate-btn ${busy ? 'is-working' : ''}`}
        onClick={listen}
        disabled={busy}
        aria-expanded={open}
      >
        {busy ? <Spinner size={16} /> : <Icon name="graphic_eq" size={17} />}
        {busy ? 'Writing the script…' : narration ? (open ? 'Hide narration' : 'Show narration') : 'Listen'}
      </button>

      {open && narration && (
        <section className="narration" aria-label="Spoken summary">
          <header className="narration-head">
            <span className="narration-wave" aria-hidden="true"><i /><i /><i /><i /></span>
            <div>
              <h3>Spoken summary</h3>
              <p>
                Script by {narration.scriptModel}
                {narration.speechModel ? ` · voiced by ${narration.speechModel}` : ''}
              </p>
            </div>
          </header>

          {narration.url ? (
            <audio className="narration-audio" controls src={narration.url}>
              Your browser cannot play audio. The transcript is below.
            </audio>
          ) : (
            <p className="narration-note">
              <Icon name="info" size={15} />
              The speech model could not be reached, so this is the written script only.
            </p>
          )}

          <details className="narration-transcript" open={!narration.url}>
            <summary>Transcript</summary>
            <p>{narration.script}</p>
          </details>
        </section>
      )}
    </>
  );
}
