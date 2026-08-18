import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting, indentUnit, bracketMatching } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';

/**
 * CodeMirror 6, wired to this app's design tokens.
 *
 * Chosen over Monaco deliberately. Monaco is the editor from VS Code and looks
 * the part, but its loader fetches from a CDN unless reconfigured, it wants
 * four language-service workers, and it is megabytes — on a page a student
 * reaches from a recap, on conference wifi, during a three-minute demo. This
 * repo also has no worker plumbing to inherit. CodeMirror is a fraction of the
 * size, is plain ESM that Vite handles without configuration, and is better on
 * a touchscreen, which matters because half of revision happens on a phone.
 *
 * Colours come from CSS custom properties rather than a packaged theme. The
 * study surface is light under the default aurora theme and dark under
 * midnight, and the user can change that at any moment from Settings — a
 * hard-coded editor theme would be wrong half the time.
 */

// Sizes are in px rather than rem on purpose. `prefs` scales the root font size
// between 93.75% and 125%, which should move prose and must not move the
// gutter, the line height, or the alignment of a column of code.
const baseTheme = EditorView.theme({
  '&': {
    fontSize: '13.5px',
    backgroundColor: 'var(--ground-sunken)',
    color: 'var(--ink)',
    height: '100%',
  },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.62',
    overflow: 'auto',
  },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--accent-hot)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--ink-4)',
    border: 'none',
    borderRight: '1px solid var(--glass-line)',
    paddingRight: '4px',
  },
  '.cm-activeLine': { backgroundColor: 'var(--tint)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-2)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent-hot)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent-cool) 24%, transparent)',
    outline: 'none',
  },
});

/* The three aurora hues carry the syntax, so code reads as part of the product
   rather than as an editor someone pasted in. Everything structural is ink. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: 'var(--accent-hot)', fontWeight: '650' },
  { tag: [t.definitionKeyword, t.operatorKeyword], color: 'var(--accent)', fontWeight: '650' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--accent-cool)' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--ink)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--good)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--accent-cool)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--ink-4)', fontStyle: 'italic' },
  { tag: [t.className, t.typeName, t.namespace], color: 'var(--accent)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--ink-3)' },
  { tag: t.invalid, color: 'var(--bad)' },
]);

const langOf = (language) => (language === 'javascript' ? javascript() : python());

export default function CodeEditor({ value, language, onChange, readOnly = false }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);

  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          bracketMatching(),
          // Tab indents rather than leaving the editor. It is placed after the
          // default keymap so Escape-then-Tab still gets a keyboard user out —
          // trapping Tab with no escape hatch would fail a keyboard-only user
          // at the one control they cannot avoid.
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          indentUnit.of('    '),
          langOf(language),
          baseTheme,
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // `value` is intentionally not a dependency: this creates the editor, and
    // recreating it on every keystroke would destroy the cursor. External
    // changes are pushed by the effect below. Theme is not a dependency either
    // — the theme above is written entirely in CSS custom properties, so a
    // change of theme or surface repaints the editor without rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly]);

  // Reset-to-starter and switching exercise both replace the document from
  // outside. Only dispatch when it genuinely differs, or every keystroke would
  // round-trip through here and fight the cursor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div className="code-editor" ref={hostRef} />;
}
