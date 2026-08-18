import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useStore, studyStats, activityGrid } from '../lib/store.jsx';
import { Icon, Empty } from '../components/ui.jsx';
import { StatTile, MasteryBars, ScoreTrend, StudyHeatmap } from '../components/charts/Charts.jsx';
import CountUp from '../reactbits/CountUp.jsx';
import AnimatedContent from '../reactbits/AnimatedContent.jsx';
import { relativeDay } from '../lib/format.js';
import './progress.css';

export default function Progress() {
  const { materials, attempts } = useStore();

  const stats = useMemo(() => studyStats(materials, attempts), [materials, attempts]);
  const cells = useMemo(() => activityGrid(attempts), [attempts]);

  const materialTitle = useMemo(() => new Map(materials.map((m) => [m.id, m.title])), [materials]);

  if (attempts.length === 0) {
    return (
      <div className="shell progress">
        <header className="progress-head">
          <p className="eyebrow">Progress</p>
          <h1 className="progress-title">Nothing to chart yet</h1>
        </header>
        <div className="panel">
          <Empty
            icon="insights"
            title="Take a quiz and this page fills in"
            body="Mastery per topic, your score trend and a 12-week activity map all come from quiz attempts. One attempt is enough to start."
            action={
              <Link to="/app" className="btn btn-primary">
                <Icon name="quiz" size={18} />
                Go to your library
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="shell progress">
      <header className="progress-head">
        <p className="eyebrow">Progress</p>
        <h1 className="progress-title">
          {stats.weakTopics.length === 0
            ? 'Every topic is above 70%'
            : `${stats.weakTopics.length} ${stats.weakTopics.length === 1 ? 'topic needs' : 'topics need'} another pass`}
        </h1>
        <p className="lede">
          {stats.weakTopics.length === 0
            ? `Across ${stats.attemptCount} attempts and ${stats.questionsAnswered} questions, nothing is currently under the 70% line.`
            : `Weakest first: ${stats.weakTopics
                .slice(0, 3)
                .map((t) => `${t.topic} (${t.mastery}%)`)
                .join(', ')}.`}
        </p>
      </header>

      <section className="progress-stats" aria-label="Summary">
        <StatTile
          icon="local_fire_department"
          label="Study streak"
          value={<CountUp to={stats.streak} duration={1.1} />}
          unit={stats.streak === 1 ? 'day' : 'days'}
          tone={stats.streak >= 3 ? 'good' : 'neutral'}
        />
        <StatTile
          icon="target"
          label="Average score"
          value={<CountUp to={stats.averageScore ?? 0} duration={1.3} />}
          unit="%"
          tone={stats.averageScore >= 75 ? 'good' : 'warn'}
        />
        <StatTile
          icon="checklist"
          label="Questions answered"
          value={<CountUp to={stats.questionsAnswered} duration={1.4} />}
        />
        <StatTile icon="library_books" label="Materials" value={<CountUp to={stats.materialCount} duration={1} />} />
      </section>

      <div className="progress-grid">
        <AnimatedContent distance={26} duration={0.55}>
          <section className="panel progress-card">
            <header className="card-head">
              <h2>Mastery by topic</h2>
              <p>Correct answers as a share of every question you have seen in that topic, across all attempts.</p>
            </header>
            <MasteryBars topics={stats.topics} />
          </section>
        </AnimatedContent>

        <AnimatedContent distance={26} duration={0.55} delay={0.06}>
          <section className="panel progress-card">
            <header className="card-head">
              <h2>Quiz score over time</h2>
              <p>Every attempt, oldest to newest. Retries of weak topics show up here too.</p>
            </header>
            <ScoreTrend attempts={attempts} />
          </section>
        </AnimatedContent>

        <AnimatedContent distance={26} duration={0.55} delay={0.12}>
          <section className="panel progress-card is-wide">
            <header className="card-head">
              <h2>Activity</h2>
              <p>Days with at least one quiz attempt, over the last twelve weeks.</p>
            </header>
            <StudyHeatmap cells={cells} />
          </section>
        </AnimatedContent>

        <AnimatedContent distance={26} duration={0.55} delay={0.18}>
          <section className="panel progress-card is-wide">
            <header className="card-head">
              <h2>Recent attempts</h2>
            </header>
            <table className="attempts-table">
              <thead>
                <tr>
                  <th scope="col">Material</th>
                  <th scope="col">When</th>
                  <th scope="col" className="ta-right">
                    Correct
                  </th>
                  <th scope="col" className="ta-right">
                    Score
                  </th>
                </tr>
              </thead>
              <tbody>
                {attempts.slice(0, 12).map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link to={`/app/material/${a.materialId}/results/${a.id}`} className="truncate">
                        {materialTitle.get(a.materialId) ?? 'Deleted material'}
                      </Link>
                    </td>
                    <td className="ink-3">{relativeDay(a.at)}</td>
                    <td className="ta-right num">
                      {a.correct}/{a.total}
                    </td>
                    <td className="ta-right num">
                      <span className={`chip chip-${a.score >= 80 ? 'good' : a.score >= 50 ? 'warn' : 'bad'}`}>
                        {a.score}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </AnimatedContent>
      </div>
    </div>
  );
}
