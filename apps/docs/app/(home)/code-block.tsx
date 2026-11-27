'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export type Snippet = {
  id: string;
  /** Shown in the toggle when a block has more than one snippet. */
  label: string;
  /** The block's header: a file name, or where a terminal runs. */
  title: string;
  language: 'ts' | 'py' | 'sh';
  code: string;
};

const patterns = {
  ts: /(\/\/.*)|('[^'\n]*'|"[^"\n]*")|\b(import|from|const|await|async|return)\b|\b([a-zA-Z_]\w*)(?=\()/g,
  py: /(#.*)|('[^'\n]*'|"[^"\n]*")|\b(from|import|def|return|with|as)\b|\b([a-zA-Z_]\w*)(?=\()/g,
  sh: /(#.*)|('[^'\n]*'|"[^"\n]*")|^()([\w./-]+)/g,
};

// Ink weights only: keywords, strings, function calls (shell commands) and comments.
function highlight(line: string, language: Snippet['language']): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(patterns[language])) {
    const index = match.index ?? 0;
    if (index > last) out.push(line.slice(last, index));
    const kind = match[1] ? 'com' : match[2] ? 'str' : match[3] ? 'kw' : 'fn';
    // The call the page is about gets the signal underline.
    const marked = kind === 'fn' && match[0] === 'expect';
    out.push(
      <span key={index} className={`lp-syn-${kind}`} data-mark={marked || undefined}>
        {match[0]}
      </span>,
    );
    last = index + match[0].length;
  }
  out.push(line.slice(last));
  return out;
}

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => setCopied(false));
  };
  return { copied, copy };
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <button type="button" className="lp-copy" onClick={copy} aria-label={copied ? 'Copied' : label}>
      <span aria-hidden="true">{copied ? 'copied' : 'copy'}</span>
    </button>
  );
}

/**
 * One bordered code block, or a dark terminal card. With more than one snippet the header shows a
 * text toggle. Terminal lines get a non-selectable `$` prompt, except continuation lines after a
 * trailing backslash, and the last line ends in the signal dot.
 */
export function CodeBlock({
  snippets,
  terminal = false,
}: {
  snippets: Snippet[];
  terminal?: boolean;
}) {
  const [activeId, setActiveId] = useState(snippets[0].id);
  const active = snippets.find((snippet) => snippet.id === activeId) ?? snippets[0];
  const lines = active.code.split('\n');

  return (
    <figure className="lp-code" data-terminal={terminal || undefined}>
      {terminal ? (
        <figcaption className="sr-only">{active.title}</figcaption>
      ) : (
        <figcaption className="lp-code-head">
          {snippets.length > 1 ? (
            <span className="lp-toggle" role="group" aria-label="Language">
              {snippets.map((snippet) => (
                <button
                  key={snippet.id}
                  type="button"
                  aria-pressed={snippet.id === active.id}
                  onClick={() => setActiveId(snippet.id)}
                >
                  {snippet.label}
                </button>
              ))}
            </span>
          ) : (
            <span>{active.label}</span>
          )}
          <span className="lp-code-file">{active.title}</span>
        </figcaption>
      )}
      <CopyButton text={active.code} label={`Copy ${active.title}`} />
      {/* Focusable so keyboard users can scroll a long line. */}
      <pre tabIndex={0} aria-label={active.title}>
        <code>
          {lines.map((line, index) => {
            const continued = index > 0 && lines[index - 1].endsWith('\\');
            return (
              <span key={index} className="lp-code-line">
                {terminal ? (
                  <span className="lp-prompt" aria-hidden="true">
                    {continued ? ' ' : '$'}
                  </span>
                ) : null}
                <span className="lp-code-text">
                  {highlight(line, active.language)}
                  {terminal && index === lines.length - 1 ? (
                    <span className="lp-cursor" aria-hidden="true" />
                  ) : null}
                </span>
                {'\n'}
              </span>
            );
          })}
        </code>
      </pre>
    </figure>
  );
}
