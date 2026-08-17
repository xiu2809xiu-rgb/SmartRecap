import { useEffect, useMemo, useRef, useState } from 'react';
import { initialMaterials, questions } from './data.js';

const Icon = ({ children, className = '' }) => <span className={`material-symbols-rounded ${className}`}>{children}</span>;
const fileIcon = (type) => type === 'pptx' ? 'slideshow' : type === 'docx' ? 'article' : 'picture_as_pdf';
const fileType = (name) => name.toLowerCase().endsWith('.pptx') ? 'pptx' : name.toLowerCase().endsWith('.docx') ? 'docx' : 'pdf';

function Header({ screen, go }) {
  return <header className="appbar">
    <button className="brand" onClick={() => go('upload')} aria-label="SmartRecap home"><span className="brandmark"><Icon>auto_stories</Icon></span>SmartRecap</button>
    <nav className="topnav" aria-label="Primary navigation">
      <button className={`navbtn ${screen === 'upload' ? 'active' : ''}`} onClick={() => go('upload')}><Icon>add_circle</Icon>New recap</button>
      <button className={`navbtn ${screen === 'dashboard' ? 'active' : ''}`} onClick={() => go('dashboard')}><Icon>grid_view</Icon>My materials</button>
    </nav>
    <button className="new-btn" onClick={() => go('upload')}><Icon>upload</Icon>Upload notes</button>
  </header>;
}

function FileCard({ material, compact = false, onOpen, onQuiz }) {
  if (compact) return <article className="card mini-card">
    <span className={`file-icon ${material.type}`}><Icon>{fileIcon(material.type)}</Icon></span>
    <div className="truncate"><h3>{material.name}</h3><p>{material.date} · {material.score == null ? 'Not quizzed' : `${material.score}% quiz score`}</p></div>
    <button className="icon-btn" onClick={onOpen} aria-label={`Open ${material.name}`}><Icon>arrow_forward</Icon></button>
  </article>;
  return <article className="card material-card">
    <div className="material-top"><span className={`file-icon ${material.type}`}><Icon>{fileIcon(material.type)}</Icon></span><span className="date">{material.date}</span></div>
    <h3>{material.name}</h3><p>{material.description}</p>
    <div className="score-line"><span>Latest quiz score</span><strong>{material.score == null ? 'Not taken' : `${material.score}%`}</strong></div>
    <div className="scorebar"><span style={{ width: `${material.score || 0}%` }} /></div>
    <div className="card-actions"><button className="secondary" onClick={onOpen}><Icon>refresh</Icon>Revise again</button><button className="icon-btn" onClick={onQuiz} aria-label="Start quiz"><Icon>quiz</Icon></button></div>
  </article>;
}

