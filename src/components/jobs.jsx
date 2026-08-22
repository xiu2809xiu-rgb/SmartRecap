import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, pollJob } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useStore } from '../lib/store.jsx';
import { Icon, ProgressBar, Spinner, useToast } from './ui.jsx';
import { sendCompletionNotification } from '../lib/notifications.js';
import './jobs.css';

const STORAGE_KEY = 'smartrecap.jobs.v1';
const JobsContext = createContext(null);

/**
 * Jobs are stored against the account that started them.
 *
 * They used to be a bare array, restored on mount whatever the auth state was,
 * and nothing cleared them on sign-out. On a shared machine that meant the next
 * person to open the browser saw the previous student's work — the material's
 * title, sitting in the activity panel on the public landing page, with no
 * session and no way to have asked for it. The server was never the problem;
 * every route already refuses an unauthenticated request. This was the browser
 * showing something it had kept.
 *
 * Stamping the owner on the record and refusing to restore a mismatch closes
 * that, and means a second account signing in on the same machine starts empty
 * rather than inheriting.
 */
function loadJobs(ownerId) {
  if (!ownerId) return [];
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!value || value.ownerId !== ownerId || !Array.isArray(value.jobs)) return [];
    return value.jobs.slice(0, 8);
  } catch {
    return [];
  }
}

function clearJobs() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function JobsProvider({ children }) {
  const { user, status } = useAuth();
  const ownerId = user?.id ?? null;
  const [jobs, setJobs] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const polling = useRef(new Map());
  const { upsertMaterial } = useStore();
  const toast = useToast();
  const navigate = useNavigate();

  const patchJob = useCallback((id, patch) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  }, []);

  const registerJob = useCallback((job) => {
    setJobs((current) => {
      const entry = {
        progress: 0,
        stage: 'queued',
        stageLabel: 'Queued',
        status: 'running',
        startedAt: Date.now(),
        ...job,
      };
      return [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, 8);
    });
  }, []);

  const dismissJob = useCallback((id) => {
    setJobs((current) => current.filter((job) => job.id !== id));
  }, []);

  const openJob = useCallback(
    (job) => {
      const path = job.kind === 'quiz' && job.status === 'ready'
        ? `/app/material/${job.materialId}/quiz${job.quizId ? `?quizId=${encodeURIComponent(job.quizId)}` : ''}`
        : job.kind === 'recap' && job.status === 'running'
          ? `/app/processing/${job.id}?material=${job.materialId}`
          : `/app/material/${job.materialId}`;
      if (job.status !== 'running') dismissJob(job.id);
      navigate(path);
    },
    [dismissJob, navigate],
  );

  const monitor = useCallback(
    (descriptor) => {
      if (polling.current.has(descriptor.id)) return;
      const controller = new AbortController();
      polling.current.set(descriptor.id, controller);
      pollJob(descriptor.id, (job) => patchJob(descriptor.id, job), { signal: controller.signal })
        .then(async (finished) => {
          const material = await api.materials.get(descriptor.materialId);
          upsertMaterial(material);
          const ready = { ...descriptor, ...finished, status: 'ready', progress: 100, completedAt: Date.now() };
          patchJob(descriptor.id, ready);
          const isQuiz = descriptor.kind === 'quiz';
          const path = isQuiz ? `/app/material/${descriptor.materialId}/quiz${finished.quizId ? `?quizId=${encodeURIComponent(finished.quizId)}` : ''}` : `/app/material/${descriptor.materialId}`;
          toast.success(isQuiz ? 'Your quiz is ready.' : 'Your recap is ready.', {
            duration: 8000,
            action: (
              <button className="btn btn-ghost btn-sm" onClick={() => navigate(path)}>
                Open
              </button>
            ),
          });
          sendCompletionNotification(
            isQuiz ? 'SmartRecap quiz ready' : 'SmartRecap notes ready',
            isQuiz ? `${descriptor.title || 'Your'} quiz is ready to start.` : `${descriptor.title || 'Your'} notes are ready to study.`,
            path,
          );
        })
        .catch(async (error) => {
          if (error?.name === 'AbortError') return;
          try {
            const material = await api.materials.get(descriptor.materialId);
            upsertMaterial(material);
          } catch {
            /* The original job error is the useful message. */
          }
          patchJob(descriptor.id, { status: 'failed', stage: 'failed', error: error.message, completedAt: Date.now() });
          toast.error(error.message || `${descriptor.kind === 'quiz' ? 'Quiz' : 'Recap'} generation failed.`);
        })
        .finally(() => polling.current.delete(descriptor.id));
    },
    [navigate, patchJob, toast, upsertMaterial],
  );

  // Adopt this account's jobs, and drop everything on sign-out. Waiting for
  // `status` to settle matters: restoring before auth resolves would show the
  // previous owner's jobs for the moment it takes to find out who is here.
  useEffect(() => {
    if (status !== 'ready') return;
    if (!ownerId) {
      setJobs([]);
      clearJobs();
      return;
    }
    setJobs(loadJobs(ownerId));
  }, [ownerId, status]);

  useEffect(() => {
    if (status !== 'ready' || !ownerId) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ownerId, jobs: jobs.slice(0, 8) }));
    } catch {
      /* storage unavailable */
    }
    jobs.filter((job) => job.status === 'running').forEach(monitor);
  }, [jobs, monitor, ownerId, status]);

  useEffect(() => () => {
    polling.current.forEach((controller) => controller.abort());
    polling.current.clear();
  }, []);

  const value = useMemo(
    () => ({ jobs, registerJob, dismissJob, openJob, jobById: (id) => jobs.find((job) => job.id === id) }),
    [dismissJob, jobs, openJob, registerJob],
  );

  return (
    <JobsContext.Provider value={value}>
      {children}
      {ownerId && (
      <JobCenter
        jobs={jobs}
        collapsed={collapsed}
        onCollapse={() => setCollapsed((value) => !value)}
        onDismiss={dismissJob}
        onOpen={openJob}
      />
      )}
    </JobsContext.Provider>
  );
}

