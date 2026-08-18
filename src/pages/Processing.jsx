import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { api, pollJob, PIPELINE_STAGES } from '../lib/api.js';
import { useStore } from '../lib/store.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import { Icon, ProgressBar, useToast } from '../components/ui.jsx';
import AuroraBackdrop from '../components/AuroraBackdrop.jsx';
import Mascot from '../mascot/Mascot.jsx';
import { STAGE_STATE } from '../mascot/states.js';
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
  const navigate = useNavigate();
  const toast = useToast();
  const { upsertMaterial } = useStore();
  const { allowMascot } = usePrefs();

  const [job, setJob] = useState({ stage: 'upload', progress: 0, log: [] });
  const [error, setError] = useState(null);
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await pollJob(jobId, (j) => !cancelled && setJob(j));
        if (cancelled) return;
        const material = await api.materials.get(materialId);
        upsertMaterial(material);
        toast.success('Recap ready.');
        navigate(`/app/material/${materialId}`, { replace: true });
      } catch (e) {
        if (!cancelled) {
          setError(e.message ?? 'Processing failed.');
          toast.error(e.message ?? 'Processing failed.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, materialId, navigate, upsertMaterial, toast]);

  const stageIndex = PIPELINE_STAGES.findIndex((s) => s.id === job.stage);
  const mascotState = error ? 'confused' : (STAGE_STATE[job.stage] ?? 'thinking');

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
            {error ? 'Something went wrong' : `Step ${Math.max(1, stageIndex + 1)} of ${PIPELINE_STAGES.length}`}
          </p>

          <h1 className="processing-title" aria-live="polite">
            {error ? (
              'That did not go through'
            ) : (
              <DecryptedText
                key={job.stage}
                text={PIPELINE_STAGES[stageIndex]?.label ?? 'Starting up'}
                animateOn="view"
                sequential
                speed={26}
                revealDirection="start"
                characters="ABCDEFGHIJKLMNOPQRSTUVWXYZ01#$%"
              />
            )}
          </h1>

          <p className="processing-detail">
            {error ? error : (PIPELINE_STAGES[stageIndex]?.detail ?? 'Contacting the API')}
          </p>

          {error ? (
            <div className="row wrap gap-2 processing-actions">
              <Link to="/app/upload" className="btn btn-primary">
                <Icon name="refresh" size={18} />
                Try another file
              </Link>
              <Link to="/app" className="btn btn-ghost">
                Back to library
              </Link>
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
                {PIPELINE_STAGES.map((s, i) => {
                  const state = i < stageIndex ? 'done' : i === stageIndex ? 'now' : 'todo';
                  return (
                    <li key={s.id} className={`stage is-${state}`}>
                      <span className="stage-dot">
                        {state === 'done' ? (
                          <Icon name="check" size={14} />
                        ) : state === 'now' ? (
                          <span className="stage-pulse" />
                        ) : null}
                      </span>
                      <div>
                        <strong>{s.label}</strong>
                        <span>{s.detail}</span>
                      </div>
                    </li>
                  );
                })}
              </ol>

              <p className="processing-note">
                <Icon name="info" size={15} />
                You can leave this page — processing runs in Lambda and the recap will be in your library when it
                finishes.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
