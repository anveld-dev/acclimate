import {
  StateEffect,
  StateField,
  type Extension,
  type EditorState,
  type Text,
} from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import { applySourceChanges, type SourceChange } from './syntax-source';

function endings(source: string) {
  return (source.match(/\r\n|\r|\n/g) ?? [])
    .map((ending) => (ending === '\r\n' ? 'w' : ending === '\r' ? 'm' : 'l'))
    .join('');
}

/** Raw line endings travel with edit history; text stays in CodeMirror's shared document tree. */
export function sourceDocument(initial: string) {
  const restore = StateEffect.define<{ document: Text; endings: string }>();
  const field = StateField.define<string>({
    create: () => initial,
    update(source, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(restore) && transaction.newDoc.eq(effect.value.document)) {
          let index = 0;
          return transaction.newDoc.toString().replace(/\n/g, () => {
            const ending = effect.value.endings[index++];
            return ending === 'w' ? '\r\n' : ending === 'm' ? '\r' : '\n';
          });
        }
      }
      if (!transaction.docChanged) return source;
      const changes: SourceChange[] = [];
      transaction.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
        changes.push({ from, to, insert: inserted.toString() });
      });
      return applySourceChanges(source, changes);
    },
  });
  const extension: Extension = [
    field,
    invertedEffects.of((transaction) => {
      let changesEndings = transaction.effects.some((effect) => effect.is(restore));
      transaction.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
        if (inserted.lines > 1 || transaction.startState.sliceDoc(from, to).includes('\n'))
          changesEndings = true;
      });
      return changesEndings
        ? [
            restore.of({
              document: transaction.startState.doc,
              endings: endings(transaction.startState.field(field)),
            }),
          ]
        : [];
    }),
  ];
  return { field, extension, read: (state: EditorState) => state.field(field) };
}
