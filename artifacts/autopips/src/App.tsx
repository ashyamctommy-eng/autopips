import { Router } from 'wouter';
import { AppProviders } from '@/app/providers';
import { AppRoutes } from '@/routes';

function App() {
  return (
    <AppProviders>
      <Router base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <AppRoutes />
      </Router>
    </AppProviders>
  );
}

export default App;
