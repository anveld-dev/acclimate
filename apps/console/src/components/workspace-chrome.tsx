import { createContext, useContext, type ReactNode, type RefObject } from 'react';
import { Menu } from 'lucide-react';
import { Button } from './ui/button';
import { SheetTrigger } from './ui/sheet';

type WorkspaceChrome = {
  hydrated: boolean;
  menuRef: RefObject<HTMLButtonElement | null>;
};
const Context = createContext<WorkspaceChrome | null>(null);

export function WorkspaceChromeProvider({
  value,
  children,
}: {
  value: WorkspaceChrome;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Optional so page components remain usable outside the application shell. */
export function WorkspaceMenuButton() {
  const chrome = useContext(Context);
  if (!chrome) return null;
  return (
    <div className="workspace-mobile-nav">
      <SheetTrigger asChild>
        <Button
          ref={chrome.menuRef}
          variant="outline"
          size="sm"
          className="workspace-menu-trigger"
          disabled={!chrome.hydrated}
          aria-label="Open navigation"
        >
          <Menu aria-hidden="true" />
          <span className="workspace-menu-label">Menu</span>
        </Button>
      </SheetTrigger>
    </div>
  );
}

export function WorkspaceChromeTools({ className = '' }: { className?: string }) {
  const chrome = useContext(Context);
  if (!chrome) return null;
  return (
    <div className={`workspace-chrome-tools ${className}`}>
      <WorkspaceMenuButton />
    </div>
  );
}
