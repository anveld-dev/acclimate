import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { mountMerge } from './file-merge-engine';

function markLineEndings(source: string) {
  return source.replace(/\r\n|\r|\n/g, (ending) =>
    ending === '\r\n' ? ' ⟨CRLF⟩\n' : ending === '\r' ? ' ⟨CR⟩\n' : ' ⟨LF⟩\n',
  );
}

const defaultLabels = ['Original', 'Current'] as const;
export function FileMerge({
  path,
  before,
  after,
  labels = defaultLabels,
}: {
  path: string;
  before: string;
  after: string;
  labels?: readonly [string, string];
}) {
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Awaited<ReturnType<typeof mountMerge>>>(undefined);
  const [width, setWidth] = useState(0);
  const [mode, setMode] = useState<'split' | 'unified'>();
  const [folded, setFolded] = useState(true);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const endingsOnly =
    before !== after && before.replace(/\r\n?/g, '\n') === after.replace(/\r\n?/g, '\n');
  const [inspectEndings, setInspectEndings] = useState(false);
  const showEndings =
    endingsOnly || (inspectEndings && (before.includes('\r') || after.includes('\r')));
  const visible = width > 0;
  const split = width >= 620 && mode !== 'unified';
  const [original, revised] = labels;
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const parent = host.current!;
    setStatus('loading');
    void import('./file-merge-engine')
      .then(({ mountMerge }) =>
        mountMerge(
          parent,
          path,
          showEndings ? markLineEndings(before) : before,
          showEndings ? markLineEndings(after) : after,
          split,
          folded,
          [original, revised],
          controller.signal,
        ),
      )
      .then((instance) => {
        if (controller.signal.aborted) {
          instance?.destroy();
          return;
        }
        editor.current = instance;
        setStatus('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('failed');
      });
    return () => {
      controller.abort();
      editor.current?.destroy();
      editor.current = undefined;
    };
  }, [visible, path, before, after, split, folded, original, revised, showEndings]);
  return (
    <div ref={root} className="file-merge" aria-label={'Changed lines in ' + path} role="region">
      <div className="file-merge-tools" role="group" aria-label="Diff view">
        {width >= 620 && (
          <div className="diff-view-segment" role="group" aria-label="Diff layout">
            <Button size="sm" variant="ghost" aria-pressed={split} onClick={() => setMode('split')}>
              Side by side
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={!split}
              onClick={() => setMode('unified')}
            >
              Unified
            </Button>
          </div>
        )}
        <div className="diff-view-actions" role="group" aria-label="Diff actions">
          <Button size="sm" variant="ghost" onClick={() => setFolded(!folded)}>
            {folded ? 'Show all context' : 'Fold unchanged lines'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={status !== 'ready'}
            onClick={() => editor.current?.navigate(false)}
          >
            Previous change
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={status !== 'ready'}
            onClick={() => editor.current?.navigate(true)}
          >
            Next change
          </Button>
        </div>
      </div>
      {split && (
        <div className="file-merge-labels">
          <span>{original}</span>
          <span>{revised}</span>
        </div>
      )}
      {endingsOnly ? (
        <p>Only line endings changed. Markers show the original line endings.</p>
      ) : (
        (before.includes('\r') || after.includes('\r')) && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={inspectEndings}
            onClick={() => setInspectEndings(!inspectEndings)}
          >
            Show line endings
          </Button>
        )
      )}
      {status === 'failed' && (
        <p role="status">
          Diff editor unavailable. The original and current entries are available below.
        </p>
      )}
      <div ref={host} className="file-merge-host" aria-busy={status === 'loading'} />
    </div>
  );
}