export function useJobs() {
  const context = useContext(JobsContext);
  if (!context) throw new Error('useJobs must be used inside <JobsProvider>');
  return context;
}

function JobCenter({ jobs, collapsed, onCollapse, onDismiss, onOpen }) {
  const visible = jobs.filter((job) => job.status === 'running' || job.status === 'ready' || job.status === 'failed');
  if (!visible.length) return null;
  const running = visible.filter((job) => job.status === 'running').length;

  if (collapsed) {
    return (
      <button className="job-center-collapsed" onClick={onCollapse} aria-label="Show background jobs">
        {running ? <Spinner size={16} /> : <Icon name="notifications_active" size={18} />}
        <span>{running ? `${running} task${running === 1 ? '' : 's'} running` : `${visible.length} update${visible.length === 1 ? '' : 's'}`}</span>
        <Icon name="expand_less" size={18} />
      </button>
    );
  }

  return (
    <aside className="job-center" aria-label="Background tasks" aria-live="polite">
      <header className="job-center-head">
        <div>
          <strong>Background activity</strong>
          <span>You can keep browsing while this finishes.</span>
        </div>
        <button className="icon-btn" onClick={onCollapse} aria-label="Minimize background activity">
          <Icon name="remove" size={19} />
        </button>
      </header>
      <div className="job-center-list">
        {visible.map((job) => (
          <article key={job.id} className={`job-item is-${job.status}`}>
            <div className="job-item-top">
              <span className="job-kind-icon">
                <Icon name={job.kind === 'quiz' ? 'quiz' : 'description'} size={18} />
              </span>
              <div className="grow truncate">
                <strong className="truncate">{job.kind === 'quiz' ? 'Creating quiz' : 'Creating notes'}</strong>
                <span className="truncate">{job.title || job.stageLabel}</span>
              </div>
              {job.status === 'running' ? <span className="num job-percent">{Math.round(job.progress || 0)}%</span> : null}
            </div>
            {job.status === 'running' ? (
              <>
                <ProgressBar value={job.progress || 0} label={`${job.kind || 'Task'} progress`} />
                <p className="job-stage">{job.stageLabel || 'Working…'}</p>
              </>
            ) : (
              <div className="job-finished">
                <span className={job.status === 'ready' ? 'is-ready' : 'is-failed'}>
                  <Icon name={job.status === 'ready' ? 'check_circle' : 'error'} size={16} />
                  {job.status === 'ready' ? 'Ready' : job.error || 'Failed'}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => onOpen(job)}>
                  {job.status === 'ready' ? 'Open' : 'View'}
                </button>
                <button className="icon-btn" onClick={() => onDismiss(job.id)} aria-label="Dismiss task">
                  <Icon name="close" size={16} />
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </aside>
  );
}