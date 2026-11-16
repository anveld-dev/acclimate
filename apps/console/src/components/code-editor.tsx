import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Textarea } from './ui/textarea';
import { reconcileEditorText, sourceRange } from '../lib/syntax-source';
import type { createCodeEditor, EditorOptions } from './code-editor-engine';

export type CodeEditorHandle = { getValue(): string; focus(): void };
export type CodeEditorElement = HTMLElement & { codeEditor?: CodeEditorHandle };
type CodeEditorProps = {
  value: string;
  onChange(value: string): void;
  path?: string;
  language?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
};

/** Shared native-input editor. The public read-only handle also supports host form integrations. */
export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  {
    value,
    onChange,
    path,
    language,
    disabled = false,
    id,
    className = '',
    'aria-label': label = 'Content',
  },
  forwardedRef,
) {
  const host = useRef<(HTMLDivElement & CodeEditorElement) | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLTextAreaElement>(null);
  const engine = useRef<ReturnType<typeof createCodeEditor> | undefined>(undefined);
  const latest = useRef({ value, onChange, path, language, disabled, label });
  latest.current = { value, onChange, path, language, disabled, label };
  const focusRequest = useRef<Element | null | undefined>(undefined);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'fallback'>('loading');
  const handle = useMemo<CodeEditorHandle>(
    () => ({
      getValue: () => engine.current?.getValue() ?? latest.current.value,
      focus: () => {
        if (latest.current.disabled) return;
        if (engine.current) engine.current.focus();
        else {
          focusRequest.current = document.activeElement;
          fallback.current?.focus();
        }
      },
    }),
    [],
  );
  useImperativeHandle(forwardedRef, () => handle, [handle]);
  useLayoutEffect(() => {
    if (phase !== 'ready' || focusRequest.current === undefined) return;
    const active = document.activeElement;
    if (
      active === focusRequest.current ||
      active === document.body ||
      host.current?.contains(active)
    )
      engine.current?.focus();
    focusRequest.current = undefined;
  }, [phase]);
  useLayoutEffect(() => {
    const element = host.current;
    if (element) element.codeEditor = handle;
    return () => {
      if (element?.codeEditor === handle) delete element.codeEditor;
    };
  }, [handle]);
  useLayoutEffect(() => {
    const options: EditorOptions = { value, path, language, disabled, label };
    engine.current?.update(options);
  }, [value, path, language, disabled, label]);
  useEffect(() => {
    let active = true;
    void import('./code-editor-engine')
      .then(({ createCodeEditor }) => {
        if (!active || !surface.current) return;
        const instance = createCodeEditor(surface.current, latest.current, (next) =>
          latest.current.onChange(next),
        );
        engine.current = instance;
        (instance.element as CodeEditorElement).codeEditor = handle;
        setPhase('ready');
      })
      .catch(() => {
        if (active) setPhase('fallback');
      });
    return () => {
      active = false;
      const instance = engine.current;
      if (instance) {
        delete (instance.element as CodeEditorElement).codeEditor;
        instance.destroy();
      }
      engine.current = undefined;
    };
  }, [handle]);
  return (
    <div
      ref={host}
      id={id}
      data-code-editor
      data-slot="textarea"
      aria-disabled={disabled || undefined}
      className={`code-editor ${className}`}
    >
      <div ref={surface} className="code-editor-surface" hidden={phase !== 'ready'} />
      {phase !== 'ready' && (
        <Textarea
          ref={fallback}
          aria-label={label}
          aria-busy={phase === 'loading' || undefined}
          disabled={disabled || phase === 'loading'}
          value={value}
          onChange={(event) => onChange(reconcileEditorText(value, event.target.value))}
          onCopy={(event) => {
            const field = event.currentTarget;
            if (field.selectionStart === field.selectionEnd) return;
            event.clipboardData.setData(
              'text/plain',
              sourceRange(value, field.selectionStart, field.selectionEnd),
            );
            event.preventDefault();
          }}
          className="code-editor-fallback"
        />
      )}
      {phase === 'fallback' && (
        <p role="status" className="code-editor-notice">
          Syntax editor unavailable. Plain-text editing is available.
        </p>
      )}
    </div>
  );
});
