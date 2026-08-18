import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import './safe-markdown.css';

function safeHref(href = '') {
  if (href.startsWith('#')) return href;
  try {
    const url = new URL(href, window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

export default function SafeMarkdown({ children, className = '', inline = false }) {
  const Wrapper = inline ? 'span' : 'div';
  return (
    <Wrapper className={`safe-markdown ${inline ? 'is-inline' : ''} ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: 'ignore', throwOnError: false }]]}
        skipHtml
        components={{
          p: inline ? ({ children: content }) => <>{content}</> : undefined,
          img: () => null,
          a: ({ href, children: content, ...props }) => {
            const safe = safeHref(href);
            return safe ? <a {...props} href={safe} target={safe.startsWith('#') ? undefined : '_blank'} rel={safe.startsWith('#') ? undefined : 'noopener noreferrer'}>{content}</a> : <span>{content}</span>;
          },
        }}
      >
        {String(children ?? '')}
      </ReactMarkdown>
    </Wrapper>
  );
}
