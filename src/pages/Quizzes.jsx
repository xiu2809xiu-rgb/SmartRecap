import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useJobs } from '../lib/jobs.jsx';
import { Empty, Icon, Segmented, Spinner, useToast } from '../components/ui.jsx';
import './quizzes.css';

const DIFFICULTIES = [
  { value: 'easy', label: 'Easy', icon: 'sentiment_satisfied' },
  { value: 'medium', label: 'Medium', icon: 'psychology' },
  { value: 'hard', label: 'Hard', icon: 'local_fire_department' },
];
const COUNTS = [5, 10, 15].map((value) => ({ value, label: String(value) }));
let localQuestionId = 0;

const freshQuestion = () => ({
  id: `draft-${Date.now()}-${++localQuestionId}`,
  topic: '',
  prompt: '',
  explanation: '',
  options: ['', ''],
  answer: 0,
});

function normalizeQuestion(question) {
  const options = Array.isArray(question?.options) ? question.options.map((option) => String(option ?? '')) : ['', ''];
  while (options.length < 2) options.push('');
  return {
    id: question?.id || freshQuestion().id,
    topic: question?.topic || '',
    prompt: question?.prompt || '',
    explanation: question?.explanation || '',
    options: options.slice(0, 6),
    answer: Math.min(Number(question?.answer ?? question?.correctAnswer ?? 0), Math.min(options.length, 6) - 1),
  };
}

function lobbyMaterialId(lobby) {
  return lobby.materialId ?? lobby.material_id;
}

function isPrivateLobby(lobby) {
  return Boolean(lobby.isPrivate ?? lobby.is_private ?? lobby.private ?? lobby.visibility === 'private');
}

function playerCount(lobby) {
  return Array.isArray(lobby.players) ? lobby.players.length : Number(lobby.playerCount ?? lobby.player_count ?? 0);
}

function maxPlayers(lobby) {
  return Number(lobby.maxPlayers ?? lobby.max_players ?? 0);
}

function quizQuestions(material) {
  return Array.isArray(material?.quiz?.questions) ? material.quiz.questions : [];
}

