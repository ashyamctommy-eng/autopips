import { createRoot } from 'react-dom/client';
import { setBaseUrl } from '@workspace/api-client-react';

import App from './App';
import './app/globals.css';
import { API_BASE_URL } from './lib/api-request';

// Configure generated API hooks as well as the app's hand-written request
// helpers to use the same Render API origin when this UI is deployed on Vercel.
setBaseUrl(API_BASE_URL || null);
createRoot(document.getElementById('root')!).render(<App />);