function UploadScreen({ materials, mode, setMode, selectedFile, setSelectedFile, onCreate, go, notify }) {
  const inputRef = useRef(null);
  const validateFile = (file) => {
    if (!file) return;
    const extension = file.name.split('.').pop().toLowerCase();
    if (!['pdf', 'pptx', 'docx'].includes(extension)) return notify('Please choose a PDF, PPTX or DOCX file.');
    if (file.size > 25 * 1024 * 1024) return notify('That file is over the 25 MB demo limit.');
    setSelectedFile(file);
  };
  return <section className="screen upload-screen">
    <div className="hero-upload"><div className="upload-intro"><p className="eyebrow">Your 10-minute study rescue</p><h1 className="page-title">Missed class?<br />You’re not behind.</h1><p className="lede">Drop in your lecture material. We’ll pull out what matters, show the sources, and build a quick quiz while your coffee is still warm.</p><div className="trust-row"><span><Icon>verified_user</Icon>Source-grounded</span><span><Icon>bolt</Icon>Ready in moments</span><span><Icon>visibility</Icon>Citations included</span></div></div>
    <div className="card upload-panel">
      {selectedFile && <div className="picked-file"><span className={`file-icon ${fileType(selectedFile.name)}`}><Icon>{fileIcon(fileType(selectedFile.name))}</Icon></span><div><strong>{selectedFile.name}</strong><small>{(selectedFile.size / 1048576).toFixed(1)} MB · Ready to recap</small></div></div>}
      <div className="dropzone" role="button" tabIndex="0" onClick={() => inputRef.current?.click()} onKeyDown={(e) => ['Enter', ' '].includes(e.key) && inputRef.current?.click()} onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag'); }} onDragLeave={(e) => e.currentTarget.classList.remove('drag')} onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('drag'); validateFile(e.dataTransfer.files[0]); }}>
        <div className="drop-icon"><Icon>upload_file</Icon></div><h3>Drop your lecture file here</h3><p>PDF, PPTX or DOCX · up to 25 MB</p><button className="secondary" type="button" onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>Choose a file</button><input ref={inputRef} type="file" accept=".pdf,.pptx,.docx" hidden onChange={(e) => validateFile(e.target.files[0])} />
      </div>
      <span className="mode-label">How much detail do you need?</span><div className="segment"><button className={mode === 'cram' ? 'active' : ''} onClick={() => setMode('cram')}><Icon>bolt</Icon> Last-Minute Cram</button><button className={mode === 'deep' ? 'active' : ''} onClick={() => setMode('deep')}><Icon>menu_book</Icon> Deep Revision</button></div>
      <button className="primary create-recap" onClick={onCreate}><Icon>auto_awesome</Icon>Create my recap</button>
    </div></div>
    <div className="section-head"><div><h2>Pick up where you left off</h2><p>Your recent study materials</p></div><button className="link-btn" onClick={() => go('dashboard')}>View all →</button></div>
    <div className="recent-grid">{materials.slice(0, 3).map((item) => <FileCard key={item.id} compact material={item} onOpen={() => go('recap')} />)}</div>
  </section>;
}

const processingStages = [
  ['document_scanner', 'Reading your file'], ['neurology', 'Finding key concepts'], ['fact_check', 'Checking accuracy'], ['quiz', 'Building your quiz'],
];
function ProcessingScreen({ fileName, progress, stage }) {
  return <section className="screen processing-screen" aria-live="polite"><div className="processing-wrap"><div className="card processing-card">
    <div className="processing-visual"><Icon>document_scanner</Icon></div><p className="eyebrow">SmartRecap is working</p><h1>Turning notes into clarity</h1><p>{fileName}</p>
    <div className="progress-track" role="progressbar" aria-label="Recap progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div><div className="progress-meta"><span>{stage < 4 ? `${processingStages[stage]?.[1]}…` : 'Your recap is ready'}</span><span>{progress}%</span></div>
    <div className="stages">{processingStages.map(([icon, label], index) => <div key={label} className={`stage ${index < stage ? 'done' : index === stage ? 'current' : ''}`}><span className="stage-icon"><Icon>{index < stage ? 'check' : icon}</Icon></span>{label}</div>)}</div>
  </div></div></section>;
}

