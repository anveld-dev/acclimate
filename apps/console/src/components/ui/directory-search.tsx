import { Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './input-group';
import { Label } from './label';

type DirectorySearchProps = {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
};

export function DirectorySearch({
  id, label, placeholder, value, onValueChange, disabled, className,
}: DirectorySearchProps) {
  const input = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return (
    <InputGroup className={cn('h-9 pointer-coarse:h-11', className)}>
      <Label className="sr-only" htmlFor={id}>{label}</Label>
      <InputGroupAddon aria-hidden="true"><Search /></InputGroupAddon>
      <InputGroupInput
        ref={input}
        id={id}
        type="search"
        autoComplete="off"
        className="h-full [&::-webkit-search-cancel-button]:hidden"
        placeholder={placeholder}
        value={value}
        disabled={disabled || !ready}
        onChange={(event) => onValueChange(event.currentTarget.value)}
      />
      {value && (
        <InputGroupAddon align="inline-end" className="p-0">
          <InputGroupButton
            size="icon-sm"
            className="pointer-coarse:size-11"
            aria-label="Clear search"
            disabled={disabled || !ready}
            onClick={() => {
              onValueChange('');
              input.current?.focus();
            }}
          >
            <X aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
