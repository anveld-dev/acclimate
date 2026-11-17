import { Button } from './ui/button';

/** Only public request JSON is supplied here; credentials never enter this component. */
export function EvaluationHandoffDownload({ handoff }: { handoff: string }) {
  function download() {
    const url = URL.createObjectURL(new Blob([handoff + '\n'], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'evaluation-request.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return (
    <Button type="button" variant="outline" onClick={download}>
      Download request JSON
    </Button>
  );
}