function difficultyLabel(value) {
  const text = String(value || 'medium');
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

export default function Quizzes() {
  const toast = useToast();
  const { registerJob } = useJobs();
  const [materials, setMaterials] = useState([]);
  const [lobbies, setLobbies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lobbyRefreshing, setLobbyRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [generatorMaterialId, setGeneratorMaterialId] = useState('');
  const [difficulty, setDifficulty] = useState('medium');
  const [questionCount, setQuestionCount] = useState(10);
  const [generating, setGenerating] = useState(false);
  const [editorMaterialId, setEditorMaterialId] = useState('');
  const [quizTitle, setQuizTitle] = useState('');
  const [questions, setQuestions] = useState([freshQuestion()]);
  const [saving, setSaving] = useState(false);

  const refreshLobbies = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLobbyRefreshing(true);
    try {
      const result = await api.lobbies.list();
      setLobbies((result ?? []).filter((lobby) => !lobby.status || lobby.status === 'open'));
    } catch (error) {
      if (!quiet) toast.error(error.message || 'Could not refresh open parties.');
    } finally {
      if (!quiet) setLobbyRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.materials.list(), api.lobbies.list()])
      .then(([materialList, lobbyList]) => {
        if (cancelled) return;
        const nextMaterials = materialList ?? [];
        setMaterials(nextMaterials);
        setLobbies((lobbyList ?? []).filter((lobby) => !lobby.status || lobby.status === 'open'));
        const firstId = nextMaterials[0]?.id || '';
        setGeneratorMaterialId(firstId);
        setEditorMaterialId(firstId);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const timer = window.setInterval(() => refreshLobbies({ quiet: true }), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshLobbies]);

  const selectedEditorMaterial = useMemo(
    () => materials.find((material) => String(material.id) === String(editorMaterialId)),
    [editorMaterialId, materials],
  );

  useEffect(() => {
    if (!selectedEditorMaterial) return;
    const current = quizQuestions(selectedEditorMaterial);
    setQuizTitle(selectedEditorMaterial.quiz?.title || `${selectedEditorMaterial.title} Quiz`);
    setQuestions(current.length ? current.map(normalizeQuestion) : [freshQuestion()]);
  }, [editorMaterialId, selectedEditorMaterial]);

  const materialNames = useMemo(
    () => new Map(materials.map((material) => [String(material.id), material.title])),
    [materials],
  );

  const readyQuizCount = materials.filter((material) => quizQuestions(material).length > 0).length;

  const generateQuiz = async () => {
    const material = materials.find((item) => String(item.id) === String(generatorMaterialId));
    if (!material) {
      toast.error('Choose a notebook first.');
      return;
    }
    setGenerating(true);
    try {
      const response = await api.quiz.generate(material.id, { difficulty, questionCount });
      registerJob({
        id: response.jobId,
        materialId: material.id,
        kind: 'quiz',
        title: material.title,
        stage: 'queued',
        stageLabel: difficulty === 'hard'
          ? 'Gemini drafting; GPT-5.6 Sol refining; OpenAI auditing'
          : 'Gemini creating conceptual questions',
        progress: 0,
      });
      setMaterials((current) => current.map((item) => item.id === material.id
        ? { ...item, quiz: { ...item.quiz, generationStatus: 'generating', status: item.quiz?.id ? item.quiz.status : 'generating' } }
        : item));
      toast.info(`Creating a ${questionCount}-question ${difficulty} quiz for ${material.title}.`);
    } catch (error) {
      toast.error(error.message || 'Could not start quiz generation.');
    } finally {
      setGenerating(false);
    }
  };

  const updateQuestion = (questionIndex, field, value) => {
    setQuestions((current) => current.map((question, index) => index === questionIndex
      ? { ...question, [field]: value }
      : question));
  };

  const updateOption = (questionIndex, optionIndex, value) => {
    setQuestions((current) => current.map((question, index) => index === questionIndex
      ? { ...question, options: question.options.map((option, i) => i === optionIndex ? value : option) }
      : question));
  };

  const addOption = (questionIndex) => {
    setQuestions((current) => current.map((question, index) => index === questionIndex && question.options.length < 6
      ? { ...question, options: [...question.options, ''] }
      : question));
  };

  const removeOption = (questionIndex, optionIndex) => {
    setQuestions((current) => current.map((question, index) => {
      if (index !== questionIndex || question.options.length <= 2) return question;
      const options = question.options.filter((_, i) => i !== optionIndex);
      let answer = question.answer;
      if (answer === optionIndex) answer = 0;
      else if (answer > optionIndex) answer -= 1;
      return { ...question, options, answer };
    }));
  };

  const saveQuiz = async () => {
    const title = quizTitle.trim();
    if (!selectedEditorMaterial) return toast.error('Choose a notebook first.');
    if (!title) return toast.error('Give your quiz a title.');
    if (!questions.length) return toast.error('Add at least one question.');
    const invalidIndex = questions.findIndex((question) => (
      !question.topic.trim()
      || !question.prompt.trim()
      || !question.explanation.trim()
      || question.options.length < 2
      || question.options.length > 6
      || question.options.some((option) => !option.trim())
      || question.answer < 0
      || question.answer >= question.options.length
    ));
    if (invalidIndex >= 0) {
      toast.error(`Complete question ${invalidIndex + 1}, including every option and its correct answer.`);
      return;
    }

    const payloadQuestions = questions.map((question) => ({
      ...(String(question.id).startsWith('draft-') ? {} : { id: question.id }),
      topic: question.topic.trim(),
      prompt: question.prompt.trim(),
      explanation: question.explanation.trim(),
      options: question.options.map((option) => option.trim()),
      answer: question.answer,
    }));

    setSaving(true);
    try {
      const saved = await api.quiz.save(selectedEditorMaterial.id, { title, questions: payloadQuestions });
      const savedQuiz = saved?.quiz ?? saved ?? { ...selectedEditorMaterial.quiz, title, questions: payloadQuestions };
      setMaterials((current) => current.map((material) => material.id === selectedEditorMaterial.id
        ? { ...material, quiz: { ...material.quiz, ...savedQuiz, title, questions: savedQuiz.questions ?? payloadQuestions } }
        : material));
      setQuestions((savedQuiz.questions ?? payloadQuestions).map(normalizeQuestion));
      toast.success(`Saved “${title}”.`);
    } catch (error) {
      toast.error(error.message || 'Could not save this quiz.');
    } finally {
      setSaving(false);
    }
  };

  const editMaterial = (material) => {
    setEditorMaterialId(String(material.id));
    window.requestAnimationFrame(() => document.getElementById('quiz-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  if (loading) {
    return (
      <div className="shell quizzes-loading" role="status">
        <Spinner size={24} />
        <span>Opening the Quiz Arena…</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="shell quizzes-page">
        <Empty
          icon="cloud_off"
          title="The Quiz Arena could not load"
          body={loadError.message || 'Check your connection and try again.'}
          action={<button className="btn btn-primary" onClick={() => window.location.reload()}>Try again</button>}
        />
      </div>
    );
  }

  return (
    <div className="shell quizzes-page">
      <header className="arena-hero">
        <div className="arena-hero-copy">
          <p className="eyebrow">Quiz Arena</p>
          <h1>Turn every notebook into game night.</h1>
          <p className="lede">Play your latest quizzes, jump into an open party, or build a perfectly tailored challenge.</p>
          <div className="arena-hero-actions">
            <a className="btn btn-primary" href="#quiz-studio"><Icon name="auto_awesome" size={18} />Create a quiz</a>
            <a className="btn btn-ghost" href="#open-parties"><Icon name="groups" size={18} />Browse parties</a>
          </div>
        </div>
        <div className="arena-scoreboard" aria-label="Quiz Arena summary">
          <div><Icon name="menu_book" size={22} /><strong>{materials.length}</strong><span>Notebooks</span></div>
          <div><Icon name="quiz" size={22} /><strong>{readyQuizCount}</strong><span>Ready quizzes</span></div>
          <div><Icon name="swords" size={22} /><strong>{lobbies.length}</strong><span>Open parties</span></div>
        </div>
      </header>

      <section className="arena-section" id="open-parties">
        <div className="arena-section-head">
          <div><p className="eyebrow">Live now</p><h2>Open parties</h2><p>Public and invite-only rooms refresh automatically.</p></div>
          <button className="btn btn-ghost btn-sm" onClick={() => refreshLobbies()} disabled={lobbyRefreshing}>
            {lobbyRefreshing ? <Spinner size={16} /> : <Icon name="refresh" size={17} />}Refresh
          </button>
        </div>
        {lobbies.length ? (
          <div className="party-grid">
            {lobbies.map((lobby) => {
              const materialId = lobbyMaterialId(lobby);
              const locked = Boolean(isPrivateLobby(lobby));
              const count = playerCount(lobby);
              const capacity = maxPlayers(lobby);
              return (
                <article className="party-card panel-solid" key={lobby.id}>
                  <div className="party-card-top">
                    <span className={`party-lock ${locked ? 'is-private' : 'is-public'}`}><Icon name={locked ? 'lock' : 'public'} size={19} /></span>
                    <span className="party-live"><i />Open</span>
                  </div>
                  <h3>{lobby.name || 'Quiz party'}</h3>
                  <p className="party-notebook">{materialNames.get(String(materialId)) || 'Shared notebook'}</p>
                  <div className="party-meta">
                    <span><Icon name="group" size={16} />{count}{capacity ? ` / ${capacity}` : ''}</span>
                    <span><Icon name="speed" size={16} />{difficultyLabel(lobby.difficulty)}</span>
                    <span><Icon name={locked ? 'lock' : 'lock_open'} size={16} />{locked ? 'Private' : 'Public'}</span>
                  </div>
                  <Link className="btn btn-primary btn-sm" to={`/app/material/${materialId}/match/${lobby.id}`}>
                    {locked ? 'Enter party' : 'Join party'}<Icon name="arrow_forward" size={17} />
                  </Link>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="arena-empty panel-solid"><Empty icon="celebration" title="No parties are waiting" body="Host one from any quiz below and invite your study crew." /></div>
        )}
      </section>

      <section className="arena-section" aria-labelledby="notebook-quizzes-title">
        <div className="arena-section-head">
          <div><p className="eyebrow">Your collection</p><h2 id="notebook-quizzes-title">Notebook quizzes</h2><p>Every notebook’s current quiz, ready to play or refine.</p></div>
        </div>
        {materials.length ? (
          <div className="quiz-library-grid">
            {materials.map((material) => {
              const quiz = material.quiz;
              const currentQuestions = quizQuestions(material);
              const ready = currentQuestions.length > 0;
              const isGenerating = quiz?.status === 'generating' || quiz?.generationStatus === 'generating';
              return (
                <article className="quiz-library-card panel-solid" key={material.id}>
                  <div className="quiz-library-icon"><Icon name="quiz" size={24} /></div>
                  <div className="quiz-library-body">
                    <span className={`quiz-state ${ready ? 'is-ready' : isGenerating ? 'is-building' : 'is-empty'}`}>
                      {isGenerating && <Spinner size={13} />}{ready ? 'Ready to play' : isGenerating ? 'Generating' : 'No quiz yet'}
                    </span>
                    <h3>{quiz?.title || material.title}</h3>
                    <p>{material.title}</p>
                    <div className="quiz-library-meta">
                      <span>{currentQuestions.length || quiz?.questionCount || 0} questions</span>
                      <span>{difficultyLabel(quiz?.difficulty || quiz?.requestedDifficulty)}</span>
                    </div>
                  </div>
                  <div className="quiz-library-actions">
                    {ready ? (
                      <Link className="btn btn-primary btn-sm" to={`/app/material/${material.id}/quiz`}><Icon name="play_arrow" size={17} />Play</Link>
                    ) : (
                      <button className="btn btn-primary btn-sm" disabled><Icon name="play_arrow" size={17} />Play</button>
                    )}
                    {ready ? (
                      <Link className="btn btn-ghost btn-sm" to={`/app/material/${material.id}/match`}><Icon name="groups" size={17} />Host party</Link>
                    ) : (
                      <button className="btn btn-ghost btn-sm" disabled><Icon name="groups" size={17} />Host party</button>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => editMaterial(material)}><Icon name="edit" size={17} />Edit</button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="arena-empty panel-solid">
            <Empty icon="note_add" title="Add a notebook to begin" body="Upload study material, then return here to generate or write its quiz." action={<Link className="btn btn-primary" to="/app/upload">Upload material</Link>} />
          </div>
        )}
      </section>

      <section className="arena-section" id="quiz-studio" aria-labelledby="quiz-studio-title">
        <div className="arena-section-head studio-heading">
          <div><p className="eyebrow">Quiz Studio</p><h2 id="quiz-studio-title">Create your next challenge</h2><p>Let AI draft a grounded set, or take full control in the editor.</p></div>
        </div>

        <div className="generator-card panel-solid">
          <div className="generator-intro">
            <span><Icon name="auto_awesome" size={26} /></span>
            <div><h3>Generate with AI</h3><p>Choose the source, challenge level, and round length. You can keep browsing while it builds.</p></div>
          </div>
          <div className="generator-controls">
            <label className="field generator-material">
              <span>Notebook</span>
              <select className="input" value={generatorMaterialId} onChange={(event) => setGeneratorMaterialId(event.target.value)} disabled={!materials.length}>
                {materials.length ? materials.map((material) => <option key={material.id} value={material.id}>{material.title}</option>) : <option value="">No notebooks available</option>}
              </select>
            </label>
            <div className="field"><span>Difficulty</span><Segmented options={DIFFICULTIES} value={difficulty} onChange={setDifficulty} label="Quiz difficulty" /></div>
            <div className="field"><span>Questions</span><Segmented options={COUNTS} value={questionCount} onChange={setQuestionCount} label="Question count" /></div>
            <button className="btn btn-primary generator-submit" onClick={generateQuiz} disabled={generating || !materials.length}>
              {generating ? <Spinner size={17} /> : <Icon name="auto_awesome" size={18} />}Generate quiz
            </button>
          </div>
        </div>

        <form className="quiz-editor panel-solid" id="quiz-editor" onSubmit={(event) => { event.preventDefault(); saveQuiz(); }}>
          <div className="editor-head">
            <div><span className="editor-icon"><Icon name="edit_note" size={25} /></span><div><h3>Manual editor</h3><p>Write, reorder, and polish every answer.</p></div></div>
            <button className="btn btn-primary" type="submit" disabled={saving || !materials.length}>{saving ? <Spinner size={17} /> : <Icon name="save" size={18} />}Save quiz</button>
          </div>
          <div className="editor-basics">
            <label className="field">
              <span>Notebook</span>
              <select className="input" value={editorMaterialId} onChange={(event) => setEditorMaterialId(event.target.value)} disabled={!materials.length}>
                {materials.length ? materials.map((material) => <option key={material.id} value={material.id}>{material.title}</option>) : <option value="">No notebooks available</option>}
              </select>
            </label>
            <label className="field"><span>Quiz title</span><input className="input" value={quizTitle} onChange={(event) => setQuizTitle(event.target.value)} placeholder="Midterm warm-up" maxLength={100} /></label>
          </div>

          <div className="editor-question-list">
            {questions.map((question, questionIndex) => (
              <fieldset className="editor-question" key={question.id}>
                <legend>Question {questionIndex + 1}</legend>
                <button type="button" className="icon-btn question-remove" onClick={() => setQuestions((current) => current.filter((_, index) => index !== questionIndex))} disabled={questions.length === 1} aria-label={`Remove question ${questionIndex + 1}`}><Icon name="delete" size={18} /></button>
                <div className="question-fields">
                  <label className="field question-topic"><span>Topic</span><input className="input" value={question.topic} onChange={(event) => updateQuestion(questionIndex, 'topic', event.target.value)} placeholder="e.g. Cell respiration" maxLength={80} /></label>
                  <label className="field question-prompt"><span>Prompt</span><textarea className="input" value={question.prompt} onChange={(event) => updateQuestion(questionIndex, 'prompt', event.target.value)} placeholder="Ask a clear, focused question…" rows={3} /></label>
                </div>

                <div className="option-editor">
                  <div className="option-editor-label"><span>Answer options</span><small>Choose the correct answer</small></div>
                  {question.options.map((option, optionIndex) => (
                    <div className="option-editor-row" key={optionIndex}>
                      <label className="correct-choice" title="Mark as correct"><input type="radio" name={`correct-${question.id}`} checked={question.answer === optionIndex} onChange={() => updateQuestion(questionIndex, 'answer', optionIndex)} /><span>{String.fromCharCode(65 + optionIndex)}</span></label>
                      <input className="input" value={option} onChange={(event) => updateOption(questionIndex, optionIndex, event.target.value)} placeholder={`Option ${String.fromCharCode(65 + optionIndex)}`} />
                      <button type="button" className="icon-btn" onClick={() => removeOption(questionIndex, optionIndex)} disabled={question.options.length <= 2} aria-label={`Remove option ${String.fromCharCode(65 + optionIndex)}`}><Icon name="close" size={17} /></button>
                    </div>
                  ))}
                  <button type="button" className="btn btn-ghost btn-sm add-option" onClick={() => addOption(questionIndex)} disabled={question.options.length >= 6}><Icon name="add" size={17} />Add option</button>
                </div>

                <label className="field"><span>Explanation</span><textarea className="input" value={question.explanation} onChange={(event) => updateQuestion(questionIndex, 'explanation', event.target.value)} placeholder="Explain why the selected answer is correct…" rows={3} /></label>
              </fieldset>
            ))}
          </div>
          <div className="editor-foot">
            <button type="button" className="btn btn-ghost" onClick={() => setQuestions((current) => [...current, freshQuestion()])}><Icon name="add_circle" size={18} />Add question</button>
            <span>{questions.length} {questions.length === 1 ? 'question' : 'questions'} · 2–6 options each</span>
            <button className="btn btn-primary" type="submit" disabled={saving || !materials.length}>{saving ? <Spinner size={17} /> : <Icon name="save" size={18} />}Save quiz</button>
          </div>
        </form>
      </section>
    </div>
  );
}
