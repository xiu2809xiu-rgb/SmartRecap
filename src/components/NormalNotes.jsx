import { Icon, CopyButton } from './ui.jsx';
import SafeMarkdown from './SafeMarkdown.jsx';
import './normal-notes.css';

function MathText({ children, block = false }) {
  return <SafeMarkdown inline={!block}>{children}</SafeMarkdown>;
}

export default function NormalNotes({ material, sections }) {
  // A material can reach here without a recap -- see the note in Recap.jsx.
  // The document view is built from the extracted chunks, so it still has
  // everything it needs; only the takeaways strip comes from the recap.
  const recap = material.recap ?? {};
  const takeaways = recap.sections?.find((section) => section.id === 'takeaways')?.points ?? [];

  return (
    <div className="document-view">
      <article className="document-paper">
        <header className="document-cover">
          <p className="document-kicker">SmartRecap document notes</p>
          <h1>{material.title}</h1>
          <p>{material.module} · {material.pageCount} pages · source-aligned reading view</p>
        </header>

        <section className="document-overview">
          <h2>Overview</h2>
          <p><MathText>{recap.summary}</MathText></p>
        </section>

        {takeaways.length > 0 && (
          <section className="document-section document-key-points">
            <h2>Key points</h2>
            <ul>{takeaways.map((point) => <li key={point.id}><MathText>{point.text}</MathText></li>)}</ul>
          </section>
        )}

        <nav className="document-contents" aria-label="Document contents">
          <h2>Contents</h2>
          <ol>
            {sections.map((section) => (
              <li key={section.id}><a href={`#note-${section.id}`}>{section.label}</a><span>{section.page}</span></li>
            ))}
          </ol>
        </nav>

        <div className="document-body">
          {sections.map((section, index) => (
            <SourceNoteSection key={section.id} section={section} index={index} />
          ))}
        </div>

        {recap.keyTerms?.length > 0 && (
          <section className="document-section document-glossary">
            <h2>Glossary</h2>
            <dl>
              {recap.keyTerms.map((item) => (
                <div key={item.term}><dt><MathText>{item.term}</MathText></dt><dd><MathText>{item.definition}</MathText></dd></div>
              ))}
            </dl>
          </section>
        )}

        <footer className="document-footer">
          <Icon name="verified" size={17} />
          Generated from {material.fileName}; code blocks preserve extracted source text.
        </footer>
      </article>
    </div>
  );
}

function SourceNoteSection({ section, index }) {
  return (
    <section className="document-section source-note-section" id={`note-${section.id}`}>
      <header>
        <span>{String(index + 1).padStart(2, '0')}</span>
        <div><p>Source section</p><h2>{section.label}</h2></div>
        <span className="source-page">Page {section.page}</span>
      </header>
      <div className="source-note-blocks">
        {section.blocks.map((block, blockIndex) => {
          const key = `${section.id}-${blockIndex}`;
          if (block.type === 'code') {
            return (
              <figure className="document-code" key={key}>
                <figcaption><span>{block.language}</span><CopyButton value={block.text} /></figcaption>
                <pre><code>{block.text}</code></pre>
              </figure>
            );
          }
          if (block.type === 'math') {
            return <div className="document-math" key={key}><MathText block>{`$$\n${block.text}\n$$`}</MathText></div>;
          }
          if (block.type === 'heading') return <h3 key={key}><MathText>{block.text}</MathText></h3>;
          if (block.type === 'bullet') return <p className="document-bullet" key={key}><MathText>{block.text}</MathText></p>;
          return <p key={key}><MathText>{block.text}</MathText></p>;
        })}
      </div>
    </section>
  );
}