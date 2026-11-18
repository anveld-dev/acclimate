import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { sourceDocument } from '../lib/editor-source';
import { editorText, sourceRange } from '../lib/syntax-source';
import { syntaxLanguage } from '../lib/highlighter';

export type EditorOptions = {
  value: string;
  path?: string;
  language?: string;
  disabled: boolean;
  lineNumbers?: boolean;
  label: string;
  describedBy?: string;
  invalid?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
};

export const colors = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], class: 'cm-syntax-keyword' },
  { tag: [tags.string, tags.special(tags.string)], class: 'cm-syntax-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'cm-syntax-number' },
  { tag: [tags.comment, tags.meta], class: 'cm-syntax-comment' },
  { tag: [tags.heading, tags.strong], class: 'cm-syntax-heading' },
  { tag: [tags.link, tags.url], class: 'cm-syntax-link' },
  {
    tag: [tags.propertyName, tags.typeName, tags.function(tags.variableName)],
    class: 'cm-syntax-name',
  },
]);

export async function editorLanguage(language: string | null): Promise<Extension> {
  switch (language) {
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'json':
    case 'jsonc':
      return (await import('@codemirror/lang-json')).json();
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({
        typescript: language === 'typescript' || language === 'tsx',
        jsx: language === 'jsx' || language === 'tsx',
      });
    case 'python':
      return (await import('@codemirror/lang-python')).python();
    case 'rust':
      return (await import('@codemirror/lang-rust')).rust();
    case 'bash':
      return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell);
    case 'yaml':
      return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/yaml')).yaml);
    case 'toml':
      return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml);
    default:
      return [];
  }
}

export function createCodeEditor(
  parent: HTMLElement,
  initial: EditorOptions,
  onChange: (value: string) => void,
) {
  let options = initial;
  let source = sourceDocument(options.value);
  const language = new Compartment();
  const editing = new Compartment();
  let languageEpoch = 0;
  let disposed = false;
  const editSettings = () => [
    ...(options.lineNumbers ? [lineNumbers()] : []),
    EditorState.readOnly.of(options.disabled),
    EditorView.editable.of(!options.disabled),
    EditorView.contentAttributes.of({
      'aria-label': options.label,
      ...(options.describedBy !== undefined && { 'aria-describedby': options.describedBy }),
      ...(options.invalid !== undefined && { 'aria-invalid': String(options.invalid) }),
      'aria-disabled': String(options.disabled),
      tabindex: options.disabled ? '-1' : '0',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocorrect: 'off',
    }),
  ];
  const state = () =>
    EditorState.create({
      doc: editorText(options.value),
      extensions: [
        source.extension,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        syntaxHighlighting(colors),
        EditorView.lineWrapping,
        EditorView.domEventHandlers({
          copy(event, current) {
            const selection = current.state.selection.main;
            if (selection.empty || !event.clipboardData) return false;
            event.clipboardData.setData(
              'text/plain',
              sourceRange(source.read(current.state), selection.from, selection.to),
            );
            event.preventDefault();
            return true;
          },
        }),
        EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
        language.of([]),
        editing.of(editSettings()),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(source.read(update.state));
        }),
      ],
    });
  const view = new EditorView({ parent, state: state() });
  async function highlight() {
    const epoch = ++languageEpoch;
    try {
      const extension =
        options.value.length > 200_000
          ? []
          : await editorLanguage(syntaxLanguage(options.path, options.language));
      if (!disposed && epoch === languageEpoch)
        view.dispatch({ effects: language.reconfigure(extension) });
    } catch {
      /* Editing remains available even when a language chunk fails. */
    }
  }
  void highlight();
  return {
    element: view.contentDOM,
    getValue: () => source.read(view.state),
    focus: () => {
      if (!options.disabled) view.focus();
    },
    update(next: EditorOptions) {
      const previous = options;
      options = next;
      if (next.value !== source.read(view.state) || next.path !== previous.path) {
        const focused = view.hasFocus;
        source = sourceDocument(next.value);
        view.setState(state());
        if (focused && !next.disabled) view.focus();
        void highlight();
      } else if (next.language !== previous.language) void highlight();
      if (
        next.disabled !== previous.disabled ||
        next.lineNumbers !== previous.lineNumbers ||
        next.label !== previous.label ||
        next.describedBy !== previous.describedBy ||
        next.invalid !== previous.invalid
      )
        view.dispatch({ effects: editing.reconfigure(editSettings()) });
    },
    destroy() {
      disposed = true;
      languageEpoch++;
      view.destroy();
    },
  };
}
