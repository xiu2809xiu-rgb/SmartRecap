import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useToast, Icon, Empty, Spinner, Modal } from '../components/ui.jsx';
import { relativeDay } from '../lib/format.js';
import SpotlightCard from '../reactbits/SpotlightCard.jsx';
import '../reactbits/SpotlightCard.css';
import './binders.css';

/**
 * The binder library: every binder the student has created, favourites
 * pinned first. A binder card only shows what the acceptance criteria ask
 * for — name, source count, favourite star, updated date — everything else
 * (sources, status, generate) lives one click away on the detail page.
 */
export default function Binders() {
  const toast = useToast();
  const navigate = useNavigate();
  const [binders, setBinders] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busyId, setBusyId] = useState(null); // star toggle in flight
  const [confirmDelete, setConfirmDelete] = useState(null);

  const refresh = useCallback(async () => {
    setStatus('loading');
    try {
      const list = await api.binders.list();
      setBinders(list ?? []);
      setStatus('ready');
    } catch (e) {
      toast.error(e.message ?? 'Could not load your binders.');
      setStatus('error');
    }
  }, [toast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createBinder = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const binder = await api.binders.create(name);
      setNewName('');
      navigate(`/app/binders/${binder.id}`);
    } catch (err) {
      toast.error(err.message ?? 'Could not create that binder.');
    } finally {
      setCreating(false);
    }
  };

  // Optimistic: the star flips immediately and the sort order is recomputed
  // client-side, then reconciled with whatever the server actually stored.
  const toggleFavourite = async (binder) => {
    setBusyId(binder.id);
    const next = !binder.isFavourite;
    setBinders((list) => resort(list.map((b) => (b.id === binder.id ? { ...b, isFavourite: next } : b))));
    try {
      const updated = await api.binders.update(binder.id, { isFavourite: next });
      setBinders((list) => resort(list.map((b) => (b.id === binder.id ? { ...b, ...updated } : b))));
    } catch (err) {
      setBinders((list) => resort(list.map((b) => (b.id === binder.id ? { ...b, isFavourite: !next } : b))));
      toast.error(err.message ?? 'Could not update that binder.');
    } finally {
      setBusyId(null);
    }
  };

  const removeBinder = async () => {
    const binder = confirmDelete;
    setConfirmDelete(null);
    setBinders((list) => list.filter((b) => b.id !== binder.id));
    try {
      await api.binders.remove(binder.id);
      toast.success(`"${binder.name}" was deleted.`);
    } catch (err) {
      toast.error(err.message ?? 'Could not delete that binder.');
      refresh();
    }
  };

  if (status === 'loading') {
    return (
      <div className="shell binders-loading" role="status">
        <Spinner size={22} />
        <span>Loading your binders…</span>
      </div>
    );
  }

  return (
    <div className="shell binders">
      <header className="binders-head">
        <div>
          <p className="eyebrow">Your binders</p>
          <h1 className="binders-title">Group your sources, get one recap</h1>
          <p className="lede">
            A binder holds every PDF for one module. Add as many as you like — Generate builds one recap that covers
            every source that is ready.
          </p>
        </div>
        <form className="row gap-2 binder-new" onSubmit={createBinder}>
          <input
            className="input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Binder name"
            maxLength={100}
            aria-label="New binder name"
          />
          <button type="submit" className="btn btn-primary" disabled={creating || !newName.trim()}>
            {creating ? <Spinner size={16} /> : <Icon name="add" size={18} />}
            New binder
          </button>
        </form>
      </header>

      {binders.length === 0 ? (
        <div className="empty-wrap panel">
          <Empty
            icon="folder_open"
            title="No binders yet"
            body="Create a binder, then drop in every PDF for that module. SmartRecap keeps track of extraction per file and writes one recap once they are ready."
          />
        </div>
      ) : (
        <div className="card-grid">
          {binders.map((b) => (
            <BinderCard
              key={b.id}
              binder={b}
              busy={busyId === b.id}
              onToggleFavourite={() => toggleFavourite(b)}
              onOpen={() => navigate(`/app/binders/${b.id}`)}
              onDelete={() => setConfirmDelete(b)}
            />
          ))}
        </div>
      )}

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete this binder?"
        footer={
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button className="btn btn-primary btn-sm" onClick={removeBinder}>
              Delete permanently
            </button>
          </>
        }
      >
        <p>
          <strong>{confirmDelete?.name}</strong> and every source inside it — {sourceCountLabel(confirmDelete?.sourceCount ?? 0)}
          , plus its recap — will be removed. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

function resort(list) {
  return [...list].sort((a, b) =>
    b.isFavourite === a.isFavourite ? new Date(b.updatedAt) - new Date(a.updatedAt) : b.isFavourite ? 1 : -1,
  );
}

function sourceCountLabel(n) {
  return `${n} ${n === 1 ? 'source' : 'sources'}`;
}

function BinderCard({ binder, busy, onToggleFavourite, onOpen, onDelete }) {
  return (
    <SpotlightCard className="binder-card" spotlightColor="rgba(167, 139, 250, 0.22)">
      <div className="binder-top">
        <span className="folder-badge">
          <Icon name="folder" size={20} />
        </span>
        <div className="truncate grow" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => (e.key === 'Enter' ? onOpen() : null)}>
          <h3 className="truncate" title={binder.name}>
            {binder.name}
          </h3>
          <p className="binder-meta truncate">
            {sourceCountLabel(binder.sourceCount)} · Updated {relativeDay(binder.updatedAt)}
          </p>
        </div>
        <button
          className={`icon-btn star-btn ${binder.isFavourite ? 'is-on' : ''}`}
          onClick={onToggleFavourite}
          disabled={busy}
          aria-pressed={binder.isFavourite}
          aria-label={binder.isFavourite ? `Remove ${binder.name} from favourites` : `Favourite ${binder.name}`}
        >
          <Icon name="star" fill={binder.isFavourite} size={19} />
        </button>
      </div>

      <div className="binder-actions">
        <Link to={`/app/binders/${binder.id}`} className="btn btn-ghost btn-sm">
          <Icon name="folder_open" size={16} />
          Open
        </Link>
        {binder.generatedAt && (
          <Link to={`/app/binders/${binder.id}/recap`} className="btn btn-ghost btn-sm">
            <Icon name="menu_book" size={16} />
            Recap
          </Link>
        )}
        <button className="icon-btn" onClick={onDelete} aria-label={`Delete ${binder.name}`}>
          <Icon name="delete" size={18} />
        </button>
      </div>
    </SpotlightCard>
  );
}
