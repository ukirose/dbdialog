// Primer (GitHub's design system) supplies the colors, type and controls. The
// theme follows the OS: <html> carries data-color-mode="auto" with a light
// and a dark theme, so every part of the page, dialogs included, gets them.
import '@primer/primitives/dist/css/primitives.css';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import { BaseStyles } from '@primer/react';
import { createRoot } from 'react-dom/client';
import { AgentView } from './AgentView';
import { App } from './App';
import './styles.css';

// /?view=agent: the read-only picture for coding agents.
const agent = new URLSearchParams(window.location.search).get('view') === 'agent';

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <BaseStyles className="base">{agent ? <AgentView /> : <App />}</BaseStyles>,
  );
