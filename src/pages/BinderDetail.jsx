import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, pollJob } from '../lib/api.js';
import { useToast, Icon, Empty, Spinner, Modal, ProgressBar } from '../components/ui.jsx';
import { formatBytes, relativeDay } from '../lib/format.js';
import './binders.css';

const UNSETTLED = new Set(['pending', 'processing']);
const POLL_MS = 2000;

/**
 * A binder's source list, upload zone, and the Generate action.
 *
 * Ingestion is fully async: uploading returns as soon as the presigned URL is
 * handed out, and every source shows Processing until its own extraction
 * settles. Rather than one poll loop for the whole page, each still-unsettled
 * source is polled independently on the same 2s cadence — a source that
 * finishes early stops being polled immediately instead of waiting for its
 * slowest sibling.
 */
export default function BinderDetail() {
  const { id: binderId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [binder, setBinder] = useState(null);
  const [sources, setSources] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [renamingBinder, setRenamingBinder] = useState(false);
  const [binderNameDraft, setBinderNameDraft] = useState('');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDeleteSource, setConfirmDeleteSource] = useState(null);
  const [confirmDeleteBinder, setConfirmDeleteBinder] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateJob, setGenerateJob] = useState(null);
  const inputRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([api.binders.get(binderId), api.sources.list(binderId)]);
      setBinder(b);
      setSources(s ?? []);
      setStatus('ready');
    } catch (e) {
      toast.error(e.message ?? 'Could not load that binder.');
      setStatus('error');
    }
  }, [binderId, toast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /* --------------------------------------------------------- status polling */

  useEffect(() => {
    const unsettledIds = sources.filter((s) => UNSETTLED.has(s.status)).map((s) => s.id);
    if (!unsettledIds.length) return undefined;

    let cancelled = false;
    const controller = new AbortController();

    const tick = async () => {
      const results = await Promise.all(
        unsettledIds.map(async (sourceId) => {
          try {
            return await api.sources.status(sourceId, controller.signal);
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      setSources((list) =>
        list.map((s) => {
          const found = results.find((r) => r?.id === s.id);
          return found ? { ...s, ...found } : s;
        }),
      );
    };

    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
    // Re-derives its own dependency (unsettledIds) from `sources` on every
    // change, which is what lets a newly-settled source drop out of polling
    // on the next render rather than the next full-page refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources.map((s) => `${s.id}:${s.status}`).join(',')]);

  /* -------------------------------------------------------------- favourite */

  const toggleFavourite = async () => {
    const next = !binder.isFavourite;
    setBinder((b) => ({ ...b, isFavourite: next }));
    try {
      const updated = await api.binders.update(binderId, { isFavourite: next });
      setBinder((b) => ({ ...b, ...updated }));
    } catch (e) {
      setBinder((b) => ({ ...b, isFavourite: !next }));
      toast.error(e.message ?? 'Could not update that binder.');
    }
  };

  /* ------------------------------------------------------------- rename */

  const startRenameBinder = () => {
    setBinderNameDraft(binder.name);
    setRenamingBinder(true);
  };

  const saveBinderName = async () => {
    const name = binderNameDraft.trim();
    setRenamingBinder(false);
    if (!name || name === binder.name) return;
    setBinder((b) => ({ ...b, name }));
    try {
      const updated = await api.binders.update(binderId, { name });
      setBinder((b) => ({ ...b, ...updated }));
    } catch (e) {
      toast.error(e.message ?? 'Could not rename that binder.');
      refresh();
    }
  };

  /* -------------------------------------------------------------- upload */

  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    setUploading(true);

    try {
      const { created, rejected } = await api.sources.create(
        binderId,
        files.map((f) => ({ fileName: f.name, sizeBytes: f.size })),
      );

      for (const r of rejected) toast.error(`${r.fileName}: ${r.reason}`);

      if (created.length) {
        // Optimistic: sourceCount and the new rows appear immediately, before
        // any byte has left the browser.
        setSources((list) => [...list, ...created.map(({ uploadUrl, ...s }) => s)]);
        setBinder((b) => ({ ...b, sourceCount: (b?.sourceCount ?? 0) + created.length }));
      }

      // Each file uploads and commits independently, so one bad connection
      // does not stop the rest of the batch.
      await Promise.all(
        created.map(async (source, i) => {
          try {
            if (source.uploadUrl) await api.sources.put(source.uploadUrl, files[files.findIndex((f) => f.name === source.originalFilename)] ?? files[i]);
            const committed = await api.sources.commit(binderId, source.id);
            setSources((list) => list.map((s) => (s.id === source.id ? { ...s, ...committed } : s)));
          } catch (e) {
            toast.error(`${source.displayName}: ${e.message ?? 'Upload failed.'}`);
            setSources((list) => list.map((s) => (s.id === source.id ? { ...s, status: 'failed', errorMessage: e.message } : s)));
          }
        }),
      );
    } catch (e) {
      toast.error(e.message ?? 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    uploadFiles(e.dataTransfer.files);
  };

  /* -------------------------------------------------------------- retry */

  const retrySource = async (source) => {
    setSources((list) => list.map((s) => (s.id === source.id ? { ...s, status: 'processing', errorMessage: null } : s)));
    try {
      const updated = await api.sources.retry(binderId, source.id);
      setSources((list) => list.map((s) => (s.id === source.id ? { ...s, ...updated } : s)));
    } catch (e) {
      toast.error(e.message ?? 'Could not retry that source.');
      refresh();
    }
  };

  /* -------------------------------------------------------------- delete */

  const removeSource = async () => {
    const source = confirmDeleteSource;
    setConfirmDeleteSource(null);
    setSources((list) => list.filter((s) => s.id !== source.id));
    setBinder((b) => ({ ...b, sourceCount: Math.max(0, (b?.sourceCount ?? 1) - 1) }));
    try {
      await api.sources.remove(source.id);
    } catch (e) {
      toast.error(e.message ?? 'Could not delete that source.');
      refresh();
    }
  };

  const removeBinder = async () => {
    setConfirmDeleteBinder(false);
    try {
      await api.binders.remove(binderId);
      toast.success(`"${binder.name}" was deleted.`);
      navigate('/app/binders');
    } catch (e) {
      toast.error(e.message ?? 'Could not delete that binder.');
    }
  };

  /* ------------------------------------------------------------ generate */

  const readyCount = sources.filter((s) => s.status === 'ready').length;
  const unsettledCount = sources.filter((s) => UNSETTLED.has(s.status)).length;
  const canGenerate = readyCount > 0 && !generating;

  const generate = async () => {
    setGenerating(true);
    setGenerateJob({ progress: 0, stageLabel: 'Starting…' });
    try {
      const { jobId } = await api.binders.generate(binderId);
      const job = await pollJob(jobId, setGenerateJob);
      if (job.status === 'ready') {
        toast.success('Recap ready.');
        await refresh();
        navigate(`/app/binders/${binderId}/recap`);
      }
    } catch (e) {
      toast.error(e.message ?? 'Generation failed.');
    } finally {
      setGenerating(false);
      setGenerateJob(null);
    }
  };

  if (status === 'loading') {
    return (
      <div className="shell binders-loading" role="status">
        <Spinner size={22} />
        <span>Loading binder…</span>
      </div>
    );
  }
  if (status === 'error' || !binder) {
    return (
      <div className="shell">
        <Empty icon="error" title="Could not load this binder" body="It may have been deleted." />
      </div>
    );
  }

  return (
    <div className="shell binder-detail">
      <header className="binder-detail-head">
        <div className="grow">
          <Link to="/app/binders" className="btn btn-ghost btn-sm">
            <Icon name="arrow_back" size={16} />
            All binders
          </Link>

          <div className="binder-detail-title">
            {renamingBinder ? (
              <input
                autoFocus
                className="binder-rename-input"
                value={binderNameDraft}
                maxLength={100}
                onChange={(e) => setBinderNameDraft(e.target.value)}
                onBlur={saveBinderName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveBinderName();
                  if (e.key === 'Escape') setRenamingBinder(false);
                }}
              />
            ) : (
              <h1 onDoubleClick={startRenameBinder}>{binder.name}</h1>
            )}
            <button className="icon-btn" onClick={startRenameBinder} aria-label="Rename binder">
              <Icon name="edit" size={18} />
            </button>
            <button
              className={`icon-btn star-btn ${binder.isFavourite ? 'is-on' : ''}`}
              onClick={toggleFavourite}
              aria-pressed={binder.isFavourite}
              aria-label={binder.isFavourite ? 'Remove from favourites' : 'Favourite this binder'}
            >
              <Icon name="star" fill={binder.isFavourite} size={20} />
            </button>
          </div>
          <p className="lede">
            {sources.length === 0 ? 'No sources yet — drop in a PDF below.' : `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}, updated ${relativeDay(binder.updatedAt)}`}
          </p>
        </div>

        <div className="row gap-2" style={{ flexShrink: 0 }}>
          {binder.generatedAt && (
            <Link to={`/app/binders/${binderId}/recap`} className="btn btn-ghost">
              <Icon name="menu_book" size={18} />
              View recap
            </Link>
          )}
          <button className="icon-btn" onClick={() => setConfirmDeleteBinder(true)} aria-label="Delete binder">
            <Icon name="delete" size={20} />
          </button>
        </div>
      </header>

      <section className="panel" style={{ padding: 'clamp(16px, 3vw, 24px)' }}>
        <div
          className={`source-dropzone ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-label="Add PDF sources to this binder"
        >
          <input ref={inputRef} type="file" accept=".pdf" multiple hidden onChange={(e) => uploadFiles(e.target.files)} />
          {uploading ? (
            <>
              <Spinner size={22} />
              <strong>Uploading…</strong>
            </>
          ) : (
            <>
              <Icon name="cloud_upload" size={26} />
              <strong>Drop PDFs here, or click to browse</strong>
              <p>Multiple files at once — up to 300 pages total per binder</p>
            </>
          )}
        </div>
      </section>

      <section aria-label="Sources">
        {sources.length === 0 ? (
          <div className="empty-wrap panel">
            <Empty icon="description" title="No sources yet" body="Add PDFs above to start building this binder's recap." />
          </div>
        ) : (
          <div className="source-list">
            {sources.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                onRename={async (displayName) => {
                  setSources((list) => list.map((x) => (x.id === s.id ? { ...x, displayName } : x)));
                  try {
                    await api.sources.rename(s.id, displayName);
                  } catch (e) {
                    toast.error(e.message ?? 'Could not rename that source.');
                    refresh();
                  }
                }}
                onRetry={() => retrySource(s)}
                onDelete={() => setConfirmDeleteSource(s)}
              />
            ))}
          </div>
        )}
      </section>

      <div className="generate-bar">
        <button className="btn btn-primary" disabled={!canGenerate} onClick={generate}>
          {generating ? <Spinner size={16} /> : <Icon name="auto_awesome" size={18} />}
          Generate recap
        </button>
        {!generating && unsettledCount > 0 && (
          <span className="generate-hint">
            {readyCount} of {sources.length} ready — {unsettledCount} still processing
          </span>
        )}
        {!generating && unsettledCount === 0 && readyCount === 0 && sources.length > 0 && (
          <span className="generate-hint">No sources are ready yet.</span>
        )}
        {generating && generateJob && (
          <div className="row gap-2" style={{ flex: 1, minWidth: 200 }}>
            <div style={{ flex: 1 }}>
              <ProgressBar value={generateJob.progress ?? 0} label="Generation progress" />
            </div>
            <span className="generate-hint">{generateJob.stageLabel ?? 'Working…'}</span>
          </div>
        )}
      </div>

      <Modal
        open={!!confirmDeleteSource}
        onClose={() => setConfirmDeleteSource(null)}
        title="Delete this source?"
        footer={
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDeleteSource(null)}>
              Cancel
            </button>
            <button className="btn btn-primary btn-sm" onClick={removeSource}>
              Delete
            </button>
          </>
        }
      >
        <p>
          <strong>{confirmDeleteSource?.displayName}</strong> and its extracted text will be removed from this binder.
        </p>
      </Modal>

      <Modal
        open={confirmDeleteBinder}
        onClose={() => setConfirmDeleteBinder(false)}
        title="Delete this binder?"
        footer={
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDeleteBinder(false)}>
              Cancel
            </button>
            <button className="btn btn-primary btn-sm" onClick={removeBinder}>
              Delete permanently
            </button>
          </>
        }
      >
        <p>
          <strong>{binder.name}</strong> and all {sources.length} of its sources, plus its recap, will be removed.
          This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

const STATUS_META = {
  pending: { label: 'Processing', icon: 'spinner' },
  processing: { label: 'Processing', icon: 'spinner' },
  ready: { label: 'Ready', icon: 'check_circle' },
  failed: { label: 'Failed', icon: 'error' },
};

function SourceRow({ source, onRename, onRetry, onDelete }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(source.displayName);
  const meta = STATUS_META[source.status] ?? STATUS_META.pending;

  const startRename = () => {
    setDraft(source.displayName);
    setRenaming(true);
  };

  const save = () => {
    const name = draft.trim();
    setRenaming(false);
    if (name && name !== source.displayName) onRename(name);
  };

  return (
    <div className="source-row">
      <span className="source-icon">
        <Icon name="picture_as_pdf" size={19} />
      </span>

      <div className="source-name-wrap">
        {renaming ? (
          <input
            autoFocus
            className="source-rename-input"
            value={draft}
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <button className="source-name-btn truncate" onDoubleClick={startRename} onClick={startRename} title={source.displayName}>
            <span className="truncate">{source.displayName}</span>
            <Icon name="edit" size={14} />
          </button>
        )}
        <p className="source-meta truncate">
          {source.pageCount > 0 ? `${source.pageCount} pages · ` : ''}
          {formatBytes(source.sizeBytes)} · Uploaded {relativeDay(source.uploadedAt)}
          {source.status === 'failed' && source.errorMessage ? ` · ${source.errorMessage}` : ''}
        </p>
      </div>

      <span className={`status-badge is-${source.status}`}>
        {UNSETTLED.has(source.status) ? <Spinner size={13} /> : <Icon name={meta.icon} size={15} />}
        {meta.label}
      </span>

      <div className="source-row-actions">
        {source.status === 'failed' && (
          <button className="btn btn-ghost btn-sm" onClick={onRetry}>
            <Icon name="refresh" size={15} />
            Retry
          </button>
        )}
        <button className="icon-btn" onClick={onDelete} aria-label={`Delete ${source.displayName}`}>
          <Icon name="delete" size={18} />
        </button>
      </div>
    </div>
  );
}
