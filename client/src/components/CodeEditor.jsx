import { useRef, useState, useEffect } from 'react';
import Prism from 'prismjs';

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Prism is slow on large files, so highlighting is debounced behind the textarea.
const HIGHLIGHT_DELAY = 200;

function highlightCode(text, language) {
  let html = Prism.highlight(text, Prism.languages[language], language);
  if (text.endsWith('\n')) html += '\n';
  return html;
}

export default function CodeEditor({ value, onChange, language }) {
  const textareaRef = useRef(null);
  const preRef = useRef(null);
  const useHighlight = language && language !== 'plaintext' && !!Prism.languages[language];

  // Seed with the initial value highlighted so entering edit mode isn't a flash of plain text.
  // `text` records which value `html` was produced from.
  const [highlighted, setHighlighted] = useState(() => (
    useHighlight ? { text: value, html: highlightCode(value, language) } : { text: null, html: '' }
  ));

  useEffect(() => {
    if (!useHighlight) return;
    if (highlighted.text === value) return;
    const t = setTimeout(() => {
      setHighlighted({ text: value, html: highlightCode(value, language) });
    }, HIGHLIGHT_DELAY);
    return () => clearTimeout(t);
  }, [value, language, useHighlight, highlighted.text]);

  // Use the highlighted html only if it matches the current value; otherwise escape it.
  let body;
  if (useHighlight && highlighted.text === value) {
    body = highlighted.html;
  } else {
    body = escapeHtml(value);
    if (value.endsWith('\n')) body += '\n';
  }

  const syncScroll = () => {
    if (preRef.current && textareaRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop;
      preRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = value.slice(0, start) + '  ' + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  };

  return (
    <div className="code-editor">
      <pre
        ref={preRef}
        className={`code-editor-highlight language-${useHighlight ? language : 'plaintext'}`}
        aria-hidden="true"
      >
        <code dangerouslySetInnerHTML={{ __html: body }} />
      </pre>
      <textarea
        ref={textareaRef}
        className="code-editor-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
      />
    </div>
  );
}
