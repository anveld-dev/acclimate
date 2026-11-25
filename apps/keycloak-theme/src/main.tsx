import { createRoot } from 'react-dom/client';
import { KcPage } from './kc.gen';
import './theme.css';

const root = createRoot(document.getElementById('root')!);
if (window.kcContext) root.render(<KcPage kcContext={window.kcContext} />);
else root.render(<main className="auth-page"><h1>Acclimate sign-in theme</h1><p>Open the console’s sign-in page to use this theme with Keycloak.</p></main>);
