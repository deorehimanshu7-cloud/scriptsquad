import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useApp } from "./lib/state";
import { getToken } from "./lib/api";
import Landing from "./pages/Landing";
import Auth from "./pages/Auth";
import AppLayout from "./pages/app/AppLayout";
import World from "./pages/app/World";
import Twin from "./pages/app/Twin";
import Evidence from "./pages/app/Evidence";
import Intel from "./pages/app/Intel";
import Satellite from "./pages/app/Satellite";
import Sensors from "./pages/app/Sensors";
import Assistant from "./pages/app/Assistant";
import VoicePage from "./pages/app/Voice";
import Simulation from "./pages/app/Simulation";
import Notes from "./pages/app/Notes";
import System from "./pages/app/System";
import Fields from "./pages/app/Fields";
import History from "./pages/app/History";
import InvestigationsPage from "./pages/app/Investigations";
import { CropPage, SoilPage, TerrainPage, WaterPage, WeatherPage } from "./pages/app/layers";

function RequireAuth({ children }: { children: ReactNode }) {
  const { booting } = useApp();
  const location = useLocation();
  if (booting) {
    return (
      <div className="loading-block" style={{ height: "100vh" }}>
        <span className="spinner" /> Opening your workspace…
      </div>
    );
  }
  if (!getToken()) {
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/auth?returnTo=${returnTo}`} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/auth" element={<Auth />} />
      <Route
        path="/app"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<World />} />
        <Route path="twin" element={<Twin />} />
        <Route path="fields" element={<Fields />} />
        <Route path="evidence" element={<Evidence />} />
        <Route path="weather" element={<WeatherPage />} />
        <Route path="water" element={<WaterPage />} />
        <Route path="soil" element={<SoilPage />} />
        <Route path="terrain" element={<TerrainPage />} />
        <Route path="crop" element={<CropPage />} />
        <Route path="intelligence" element={<Intel />} />
        <Route path="investigations" element={<InvestigationsPage />} />
        <Route path="history" element={<History />} />
        <Route path="satellite" element={<Satellite />} />
        <Route path="sensors" element={<Sensors />} />
        <Route path="assistant" element={<Assistant />} />
        <Route path="voice" element={<VoicePage />} />
        <Route path="simulation" element={<Simulation />} />
        <Route path="notes" element={<Notes />} />
        <Route path="system" element={<System />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}