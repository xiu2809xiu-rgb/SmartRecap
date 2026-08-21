import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { PIPELINE_STAGES } from '../lib/api.js';
import { useJobs } from '../components/jobs.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import { Icon, ProgressBar } from '../components/ui.jsx';
import AuroraBackdrop from '../components/AuroraBackdrop.jsx';
import Mascot from '../components/mascot/Mascot.jsx';
import { STAGE_STATE } from '../components/mascot/states.js';
import CountUp from '../reactbits/CountUp.jsx';
import DecryptedText from '../reactbits/DecryptedText.jsx';
import './processing.css';

/**
 * The pipeline view.
 *
 * This is the screen a 20-to-40-second wait would otherwise be spent on, and it
 * is the reason Rec exists: the mascot's state is driven by the pipeline stage,
 * so "reading" and "thinking" are literally what the backend is doing. The
 * stage list is the same one the Lambda emits, not a decorative fake.
 */
export default function Processing() {
  const { jobId } = useParams();
  const [params] = useSearchParams();
  const materialId = params.get('material');
  const { jobById, registerJob } = useJobs();
  const { allowMascot } = usePrefs();
  const trackedJob = jobById(jobId);
  const job = trackedJob ?? { stage: 'upload', progress: 0, log: [], status: 'running', startedAt: Date.now() };
  const error = job.status === 'failed' ? (job.error || 'Processing failed.') : null;
  const ready = job.status === 'ready';
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!trackedJob && materialId) {
      registerJob({
        id: jobId,
        materialId,
        kind: 'recap',
        title: 'Uploaded material',
        stage: 'upload',
        stageLabel: 'Reading uploaded file',
      });
    }
  }, [jobId, materialId, registerJob, trackedJob]);

  useEffect(() => {
    const startedAt = job.startedAt || Date.now();
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [job.startedAt]);

  const stages = useMemo(
    () => PIPELINE_STAGES.filter((stage) => stage.id !== 'translate' || (job.language && job.language !== 'en')),
    [job.language],
  );
  const stageIndex = stages.findIndex((stage) => stage.id === job.stage);
  const mascotState = error ? 'confused' : ready ? 'celebrate' : (STAGE_STATE[job.stage] ?? 'thinking');

  return (
    <div className="processing">
      <AuroraBackdrop variant="threads" className="backdrop-fixed" opacity={0.7} />

      <div className="shell processing-inner">
        <div className="processing-visual">
          {allowMascot ? (
            <Mascot state={mascotState} size={330} />
          ) : (
            <div className="processing-ring" aria-hidden="true">
              <Icon name="autorenew" size={44} />
            </div>
          )}
        </div>

        <div className="processing-copy">
          <p className="eyebrow">
            {error
              ? 'Something went wrong'
              : ready
                ? 'Processing complete'
                : `Step ${Math.max(1, stageIndex + 1)} of ${stages.length}`}
          </p>

          <h1 className="processing-title" aria-live="polite">
            {error ? (
              'That did not go through'
            ) : ready ? (
              'Your notes are ready'
            ) : (
              <DecryptedText
                key={job.stage}
                text={stages[stageIndex]?.label ?? job.stageLabel ?? 'Starting up'}
                animateOn="view"
                sequential
                speed={26}
                revealDirection="start"
                characters="ABCDEFGHIJKLMNOPQRSTUVWXYZ01#$%"
              />
            )}
          </h1>

          <p className="processing-detail">
            {error
              ? error
              : ready
                ? 'The recap is grounded, formatted, and ready to study. Create your quiz afterwards when you choose.'
                : (job.stageLabel || stages[stageIndex]?.detail || 'Contacting the API')}
          </p>

          {error ? (
            <div className="row wrap gap-2 processing-actions">
              <Link to="/app/upload" className="btn btn-primary">
                <Icon name="refresh" size={18} />
                Try another file
              </Link>
              <Link to="/app" className="btn btn-ghost">Back to library</Link>
            </div>
          ) : ready ? (
            <div className="row wrap gap-2 processing-actions">
              <Link to={`/app/material/${materialId}`} className="btn btn-primary">
                <Icon name="menu_book" size={18} />
                Open my notes
              </Link>
              <Link to="/app" className="btn btn-ghost">Back to library</Link>
            </div>
          ) : (
            <>
              <div className="processing-progress">
                <ProgressBar value={job.progress} label="Processing progress" />
                <div className="processing-numbers">
                  <span className="num processing-pct">
                    <CountUp key={Math.floor(job.progress / 10)} to={job.progress} duration={0.5} />%
                  </span>
                  <span className="num processing-elapsed">{elapsed}s elapsed</span>
                </div>
              </div>

              <ol className="stage-list">
                {stages.map((stage, index) => {
                  const state = index < stageIndex ? 'done' : index === stageIndex ? 'now' : 'todo';
                  return (
                    <li key={stage.id} className={`stage is-${state}`}>
                      <span className="stage-dot">
                        {state === 'done' ? (
                          <Icon name="check" size={14} />
                        ) : state === 'now' ? (
                          <span className="stage-pulse" />
                        ) : null}
                      </span>
                      <div>
                        <strong>{stage.label}</strong>
                        <span>{stage.detail}</span>
                      </div>
                    </li>
                  );
                })}
              </ol>

              <div className="processing-background">
                <p className="processing-note">
                  <Icon name="notifications_active" size={15} />
                  This task keeps running while you browse. We will notify you as soon as your notes are ready.
                </p>
                <Link to="/app" className="btn btn-ghost btn-sm">
                  <Icon name="remove" size={17} />
                  Minimize and continue browsing
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