const Citation = ({ children, onClick }) => <button className="citation" onClick={() => onClick(`${children} · Source preview opened`)}>{children}</button>;
function RecapScreen({ fileName, mode, onQuiz, notify }) {
  return <section className="screen recap-screen"><div className="recap-shell"><div className="recap-main">
    <article className="card recap-hero"><p className="eyebrow">Recap ready · 8 min read</p><h1>Database Systems: Normalisation & SQL Joins</h1><p>This lesson explains how relational databases reduce duplicated data through normalisation, then reconnect related tables using primary keys, foreign keys, and SQL joins.</p><div className="hero-meta"><span className="chip"><Icon>description</Icon>{fileName}</span><span className="chip"><Icon>speed</Icon>{mode === 'cram' ? 'Cram mode' : 'Deep revision'}</span><span className="chip"><Icon>verified</Icon>94% source coverage</span></div></article>
    <article className="card content-card"><h2><span className="title-icon"><Icon>stars</Icon></span>Key takeaways</h2><ul className="takeaways">
      <li><Icon className="check">check_circle</Icon><span>Normalisation organises data to reduce redundancy and avoid update, insert, and delete anomalies. <Citation onClick={notify}>Slide 6</Citation></span></li>
      <li><Icon className="check">check_circle</Icon><span>A table is in 3NF when it is in 2NF and has no transitive dependency on its primary key. <Citation onClick={notify}>Slide 14</Citation></span></li>
      <li><Icon className="check">check_circle</Icon><span>Primary keys uniquely identify rows; foreign keys link a row to a key in another table. <Citation onClick={notify}>Slide 18</Citation></span></li>
      <li><Icon className="check">check_circle</Icon><span>INNER JOIN returns matching rows, while LEFT JOIN keeps every row from the left table. <Citation onClick={notify}>Slide 27</Citation></span></li>
    </ul></article>
    <article className="card content-card"><h2><span className="title-icon"><Icon>dictionary</Icon></span>Definitions to know</h2><dl className="definitions">
      <div><dt>Functional dependency <Citation onClick={notify}>S8</Citation></dt><dd>When one attribute uniquely determines another, written as A → B.</dd></div><div><dt>Primary key <Citation onClick={notify}>S17</Citation></dt><dd>A minimal attribute or set of attributes that uniquely identifies each record.</dd></div><div><dt>Transitive dependency <Citation onClick={notify}>S13</Citation></dt><dd>When a non-key attribute depends on another non-key attribute.</dd></div><div><dt>Foreign key <Citation onClick={notify}>S18</Citation></dt><dd>An attribute that references a primary key in a related table.</dd></div>
    </dl></article>
    <article className="card content-card"><h2><span className="title-icon"><Icon>account_tree</Icon></span>Topic breakdown</h2><div className="topic"><h3>1. Why normalise?</h3><p>Repeated values waste space and allow contradictory updates. Splitting data into related tables gives each fact one reliable home. The goal is integrity—not simply creating more tables. <Citation onClick={notify}>Slides 4–7</Citation></p></div><div className="topic"><h3>2. From 1NF to 3NF</h3><p><strong>1NF</strong> removes repeating groups, <strong>2NF</strong> removes partial dependencies, and <strong>3NF</strong> removes transitive dependencies. <Citation onClick={notify}>Slides 9–15</Citation></p></div><div className="topic"><h3>3. Bringing tables back together</h3><p>JOIN conditions usually match a foreign key to a primary key. Choose the join type based on whether unmatched records should be excluded or retained. <Citation onClick={notify}>Slides 24–30</Citation></p></div></article>
  </div><aside className="recap-side"><div className="card side-card"><h3>Your recap at a glance</h3><div className="completion-ring"><strong>8 min</strong></div><div className="side-list"><div><span>Key takeaways</span><strong>4</strong></div><div><span>Core definitions</span><strong>4</strong></div><div><span>Quiz questions</span><strong>8</strong></div></div><button className="primary quiz-cta" onClick={onQuiz}><Icon>play_arrow</Icon>Start quick quiz</button></div><div className="card side-card"><div className="accuracy"><Icon>verified</Icon><div><strong>Accuracy checked</strong><br />Claims are linked to your source. One quiz item is marked for review.</div></div></div></aside></div></section>;
}
function QuizScreen({ index, selected, checked, onSelect, onAdvance, onClose }) {
  const item = questions[index];
  return <section className="screen quiz-screen"><div className="quiz-wrap"><div className="quiz-top"><span className="quiz-count">Question {index + 1} of {questions.length}</span><div className="quiz-track"><span style={{ width: `${((index + 1) / questions.length) * 100}%` }} /></div><button className="icon-btn" onClick={onClose} aria-label="Close quiz"><Icon>close</Icon></button></div>
    <div className="card quiz-card"><div className="quiz-tag"><span className="topic-chip">{item.topic}</span>{!item.verified && <span className="unverified"><Icon>shield_question</Icon>Unverified · not scored</span>}</div><h1>{item.prompt}</h1><div className="answers">{item.options.map((option, optionIndex) => {
      const state = checked ? optionIndex === item.answer ? 'correct' : optionIndex === selected ? 'wrong' : '' : optionIndex === selected ? 'selected' : '';
      return <button key={option} className={`answer ${state}`} disabled={checked} onClick={() => onSelect(optionIndex)}><span className="letter">{String.fromCharCode(65 + optionIndex)}</span><span>{option}</span>{checked && optionIndex === item.answer && <Icon>check_circle</Icon>}{checked && optionIndex === selected && optionIndex !== item.answer && <Icon>cancel</Icon>}</button>;
    })}</div>
    {checked && <div className={`feedback show ${selected === item.answer ? 'correct' : 'wrong'}`}><Icon>{selected === item.answer ? 'celebration' : 'lightbulb'}</Icon><div><h3>{selected === item.answer ? 'Exactly right.' : 'Not quite — you’re learning.'}</h3><p>{item.explanation}</p></div></div>}
    <div className="quiz-actions"><span>Choose the best answer</span><button className="primary" disabled={selected == null} onClick={onAdvance}>{checked ? index === questions.length - 1 ? 'See my results' : 'Next question' : 'Check answer'}<Icon>arrow_forward</Icon></button></div></div>
  </div></section>;
}

