import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useJobs } from '../components/jobs.jsx';
import { Empty, Icon, Select, Segmented, Spinner, useToast } from '../components/ui.jsx';
import './quizzes.css';

const DIFFICULTIES = [
  { value: 'easy', label: 'Easy', icon: 'sentiment_satisfied' },
  { value: 'medium', label: 'Medium', icon: 'psychology' },
  { value: 'hard', label: 'Hard', icon: 'local_fire_department' },
];
const COUNTS = [5, 10, 15].map((value) => ({ value, label: String(value) }));
const QUESTION_TYPES = [
  { value: 'single', label: 'Single', icon: 'radio_button_checked', secondary: 'One correct option' },
  { value: 'multi', label: 'Multi', icon: 'checklist', secondary: 'Every correct option' },
  { value: 'short', label: 'Short', icon: 'edit_note', secondary: 'Written response' },
];
let localQuestionId = 0;

const freshQuestion = () => ({
  id: `draft-${Date.now()}-${++localQuestionId}`,
  type: 'single',
  topic: '',
  prompt: '',
  explanation: '',
  options: ['', ''],
  answer: 0,
  modelAnswer: '',
});

function normalizeQuestion(question) {
  const type = question?.type || 'single';
  const options = Array.isArray(question?.options) ? question.options.map((option) => String(option ?? '')) : ['', ''];
  while (options.length < 2) options.push('');
  const max = Math.min(options.length, 6) - 1;
  const answer = type === 'multi'
    ? (Array.isArray(question?.answer) ? question.answer : [question?.answer ?? 0]).map(Number).filter((value) => value >= 0 && value <= max)
    : Math.min(Number(question?.answer ?? question?.correctAnswer ?? 0), max);
  return {
    id: question?.id || freshQuestion().id,
    type,
    topic: question?.topic || '',
    prompt: question?.prompt || '',
    explanation: question?.explanation || '',
    options: options.slice(0, 6),
    answer,
    modelAnswer: question?.modelAnswer || '',
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
  const [quizVersions, setQuizVersions] = useState([]);
  const [lobbies, setLobbies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lobbyRefreshing, setLobbyRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [generatorMaterialId, setGeneratorMaterialId] = useState('');
  const [difficulty, setDifficulty] = useState('medium');
  const [questionCount, setQuestionCount] = useState(10);
  const [questionTypes, setQuestionTypes] = useState(['single']);
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
    Promise.all([api.materials.list(), api.lobbies.list(), api.quiz.list()])
      .then(([materialList, lobbyList, versions]) => {
        if (cancelled) return;
        const nextMaterials = materialList ?? [];
        setMaterials(nextMaterials);
        setQuizVersions(versions ?? []);
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
  const materialOptions = useMemo(() => materials.map((material) => ({ value: String(material.id), label: material.title, secondary: material.module || 'Notebook' })), [materials]);
  const versionsByMaterial = useMemo(() => {
    const grouped = new Map(materials.map((material) => [String(material.id), []]));
    quizVersions.forEach((quiz) => {
      const key = String(quiz.materialId ?? quiz.material_id ?? '');
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(quiz);
    });
    materials.forEach((material) => {
      const list = grouped.get(String(material.id));
      if (material.quiz?.id && !list.some((quiz) => quiz.id === material.quiz.id)) list.push(material.quiz);
      list.sort((a, b) => new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0));
    });
    return grouped;
  }, [materials, quizVersions]);

  const toggleGeneratedType = (type) => setQuestionTypes((current) => current.includes(type)
    ? (current.length === 1 ? current : current.filter((item) => item !== type))
    : [...current, type]);

  const readyQuizCount = quizVersions.length || materials.filter((material) => quizQuestions(material).length > 0).length;

  const generateQuiz = async () => {
    const material = materials.find((item) => String(item.id) === String(generatorMaterialId));
    if (!material) {
      toast.error('Choose a notebook first.');
      return;
    }
    setGenerating(true);
    try {
      const response = await api.quiz.generate(material.id, { difficulty, questionCount, questionTypes });
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
    setQuestions((current) => current.map((question, index) => {
      if (index !== questionIndex) return question;
      if (field === 'type') return { ...question, type: value, answer: value === 'multi' ? [0] : 0, modelAnswer: value === 'short' ? question.modelAnswer : '' };
      return { ...question, [field]: value };
    }));
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
      if (question.type === 'multi') answer = (Array.isArray(answer) ? answer : []).filter((value) => value !== optionIndex).map((value) => value > optionIndex ? value - 1 : value);
      else if (answer === optionIndex) answer = 0;
      else if (answer > optionIndex) answer -= 1;
      return { ...question, options, answer };
    }));
  };

  const saveQuiz = async () => {
    const title = quizTitle.trim();
    if (!selectedEditorMaterial) return toast.error('Choose a notebook first.');
    if (!title) return toast.error('Give your quiz a title.');
    if (!questions.length) return toast.error('Add at least one question.');
    const invalidIndex = questions.findIndex((question) => {
      const type = question.type || 'single';
      const baseInvalid = !question.topic.trim() || !question.prompt.trim() || !question.explanation.trim();
      if (type === 'short') return baseInvalid || !question.modelAnswer.trim();
      const optionInvalid = question.options.length < 2 || question.options.length > 6 || question.options.some((option) => !option.trim());
      const answerInvalid = type === 'multi'
        ? !Array.isArray(question.answer) || !question.answer.length || question.answer.some((value) => value < 0 || value >= question.options.length)
        : question.answer < 0 || question.answer >= question.options.length;
      return baseInvalid || optionInvalid || answerInvalid;
    });
    if (invalidIndex >= 0) {
      toast.error(`Complete question ${invalidIndex + 1}, including its answer and explanation.`);
      return;
    }

    const payloadQuestions = questions.map((question) => ({
      ...(String(question.id).startsWith('draft-') ? {} : { id: question.id }),
      type: question.type || 'single',
      topic: question.topic.trim(),
      prompt: question.prompt.trim(),
      explanation: question.explanation.trim(),
      ...(question.type === 'short'
        ? { modelAnswer: question.modelAnswer.trim(), options: [], answer: null }
        : { options: question.options.map((option) => option.trim()), answer: question.answer }),
    }));

    setSaving(true);
    try {
      const saved = await api.quiz.save(selectedEditorMaterial.id, { title, questions: payloadQuestions });
      const savedQuiz = saved?.quiz ?? saved ?? { ...selectedEditorMaterial.quiz, title, questions: payloadQuestions };
      setMaterials((current) => current.map((material) => material.id === selectedEditorMaterial.id
        ? { ...material, quiz: { ...material.quiz, ...savedQuiz, title, questions: savedQuiz.questions ?? payloadQuestions } }
        : material));
      if (savedQuiz.id) setQuizVersions((current) => [savedQuiz, ...current.filter((quiz) => quiz.id !== savedQuiz.id)]);
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
              const versions = versionsByMaterial.get(String(material.id)) || [];
              const isGenerating = material.quiz?.status === 'generating' || material.quiz?.generationStatus === 'generating';
              return (
                <article className="quiz-library-card quiz-version-group panel-solid" key={material.id}>
                  <div className="quiz-library-icon"><Icon name="history_edu" size={24} /></div>
                  <div className="quiz-library-body">
                    <span className={`quiz-state ${versions.length ? 'is-ready' : isGenerating ? 'is-building' : 'is-empty'}`}>
                      {isGenerating && <Spinner size={13} />}{versions.length ? `${versions.length} saved ${versions.length === 1 ? 'version' : 'versions'}` : isGenerating ? 'Generating' : 'No quiz yet'}
                    </span>
                    <h3>{material.title}</h3>
                    <p>Immutable history · older tests remain playable</p>
                  </div>
                  <div className="quiz-version-list">
                    {versions.length ? versions.map((version, versionIndex) => {
                      const types = [...new Set((version.questions || []).map((question) => question.type || 'single'))];
                      const providers = (version.providers || []).map((provider) => provider.model || provider.name).filter(Boolean);
                      return (
                        <div className="quiz-version-row" key={version.id}>
                          <div className="quiz-version-copy">
                            <strong>{version.title || `Version ${versions.length - versionIndex}`}</strong>
                            <span>{version.generatedAt ? new Date(version.generatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Saved quiz'} · {difficultyLabel(version.difficulty)} · {version.questionCount || version.questions?.length || 0} questions</span>
                            <small>{types.map((type) => type === 'single' ? 'Single' : type === 'multi' ? 'Multi' : 'Short').join(' + ')}{providers.length ? ` · ${providers.join(' + ')}` : ''}</small>
                          </div>
                          <div className="quiz-version-actions">
                            <Link className="btn btn-primary btn-sm" to={`/app/material/${material.id}/quiz?quizId=${encodeURIComponent(version.id)}`}><Icon name="play_arrow" size={17} />Play</Link>
                            <Link className="btn btn-ghost btn-sm" to={`/app/material/${material.id}/match?quizId=${encodeURIComponent(version.id)}`}><Icon name="groups" size={17} />Host</Link>
                          </div>
                        </div>
                      );
                    }) : <p className="quiz-version-empty">Generate or author the first saved version below.</p>}
                  </div>
                  <div className="quiz-library-actions"><button className="btn btn-ghost btn-sm" onClick={() => editMaterial(material)}><Icon name="edit" size={17} />Author new version</button></div>
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
            <div className="field generator-material">
              <span>Notebook</span>
              <Select label="Notebook" value={generatorMaterialId} onChange={setGeneratorMaterialId} options={materialOptions} disabled={!materials.length} emptyText="No notebooks available" />
            </div>
            <div className="field"><span>Difficulty</span><Segmented options={DIFFICULTIES} value={difficulty} onChange={setDifficulty} label="Quiz difficulty" /></div>
            <div className="field"><span>Questions</span><Segmented options={COUNTS} value={questionCount} onChange={setQuestionCount} label="Question count" /></div>
            <fieldset className="quiz-type-generator">
              <legend>Question types</legend>
              <div>
                {QUESTION_TYPES.map((type) => <button key={type.value} type="button" className={questionTypes.includes(type.value) ? 'is-on' : ''} aria-pressed={questionTypes.includes(type.value)} onClick={() => toggleGeneratedType(type.value)}><Icon name={type.icon} size={17} />{type.label}</button>)}
              </div>
            </fieldset>
            <button className="btn btn-primary generator-submit" onClick={generateQuiz} disabled={generating || !materials.length || !questionTypes.length}>
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
            <div className="field">
              <span>Notebook</span>
              <Select label="Editor notebook" value={editorMaterialId} onChange={setEditorMaterialId} options={materialOptions} disabled={!materials.length} emptyText="No notebooks available" />
            </div>
            <label className="field"><span>Quiz title</span><input className="input" value={quizTitle} onChange={(event) => setQuizTitle(event.target.value)} placeholder="Midterm warm-up" maxLength={100} /></label>
          </div>

          <div className="editor-question-list">
            {questions.map((question, questionIndex) => (
              <fieldset className="editor-question" key={question.id}>
                <legend>Question {questionIndex + 1}</legend>
                <button type="button" className="icon-btn question-remove" onClick={() => setQuestions((current) => current.filter((_, index) => index !== questionIndex))} disabled={questions.length === 1} aria-label={`Remove question ${questionIndex + 1}`}><Icon name="delete" size={18} /></button>
                <div className="question-fields">
                  <label className="field question-topic"><span>Topic</span><input className="input" value={question.topic} onChange={(event) => updateQuestion(questionIndex, 'topic', event.target.value)} placeholder="e.g. Cell respiration" maxLength={80} /></label>
                  <div className="field question-type-field"><span>Answer type</span><Select label={`Question ${questionIndex + 1} answer type`} value={question.type} onChange={(value) => updateQuestion(questionIndex, 'type', value)} options={QUESTION_TYPES} /></div>
                  <label className="field question-prompt"><span>Prompt</span><textarea className="input" value={question.prompt} onChange={(event) => updateQuestion(questionIndex, 'prompt', event.target.value)} placeholder="Ask a clear, focused question…" rows={3} /></label>
                </div>

                {question.type === 'short' ? (
                  <label className="field short-model-answer"><span>Model answer</span><textarea className="input" value={question.modelAnswer} onChange={(event) => updateQuestion(questionIndex, 'modelAnswer', event.target.value)} placeholder="Write the grounded answer used to evaluate responses…" rows={4} /></label>
                ) : (
                  <div className="option-editor">
                    <div className="option-editor-label"><span>Answer options</span><small>{question.type === 'multi' ? 'Mark every correct answer' : 'Choose the correct answer'}</small></div>
                    {question.options.map((option, optionIndex) => {
                      const checked = question.type === 'multi' ? question.answer.includes(optionIndex) : question.answer === optionIndex;
                      return (
                        <div className="option-editor-row" key={optionIndex}>
                          <label className="correct-choice" title="Mark as correct"><input type={question.type === 'multi' ? 'checkbox' : 'radio'} name={`correct-${question.id}`} checked={checked} onChange={() => updateQuestion(questionIndex, 'answer', question.type === 'multi' ? (checked ? question.answer.filter((value) => value !== optionIndex) : [...question.answer, optionIndex]) : optionIndex)} /><span>{String.fromCharCode(65 + optionIndex)}</span></label>
                          <input className="input" value={option} onChange={(event) => updateOption(questionIndex, optionIndex, event.target.value)} placeholder={`Option ${String.fromCharCode(65 + optionIndex)}`} />
                          <button type="button" className="icon-btn" onClick={() => removeOption(questionIndex, optionIndex)} disabled={question.options.length <= 2} aria-label={`Remove option ${String.fromCharCode(65 + optionIndex)}`}><Icon name="close" size={17} /></button>
                        </div>
                      );
                    })}
                    <button type="button" className="btn btn-ghost btn-sm add-option" onClick={() => addOption(questionIndex)} disabled={question.options.length >= 6}><Icon name="add" size={17} />Add option</button>
                  </div>
                )}

                <label className="field"><span>Explanation</span><textarea className="input" value={question.explanation} onChange={(event) => updateQuestion(questionIndex, 'explanation', event.target.value)} placeholder="Explain why the selected answer is correct…" rows={3} /></label>
              </fieldset>
            ))}
          </div>
          <div className="editor-foot">
            <button type="button" className="btn btn-ghost" onClick={() => setQuestions((current) => [...current, freshQuestion()])}><Icon name="add_circle" size={18} />Add question</button>
            <span>{questions.length} {questions.length === 1 ? 'question' : 'questions'} · single, multi, or short response</span>
            <button className="btn btn-primary" type="submit" disabled={saving || !materials.length}>{saving ? <Spinner size={17} /> : <Icon name="save" size={18} />}Save quiz</button>
          </div>
        </form>
      </section>
    </div>
  );
}
