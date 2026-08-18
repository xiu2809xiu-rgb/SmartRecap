const CODE_START = /^(?:import\s|from\s+\S+\s+import|def\s|class\s|function\s|const\s|let\s|var\s|async\s+function|if\s*\(|for\s*\(|while\s*\(|try\s*\{|catch\s*\(|@\w+|\$\s|>>>\s|docker\s|git\s|npm\s|npx\s|pip\s|curl\s)/;
const SQL_START = /^(?:SELECT|CREATE|INSERT|UPDATE|DELETE)\s/i;

function isCodeLine(line, continuing = false) {
  const value = line.trim();
  if (!value) return false;
  if (CODE_START.test(value) || SQL_START.test(value)) return true;
  if (/^<\/?[A-Za-z][^>]*>$/.test(value)) return true;
  if (/(?:=>|===|!==|\{\s*$)/.test(value)) return true;
  if (continuing && (/^[}\])]/.test(value) || /^\s{2,}\S/.test(line) || /[;,{]$/.test(value))) return true;
  return false;
}

function languageFor(code, hint = '') {
  if (hint) return hint.toLowerCase();
  if (/\b(?:def|import|from\s+\S+\s+import|print)\b/.test(code)) return 'python';
  if (/\b(?:const|let|function|=>|console\.log)\b/.test(code)) return 'javascript';
  if (/\b(?:SELECT|CREATE TABLE|INSERT INTO|UPDATE\s+\S+\s+SET)\b/i.test(code)) return 'sql';
  if (/^(?:docker|git|npm|npx|pip|curl)\s/m.test(code)) return 'shell';
  if (/<\/?[A-Za-z][^>]*>/.test(code)) return 'markup';
  return 'code';
}

function proseBlocks(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks = [];
  let prose = [];
  let code = [];

  const flushProse = () => {
    const value = prose.join(' ').replace(/\s+/g, ' ').trim();
    if (value) blocks.push({ type: 'paragraph', text: value });
    prose = [];
  };
  const flushCode = () => {
    const value = code.join('\n').replace(/\n+$/, '');
    if (value.trim()) blocks.push({ type: 'code', text: value, language: languageFor(value) });
    code = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      const next = lines[index + 1] ?? '';
      if (code.length && (isCodeLine(next, true) || /^\s{2,}\S/.test(next))) {
        code.push('');
        continue;
      }
      flushCode();
      flushProse();
      continue;
    }
    if (isCodeLine(line, code.length > 0)) {
      flushProse();
      code.push(line);
      continue;
    }
    flushCode();
    const words = trimmed.split(/\s+/);
    const headingLike = words.length <= 10 && trimmed.length <= 80 && !/[.!?;]$/.test(trimmed)
      && (/^[A-Z\d][A-Za-z\d &/():+-]+$/.test(trimmed) || trimmed === trimmed.toUpperCase());
    if (headingLike) {
      flushProse();
      blocks.push({ type: 'heading', text: trimmed });
    } else if (/^(?:[-*•]|\d+[.)])\s+/.test(trimmed)) {
      flushProse();
      blocks.push({ type: 'bullet', text: trimmed.replace(/^(?:[-*•]|\d+[.)])\s+/, '') });
    } else {
      prose.push(trimmed);
    }
  }
  flushCode();
  flushProse();
  return blocks;
}

function blocksFor(text) {
  const blocks = [];
  const fence = /```([\w+-]*)\s*\n([\s\S]*?)```|(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])/g;
  let cursor = 0;
  let match;
  while ((match = fence.exec(text))) {
    blocks.push(...proseBlocks(text.slice(cursor, match.index)));
    if (match[2] !== undefined) {
      const code = match[2].replace(/\n$/, '');
      if (code.trim()) blocks.push({ type: 'code', text: code, language: languageFor(code, match[1]) });
    } else if (match[3]) {
      const formula = match[3]
        .replace(/^\$\$|\$\$$/g, '')
        .replace(/^\\\[|\\\]$/g, '')
        .trim();
      if (formula) blocks.push({ type: 'math', text: formula, display: true });
    }
    cursor = fence.lastIndex;
  }
  blocks.push(...proseBlocks(text.slice(cursor)));
  return blocks;
}

export function buildDocumentNotes(chunks = []) {
  return [...chunks]
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0))
    .map((chunk, index) => ({
      id: chunk.id,
      label: chunk.label || `Section ${index + 1}`,
      page: chunk.page ?? index + 1,
      blocks: blocksFor(chunk.text || ''),
    }))
    .filter((section) => section.blocks.length > 0);
}