function ResultsScreen({ answers, go, retry }) {
  const verified = answers.filter((item) => item.verified);
  const correct = verified.filter((item) => item.correct).length;
  const score = verified.length ? Math.round((correct / verified.length) * 100) : 0;
  const weakTopics = [...new Set(verified.filter((item) => !item.correct).map((item) => item.topic))];
  const topicScores = [...new Set(verified.map((item) => item.topic))].map((topic) => { const rows = verified.filter((item) => item.topic === topic); return { topic, right: rows.filter((item) => item.correct).length, total: rows.length }; });
  return <section className="screen results-screen"><div className="card results-hero"><div className="score-orbit" style={{ '--score': `${score}%` }}><div className="score-inner"><strong>{score}%</strong><span>verified score</span></div></div><div className="results-copy"><p className="eyebrow">Quiz complete</p><h1>{score >= 80 ? 'Strong finish — you’ve got this.' : score >= 60 ? 'Nice work — keep the momentum.' : 'Good start — now make it stick.'}</h1><p>You got {correct} of {verified.length} verified questions right. Here’s the shortest path to improve.</p><div className="results-actions"><button className="primary" onClick={() => go('recap')}><Icon>menu_book</Icon>Review recap</button><button className="secondary" onClick={retry}><Icon>refresh</Icon>Try again</button></div></div></div>
    <div className="results-grid"><article className="card result-card"><h2>Topics to revise</h2>{weakTopics.length ? weakTopics.map((topic, index) => <div className="revise-item" key={topic}><span className="revise-icon"><Icon>{topic === 'SQL Joins' ? 'join_inner' : topic === 'Keys' ? 'key' : 'account_tree'}</Icon></span><div><h3>{topic}</h3><p>Revisit this concept in the linked recap section</p></div><span className="priority">{index ? 'Review' : 'Focus first'}</span></div>) : <div className="accuracy"><Icon>workspace_premium</Icon><div><strong>No weak spots found</strong><br />You answered every verified question correctly.</div></div>}</article>
    <aside className="card result-card"><h2>Your breakdown</h2><div className="verify-note"><Icon>shield_question</Icon><div><strong>Fair scoring, always</strong><p>Question 6 was flagged as unverified and excluded from your score.</p></div></div><div className="breakdown">{topicScores.map(({ topic, right, total }) => <div className="break-row" key={topic}><span>{topic}</span><strong>{right}/{total}</strong><div className="tiny-bar"><span style={{ width: `${(right / total) * 100}%` }} /></div></div>)}</div></aside></div>
  </section>;
}

function DashboardScreen({ materials, go, startQuiz }) {
  const [search, setSearch] = useState('');
  const filtered = materials.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
  const scored = materials.filter((item) => item.score != null);
  const average = scored.length ? Math.round(scored.reduce((sum, item) => sum + item.score, 0) / scored.length) : 0;
  return <section className="screen dashboard-screen"><div className="dashboard-hero"><div><p className="eyebrow">Your study space</p><h1 className="page-title">Welcome back, Rihan.</h1><p className="lede">Small sessions add up. Here’s everything you’ve recapped.</p></div><div className="stats"><div><strong>{materials.length}</strong><span>Materials</span></div><div><strong>{average}%</strong><span>Avg. score</span></div><div><strong>3.2h</strong><span>Time saved</span></div></div></div>
    <div className="filter-row"><label className="search"><Icon>search</Icon><input value={search} onChange={(e) => setSearch(e.target.value)} type="search" placeholder="Search your materials…" aria-label="Search materials" /></label><button className="secondary"><Icon>tune</Icon><span className="filter-label">Filter</span></button></div>
    <div className="material-grid">{filtered.length ? filtered.map((item) => <FileCard key={item.id} material={item} onOpen={() => go('recap')} onQuiz={startQuiz} />) : <div className="card empty">No materials match that search.</div>}</div>
  </section>;
}

