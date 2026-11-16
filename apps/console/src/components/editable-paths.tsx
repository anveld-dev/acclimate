import { useId, useRef, useState } from 'react';
import type { BundlePayload } from '@acclimate/sdk';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Label } from './ui/label';

export function EditablePaths({
  files,
  paths,
  disabled,
  onPathsChange,
}: {
  files: BundlePayload['files'];
  paths: string[];
  disabled: boolean;
  onPathsChange(value: string[]): void;
}) {
  const [search, setSearch] = useState('');
  const searchId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const visible = files.filter((file) => file.path.toLowerCase().includes(search.toLowerCase()));
  const visiblePaths = new Set(visible.map((file) => file.path));
  const hiddenCount = paths.filter((path) => !visiblePaths.has(path)).length;

  return (
    <fieldset className="suggestion-scope min-w-0">
      <legend>Editable paths</legend>
      <p>Editable paths restrict changes, not reading.</p>
      {files.length > 8 && (
        <div className="suggestion-path-search">
          <Label htmlFor={searchId}>Search editable paths</Label>
          <Input
            id={searchId}
            ref={inputRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearch('');
                inputRef.current?.focus();
              }}
            >
              Clear search
            </Button>
          )}
        </div>
      )}
      <div className="suggestion-path-list">
        {files.length === 0 ? (
          <p>No editable paths available.</p>
        ) : visible.length === 0 ? (
          <p>No matching paths.</p>
        ) : (
          visible.map((file) => (
            <Label key={file.path} className="suggestion-path-row">
              <Checkbox
                aria-label={file.path}
                disabled={disabled}
                checked={paths.includes(file.path)}
                onCheckedChange={(checked) =>
                  onPathsChange(
                    checked === true
                      ? [...paths, file.path]
                      : paths.filter((path) => path !== file.path),
                  )
                }
              />
              <span>{file.path}</span>
            </Label>
          ))
        )}
      </div>
      <p className="suggestion-path-summary">
        {paths.length} selected · {files.length} files
        {search && hiddenCount > 0 && ` · ${hiddenCount} selected outside search`}
      </p>
    </fieldset>
  );
}
