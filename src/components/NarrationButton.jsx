import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, Spinner, useToast } from './ui.jsx';

/**
 * Read this recap aloud, keep every take, and let the student ask for another.
 *
 * Takes are kept because "make it slower" is only meaningful next to the one
 * that was too fast — being able to play them side by side is the whole point
 * of the revision loop. The backend stores the audio in S3 and the script on
 * the material, so history survives a restart.
 *
 * Audio is fetched as a Blob rather than pointed at with <audio src>: the route
 * is behind the Bearer session and an audio element cannot send a header. Each
 * object URL is revoked when it is replaced and on unmount, so a student who
 * plays six takes does not leak six copies of the audio.
 *
 * The transcript is always available, never optional. Audio with no text
 * alternative is unusable for a deaf student, and it lets anyone check that
 * what was spoken matches their own notes.
 */

const PRESETS = [
  'Say it more slowly and simply.',
  'Focus on the parts most likely to be examined.',
  'Make it shorter — under ninety seconds.',
];

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function duration(seconds) {
  if (!seconds && seconds !== 0) return '';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function NarrationButton({ materialId }) {
  const [available, setAvailable] = useState(false);
  const [takes, setTakes] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [audioUrls, setAudioUrls] = useState({});
  const [loadingAudio, setLoadingAudio] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const urlsRef = useRef({});
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    api.narration.available()
      .then((res) => {
        if (cancelled || !res.available) return undefined;
        setAvailable(true);
        return api.narration.list(materialId)
          .then((r) => { if (!cancelled) setTakes(r.narrations ?? []); })
          .catch(() => undefined);
      })
      .catch(() => { if (!cancelled) setAvailable(false); });
    return () => { cancelled = true; };
  }, [materialId]);

  // One owner for every object URL this component created.
  useEffect(() => () => {
    Object.values(urlsRef.current).forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const latest = takes.length ? takes[takes.length - 1] : null;

  const play = useCallback(async (take) => {
    if (urlsRef.current[take.id] || take.audioFailed) return;
    setLoadingAudio(take.id);
    try {
      const blob = await api.narration.audio(materialId, take.id);
      const url = URL.createObjectURL(blob);
      urlsRef.current[take.id] = url;
      setAudioUrls((prev) => ({ ...prev, [take.id]: url }));
    } catch (err) {
      toast.error(err.message ?? 'Could not load that recording.');
    } finally {
      setLoadingAudio(null);
    }
  }, [materialId, toast]);

  const generate = useCallback(async (text = '') => {
    setBusy(true);
    try {
      const body = text.trim() && latest
        ? { instruction: text.trim(), basedOn: latest.id }
        : {};
      const take = await api.narration.create(materialId, body);
      setTakes((prev) => [...prev, take]);
      setInstruction('');
      setExpanded(take.id);
      setOpen(true);
      if (take.audioFailed) {
        toast.error('The speech model did not answer, so this take is script only.');
      } else {
        play(take);
      }
    } catch (err) {
      toast.error(err.message ?? 'Could not read these notes aloud.');
    } finally {
      setBusy(false);
    }
  }, [latest, materialId, play, toast]);

  const remove = useCallback(async (take) => {
    try {
      await api.narration.remove(materialId, take.id);
      const url = urlsRef.current[take.id];
      if (url) {
        URL.revokeObjectURL(url);
        delete urlsRef.current[take.id];
      }
      setAudioUrls((prev) => {
        const next = { ...prev };
        delete next[take.id];
        return next;
      });
      setTakes((prev) => prev.filter((t) => t.id !== take.id));
    } catch (err) {
      toast.error(err.message ?? 'Could not delete that take.');
    }
  }, [materialId, toast]);

  if (!available) return null;

  return (
    <>
      <div className="narrate-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm narrate-btn"
          onClick={() => (takes.length ? setOpen((v) => !v) : generate())}
          disabled={busy}
          aria-expanded={open}
        >
          {busy ? <Spinner size={16} /> : <Icon name="graphic_eq" size={17} />}
          {busy ? 'Writing the script…' : takes.length ? (open ? 'Hide narration' : `Narration (${takes.length})`) : 'Listen'}
        </button>
      </div>

      {open && takes.length > 0 && (
        <section className="narration" aria-label="Spoken summary">
          <header className="narration-head">
            <span className="narration-wave" aria-hidden="true"><i /><i /><i /><i /></span>
            <div>
              <h3>Spoken summary</h3>
              <p>{takes.length} take{takes.length === 1 ? '' : 's'} · newest last</p>
            </div>
          </header>

          <ol className="narration-takes">
            {takes.map((take, index) => (
              <li key={take.id} className={`narration-take ${take.id === latest?.id ? 'is-latest' : ''}`}>
                <div className="narration-take-head">
                  <span className="narration-take-num">{index + 1}</span>
                  <div className="narration-take-meta">
                    <p className="narration-take-title">
                      {take.instruction ? take.instruction : 'First take'}
                    </p>
                    <p className="narration-take-sub">
                      {relativeTime(take.createdAt)}
                      {take.seconds ? ` · ${duration(take.seconds)}` : ''}
                      {take.scriptModel ? ` · ${take.scriptModel}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => remove(take)}
                    aria-label={`Delete take ${index + 1}`}
                  >
                    <Icon name="delete" size={17} />
                  </button>
                </div>

                {take.audioFailed ? (
                  <p className="narration-note">
                    <Icon name="info" size={15} />
                    The speech model could not be reached for this one — script only.
                  </p>
                ) : audioUrls[take.id] ? (
                  <audio className="narration-audio" controls src={audioUrls[take.id]}>
                    Your browser cannot play audio. The transcript is below.
                  </audio>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm narration-load"
                    onClick={() => play(take)}
                    disabled={loadingAudio === take.id}
                  >
                    {loadingAudio === take.id ? <Spinner size={15} /> : <Icon name="play_arrow" size={17} />}
                    {loadingAudio === take.id ? 'Loading…' : 'Load audio'}
                  </button>
                )}

                <button
                  type="button"
                  className="narration-transcript-toggle"
                  onClick={() => setExpanded((v) => (v === take.id ? null : take.id))}
                  aria-expanded={expanded === take.id}
                >
                  <Icon name={expanded === take.id ? 'expand_less' : 'expand_more'} size={16} />
                  Transcript
                </button>
                {expanded === take.id && <p className="narration-script">{take.script}</p>}
              </li>
            ))}
          </ol>

          <div className="narration-refine">
            <p className="narration-refine-label">Ask for a different take</p>
            <div className="narration-presets">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="narration-preset"
                  onClick={() => generate(preset)}
                  disabled={busy}
                >
                  {preset}
                </button>
              ))}
            </div>
            <form
              className="narration-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (instruction.trim()) generate(instruction);
              }}
            >
              <input
                className="input"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="e.g. slow down and explain the handshake"
                aria-label="How should the narration change?"
                disabled={busy}
              />
              <button className="btn btn-primary btn-sm" disabled={busy || !instruction.trim()}>
                {busy ? <Spinner size={15} /> : <Icon name="send" size={16} />}
                <span className="sr-only">Request a new take</span>
              </button>
            </form>
          </div>
        </section>
      )}
    </>
  );
}
