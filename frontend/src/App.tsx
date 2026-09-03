import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { I18nextProvider } from 'react-i18next';
import i18n from './lib/i18n/config';

// Layouts
import AppShell from './components/shell/AppShell';

// Pages
import LoginPage from './features/auth/LoginPage';
import FarmsPage from './features/fields/FarmsPage';
import FieldsPage from './features/fields/FieldsPage';
import NewFieldPage from './features/fields/NewFieldPage';
import WorldPage from './features/world-model/WorldPage';
import EvidencePage from './features/evidence/EvidencePage';
import IntelligencePage from './features/world-model/IntelligencePage';
import InvestigationsPage from './features/world-model/InvestigationsPage';
import SatellitePage from './features/satellite/SatellitePage';
import SensorsPage from './features/sensors/SensorsPage';
import WeatherPage from './features/weather/WeatherPage';
import EnvironmentPage from './features/environment/EnvironmentPage';
import DigitalTwinPage from './features/world-model/DigitalTwinPage';
import HistoryPage from './features/world-model/HistoryPage';
import SimulationPage from './features/world-model/SimulationPage';
import AssistantPage from './features/world-model/AssistantPage';
import SettingsPage from './features/world-model/SettingsPage';
import SystemProvidersPage from './features/world-model/SystemProvidersPage';

// Hooks
import { useAuthStore } from './lib/state/auth';

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 1,
    },
  },
});

// Protected Route Component
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuthStore();
  
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  
  return <>{children}</>;
};

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <Router>
          <Routes>
            {/* Public Routes */}
            <Route path="/login" element={<LoginPage />} />
            
            {/* Protected Routes */}
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <AppShell />
                </ProtectedRoute>
              }
            >
              {/* Farm & Field Management */}
              <Route index element={<Navigate to="/farms" replace />} />
              <Route path="farms" element={<FarmsPage />} />
              <Route path="fields" element={<FieldsPage />} />
              <Route path="fields/new" element={<NewFieldPage />} />
              
              {/* Main Workspaces */}
              <Route path="world" element={<WorldPage />} />
              <Route path="intelligence" element={<IntelligencePage />} />
              <Route path="evidence" element={<EvidencePage />} />
              <Route path="investigations" element={<InvestigationsPage />} />
              
              {/* Specialized Data Workspaces */}
              <Route path="satellite" element={<SatellitePage />} />
              <Route path="sensors" element={<SensorsPage />} />
              <Route path="weather" element={<WeatherPage />} />
              <Route path="environment" element={<EnvironmentPage />} />
              
              {/* 3D & Visualization */}
              <Route path="digital-twin" element={<DigitalTwinPage />} />
              <Route path="history" element={<HistoryPage />} />
              <Route path="simulation" element={<SimulationPage />} />
              
              {/* AI & Voice */}
              <Route path="assistant" element={<AssistantPage />} />
              
              {/* System */}
              <Route path="settings" element={<SettingsPage />} />
              <Route path="system/providers" element={<SystemProvidersPage />} />
            </Route>
            
            {/* Catch all - redirect to farms */}
            <Route path="*" element={<Navigate to="/farms" replace />} />
          </Routes>
        </Router>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

export default App;
