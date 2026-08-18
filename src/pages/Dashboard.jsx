import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useStore, studyStats } from '../lib/store.jsx';
import { useAuth } from '../lib/auth.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import { Icon, Empty, Segmented, Spinner, Modal } from '../components/ui.jsx';
import { StatTile } from '../components/charts/Charts.jsx';
import Mascot from '../mascot/Mascot.jsx';
import { FILE_TYPES, formatBytes, relativeDay } from '../lib/format.js';
import SpotlightCard from '../reactbits/SpotlightCard.jsx';
import CountUp from '../reactbits/CountUp.jsx';
import AnimatedContent from '../reactbits/AnimatedContent.jsx';
import '../reactbits/SpotlightCard.css';
import './dashboard.css';

const SORTS = [
  { value: 'recent', label: 'Newest' },
  { value: 'title', label: 'A–Z' },
  { value: 'weakest', label: 'Weakest first' },
];

export default function Dashboard() {
  const { materials, attempts, status, removeMaterial, attemptsFor } = useStore();
  const { user } = useAuth();
  const { allowMascot } = usePrefs();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [confirmDelete, setConfirmDelete] = useState(null);

  const stats = useMemo(() => studyStats(materials, attempts), [materials, attempts]);

  const bestScore = useMemo(() => {
    const map = new Map();
    for (const a of attempts) {
      map.set(a.materialId, Math.max(map.get(a.materialId) ?? 0, a.score));
    }
    return map;
  }, [attempts]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = materials.filter(
      (m) => !q || m.title.toLowerCase().includes(q) || (m.module ?? '').toLowerCase().includes(q),
    );
    const sorted = [...list];
    if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'weakest') {
      sorted.sort((a, b) => (bestScore.get(a.id) ?? -1) - (bestScore.get(b.id) ?? -1));
    } else sorted.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sorted;
  }, [materials, query, sort, bestScore]);

  // "Pick up where you left off" is the weakest material that has been quizzed
  // at least once, falling back to the newest thing that has not been.
  const resume = useMemo(() => {
    const quizzed = materials.filter((m) => bestScore.has(m.id));
    if (quizzed.length) {
      return quizzed.reduce((worst, m) => (bestScore.get(m.id) < bestScore.get(worst.id) ? m : worst));
    }
    return materials[0] ?? null;
  }, [materials, bestScore]);

  if (status === 'loading') {
    return (
      <div className="shell dash-loading" role="status">
        <Spinner size={22} />
        <span>Loading your library…</span>
      </div>
    );
  }

  return (
    <div className="shell dash">
      <header className="dash-head">
        <div>
          <p className="eyebrow">
            {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          <h1 className="dash-title">
            {stats.streak > 0 ? `${stats.streak}-day streak, ${user?.name}` : `Hello, ${user?.name}`}
          </h1>
          <p className="lede dash-lede">
            {materials.length === 0
              ? 'Nothing in your library yet. Upload a deck and Rec will have a recap ready in under a minute.'
              : stats.weakTopics.length > 0
                ? `${stats.weakTopics.length} ${stats.weakTopics.length === 1 ? 'topic is' : 'topics are'} still under 70% — ${stats.weakTopics[0].topic} is the weakest.`
                : 'Every topic you have been quizzed on is above 70%. Add new material to keep going.'}
          </p>
        </div>
        <Link to="/app/upload" className="btn btn-primary">
          <Icon name="upload" size={18} />
          New recap
        </Link>
      </header>

      <section className="dash-stats" aria-label="Study summary">
        <StatTile
          icon="local_fire_department"
          label="Study streak"
          value={<CountUp to={stats.streak} duration={1.1} />}
          unit={stats.streak === 1 ? 'day' : 'days'}
          tone={stats.streak >= 3 ? 'good' : 'neutral'}
          hint={stats.streak === 0 ? 'Take a quiz today to start one' : 'Consecutive days with a quiz attempt'}
        />
        <StatTile
          icon="library_books"
          label="Materials"
          value={<CountUp to={stats.materialCount} duration={1.1} />}
          hint={`${stats.questionsAnswered} questions answered in total`}
        />
        <StatTile
          icon="target"
          label="Average score"
          value={stats.averageScore == null ? '—' : <CountUp to={stats.averageScore} duration={1.3} />}
          unit={stats.averageScore == null ? undefined : '%'}
          tone={stats.averageScore == null ? 'neutral' : stats.averageScore >= 75 ? 'good' : 'warn'}
          hint={stats.attemptCount === 0 ? 'No attempts yet' : `Across ${stats.attemptCount} attempts`}
        />
        <StatTile
          icon="schedule"
          label="Reading time saved"
          value={<CountUp to={Math.round(stats.minutesSaved)} duration={1.4} />}
          unit="min"
          hint="Deck reading time minus recap reading time"
        />
      </section>

      {resume && materials.length > 0 && (
        <AnimatedContent distance={30} duration={0.6}>
          <section className="resume-card panel" aria-label="Pick up where you left off">
            <div className="resume-body">
              <p className="eyebrow">
                {bestScore.has(resume.id) ? 'Weakest material' : 'Not quizzed yet'}
              </p>
              <h2>{resume.title}</h2>
              <p className="resume-meta">
                {resume.module} · {resume.pageCount} pages ·{' '}
                {bestScore.has(resume.id) ? `best score ${bestScore.get(resume.id)}%` : 'no attempts yet'}
              </p>
              <div className="row wrap gap-2 resume-actions">
                <Link to={`/app/material/${resume.id}/quiz`} className="btn btn-primary btn-sm">
                  <Icon name="quiz" size={17} />
                  {bestScore.has(resume.id) ? 'Retry the quiz' : 'Take the quiz'}
                </Link>
                <Link to={`/app/material/${resume.id}`} className="btn btn-ghost btn-sm">
                  <Icon name="menu_book" size={17} />
                  Read the recap
                </Link>
                <Link to={`/app/material/${resume.id}/flashcards`} className="btn btn-ghost btn-sm">
                  <Icon name="style" size={17} />
                  Flashcards
                </Link>
              </div>
            </div>
            {allowMascot && (
              <div className="resume-mascot">
                <Mascot state="reading" size={168} shadow={false} />
              </div>
            )}
          </section>
        </AnimatedContent>
      )}

      <section className="dash-library" aria-label="Your materials">
        <div className="library-bar">
          <h2>Library</h2>
          <div className="row wrap gap-2">
            <label className="search">
              <Icon name="search" size={18} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search titles and modules"
                aria-label="Search your materials"
              />
            </label>
            <Segmented options={SORTS} value={sort} onChange={setSort} label="Sort materials" />
          </div>
        </div>

        {materials.length === 0 ? (
          <div className="empty-wrap panel">
            {allowMascot && <Mascot state="wave" size={200} />}
            <Empty
              icon="upload_file"
              title="Your library is empty"
              body="Upload a lecture deck, a set of notes, or a photo of handwritten pages. SmartRecap keeps the slide numbers so every line of the recap can point back at where it came from."
              action={
                <Link to="/app/upload" className="btn btn-primary">
                  <Icon name="upload" size={18} />
                  Upload your first file
                </Link>
              }
            />
          </div>
        ) : visible.length === 0 ? (
          <Empty icon="search_off" title="Nothing matches that search" body={`No material title or module contains "${query}".`} />
        ) : (
          <div className="card-grid">
            {visible.map((m, i) => (
              <AnimatedContent key={m.id} distance={26} duration={0.5} delay={Math.min(i * 0.04, 0.3)}>
                <MaterialCard
                  material={m}
                  score={bestScore.get(m.id)}
                  attempts={attemptsFor(m.id).length}
                  onDelete={() => setConfirmDelete(m)}
                  onOpen={() => navigate(`/app/material/${m.id}`)}
                />
              </AnimatedContent>
            ))}
          </div>
        )}
      </section>

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete this material?"
        footer={
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={async () => {
                await removeMaterial(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              Delete permanently
            </button>
          </>
        }
      >
        <p>
          <strong>{confirmDelete?.title}</strong> and its recap, quiz, flashcards and attempt history will be removed.
          The original file is deleted from S3 too. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

function MaterialCard({ material, score, attempts, onDelete, onOpen }) {
  const type = FILE_TYPES[material.fileType] ?? FILE_TYPES.pdf;
  const tone = score == null ? 'none' : score >= 80 ? 'good' : score >= 50 ? 'warn' : 'bad';

  return (
    <SpotlightCard className="material-card" spotlightColor="rgba(167, 139, 250, 0.22)">
      <div className="material-top">
        <span className={`file-badge is-${material.fileType}`}>
          <Icon name={type.icon} size={20} />
        </span>
        <div className="truncate grow">
          <h3 className="truncate" title={material.title}>
            {material.title}
          </h3>
          <p className="material-meta truncate">
            {material.module} · {relativeDay(material.createdAt)}
            {material.sizeBytes ? ` · ${formatBytes(material.sizeBytes)}` : ''}
          </p>
        </div>
        <button className="icon-btn" onClick={onDelete} aria-label={`Delete ${material.title}`}>
          <Icon name="delete" size={18} />
        </button>
      </div>

      <div className="material-chips">
        {material.sample && <span className="chip">Sample material</span>}
        {material.demo && <span className="chip chip-warn">Demo mode</span>}
        <span className="chip">{material.pageCount} pages</span>
        <span className="chip">{material.mode === 'cram' ? 'Cram recap' : 'Deep recap'}</span>
        {score == null ? (
          <span className="chip">Not quizzed</span>
        ) : (
          <span className={`chip chip-${tone === 'good' ? 'good' : tone === 'warn' ? 'warn' : 'bad'} num`}>
            {score}% best{attempts > 1 ? ` · ${attempts} tries` : ''}
          </span>
        )}
      </div>

      <div className="material-actions">
        <button className="btn btn-ghost btn-sm" onClick={onOpen}>
          <Icon name="menu_book" size={16} />
          Recap
        </button>
        <Link to={`/app/material/${material.id}/quiz`} className="btn btn-ghost btn-sm">
          <Icon name="quiz" size={16} />
          Quiz
        </Link>
        <Link to={`/app/material/${material.id}/flashcards`} className="btn btn-ghost btn-sm">
          <Icon name="style" size={16} />
          Cards
        </Link>
      </div>
    </SpotlightCard>
  );
}
