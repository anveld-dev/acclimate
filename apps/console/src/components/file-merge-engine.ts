import { MergeView, unifiedMergeView, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { syntaxLanguage } from '../lib/highlighter';
import { colors, editorLanguage } from './code-editor-engine';

export async function mountMerge(
  parent: HTMLElement,
  path: string,
  before: string,
  after: string,
  split: boolean,
  folded: boolean,
  labels: readonly [string, string],
  signal: AbortSignal,
) {
  const language = await editorLanguage(syntaxLanguage(path));
  if (signal.aborted) return;
  const extensions = (label: string) => [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    lineNumbers(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      tabindex: '0',
      'aria-label': label + ' · ' + path,
      'aria-readonly': 'true',
    }),
    language,
    syntaxHighlighting(colors),
  ];
  const collapse = folded ? { collapseUnchanged: { margin: 3, minSize: 6 } } : {};
  const editor = split
    ? new MergeView({
        parent,
        ...collapse,
        a: { doc: before, extensions: extensions(labels[0]) },
        b: { doc: after, extensions: extensions(labels[1]) },
      })
    : new EditorView({
        parent,
        doc: after,
        extensions: [
          ...extensions('Unified diff'),
          unifiedMergeView({ original: before, mergeControls: false, ...collapse }),
        ],
      });
  const view = editor instanceof MergeView ? editor.b : editor;
  return {
    destroy: () => editor.destroy(),
    navigate(forward: boolean) {
      (forward ? goToNextChunk : goToPreviousChunk)(view);
      view.focus();
    },
  };
}