function MobileNav({ screen, go, startQuiz }) {
  return <nav className="mobile-nav" aria-label="Mobile navigation"><button className={screen === 'upload' ? 'active' : ''} onClick={() => go('upload')}><Icon>add_circle</Icon>New recap</button><button className={screen === 'dashboard' ? 'active' : ''} onClick={() => go('dashboard')}><Icon>grid_view</Icon>Materials</button><button className={screen === 'quiz' ? 'active' : ''} onClick={startQuiz}><Icon>quiz</Icon>Quiz</button></nav>;
}

export default function App() {
  const [screen, setScreen] = useState('upload');
  const [materials, setMaterials] = useState(initialMaterials);
  const [selectedFile, setSelectedFile] = useState(null);
  const [currentFile, setCurrentFile] = useState(initialMaterials[0].name);
  const [mode, setMode] = useState('cram');
  const [progress, setProgress] = useState(8);
  const [stage, setStage] = useState(0);
  const [toast, setToast] = useState('');
  const [quizIndex, setQuizIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState(null);
  const [checked, setChecked] = useState(false);
  const [answers, setAnswers] = useState([]);
  const toastTimer = useRef(null);
  const go = (next) => { setScreen(next); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const notify = (message) => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 2400); };
  const createRecap = () => { setCurrentFile(selectedFile?.name || initialMaterials[0].name); setProgress(8); setStage(0); go('processing'); };
  useEffect(() => {
    if (screen !== 'processing') return undefined;
    const values = [24, 49, 73, 94, 100];
    const timers = values.map((value, index) => setTimeout(() => { setProgress(value); setStage(index); if (index === values.length - 1) setTimeout(() => {
      if (selectedFile) setMaterials((items) => [{ id: Date.now(), name: selectedFile.name, type: fileType(selectedFile.name), date: 'Just now', description: 'Your newest AI-generated recap, ready for review.', score: null }, ...items]);
      setSelectedFile(null); go('recap');
    }, 500); }, 650 + index * 700));
    return () => timers.forEach(clearTimeout);
  }, [screen]);
  const startQuiz = () => { setQuizIndex(0); setSelectedAnswer(null); setChecked(false); setAnswers([]); go('quiz'); };
  const advanceQuiz = () => {
    const question = questions[quizIndex];
    if (!checked) { setAnswers((items) => [...items, { topic: question.topic, correct: selectedAnswer === question.answer, verified: question.verified }]); setChecked(true); return; }
    if (quizIndex < questions.length - 1) { setQuizIndex((value) => value + 1); setSelectedAnswer(null); setChecked(false); return; }
    const verified = answers.filter((item) => item.verified); const score = Math.round((verified.filter((item) => item.correct).length / verified.length) * 100);
    setMaterials((items) => items.map((item) => item.name === currentFile ? { ...item, score } : item)); go('results');
  };
  const current = useMemo(() => ({
    upload: <UploadScreen materials={materials} mode={mode} setMode={setMode} selectedFile={selectedFile} setSelectedFile={setSelectedFile} onCreate={createRecap} go={go} notify={notify} />,
    processing: <ProcessingScreen fileName={currentFile} progress={progress} stage={stage} />,
    recap: <RecapScreen fileName={currentFile} mode={mode} onQuiz={startQuiz} notify={notify} />,
    quiz: <QuizScreen index={quizIndex} selected={selectedAnswer} checked={checked} onSelect={setSelectedAnswer} onAdvance={advanceQuiz} onClose={() => go('recap')} />,
    results: <ResultsScreen answers={answers} go={go} retry={startQuiz} />,
    dashboard: <DashboardScreen materials={materials} go={go} startQuiz={startQuiz} />,
  })[screen], [screen, materials, mode, selectedFile, currentFile, progress, stage, quizIndex, selectedAnswer, checked, answers]);
  return <><Header screen={screen} go={go} /><main>{current}</main><MobileNav screen={screen} go={go} startQuiz={startQuiz} /><div className={`toast ${toast ? 'show' : ''}`} role="status">{toast}</div></>;
}
