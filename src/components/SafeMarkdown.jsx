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

  /**
   * Built as an object rather than an inline literal because `p` must be
   * *absent*, not present-and-undefined, in block mode.
   *
   * react-markdown treats any key in this map as an override and renders its
   * value as the element type. `p: undefined` therefore threw "Element type is
   * invalid: expected a string ... but got: undefined" for every block render
   * containing a paragraph — which is every answer the Ask panel and the coding
   * agent produce, and with no error boundary above them that blanked the page.
   */
  const components = {
    img: () => null,
    a: ({ href, children: content, ...props }) => {
      const safe = safeHref(href);
      return safe ? <a {...props} href={safe} target={safe.startsWith('#') ? undefined : '_blank'} rel={safe.startsWith('#') ? undefined : 'noopener noreferrer'}>{content}</a> : <span>{content}</span>;
    },
  };
  if (inline) components.p = ({ children: content }) => <>{content}</>;

  return (
    <Wrapper className={`safe-markdown ${inline ? 'is-inline' : ''} ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: 'ignore', throwOnError: false }]]}
        skipHtml
        components={components}
      >
        {String(children ?? '')}
      </ReactMarkdown>
    </Wrapper>
  );
}
