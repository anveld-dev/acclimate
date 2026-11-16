import {
  Fragment,
  forwardRef,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { highlightCode, syntaxLanguage } from '../lib/highlighter';
import { sourceLines } from '../lib/syntax-source';

type SyntaxCodeProps = Omit<ComponentProps<'pre'>, 'children'> & {
  code: string;
  language?: string;
  path?: string;
  wrap?: boolean;
};
const MAX_HIGHLIGHT_LENGTH = 100_000;

/** Exact, selectable source first; syntax colors enhance it after hydration. */
export const SyntaxCode = forwardRef<HTMLPreElement, SyntaxCodeProps>(function SyntaxCode(
  { code, language, path, wrap = true, className = '', ...props },
  ref,
) {
  const selectedLanguage = syntaxLanguage(path, language);
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language: string;
    lines: ReactNode[][];
  }>();
  useEffect(() => {
    let active = true;
    if (!selectedLanguage || code.length > MAX_HIGHLIGHT_LENGTH) return;
    void highlightCode(code, selectedLanguage)
      .then((lines) => {
        if (active && lines) setHighlighted({ code, language: selectedLanguage, lines });
      })
      .catch(() => {
        /* Source remains readable when a grammar cannot load. */
      });
    return () => {
      active = false;
    };
  }, [code, selectedLanguage]);
  const lines = sourceLines(code);
  const tokens =
    highlighted?.code === code &&
    highlighted.language === selectedLanguage &&
    highlighted.lines.length === lines.length
      ? highlighted.lines
      : undefined;
  return (
    <pre
      {...props}
      ref={ref}
      tabIndex={props.tabIndex ?? 0}
      data-syntax-language={selectedLanguage ?? 'text'}
      data-highlighted={tokens ? 'true' : 'false'}
      data-wrap={wrap || undefined}
      className={`syntax-code ${className}`}
    >
      <code>
        {tokens
          ? lines.map((line, index) => (
              <Fragment key={index}>
                {tokens[index]}
                {line.ending}
              </Fragment>
            ))
          : code}
      </code>
    </pre>
  );
});
