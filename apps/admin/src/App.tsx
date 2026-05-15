import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import LoginGate from "./components/LoginGate";
import Layout from "./components/Layout";

// Code splitting: cada route se carga on-demand (mejora tiempo de primer
// paint del dashboard y reduce el initial bundle de ~575KB a ~250KB).
// Home queda eager (es la landing del admin, no vale split).
import Home from "./routes/home";
const RunRoute = lazy(() => import("./routes/run"));
const ClienteRoute = lazy(() => import("./routes/cliente"));
const AgenteRoute = lazy(() => import("./routes/agente"));
const AgentesList = lazy(() => import("./routes/agentes"));
const NuevoCliente = lazy(() => import("./routes/nuevo-cliente"));
const OnboardingPage = lazy(() => import("./routes/onboarding"));
const DiagnosticoRoute = lazy(() => import("./routes/diagnostico"));
const ClientesRoute = lazy(() => import("./routes/clientes"));

function Placeholder({ name }: { name: string }) {
  return <h2 className="font-serif text-2xl">{name}</h2>;
}

function RouteLoader() {
  return (
    <div className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase p-6">
      Cargando…
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<RouteLoader />}>
      <Routes>
        {/* Página pública del cliente (sin LoginGate, sin Layout admin) */}
        <Route path="/onboarding/:token" element={<OnboardingPage />} />

        {/* Resto del panel: protegido por LoginGate */}
        <Route
          path="*"
          element={
            <LoginGate>
              <Layout>
                <Suspense fallback={<RouteLoader />}>
                  <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/run/:id" element={<RunRoute />} />
                    <Route path="/clientes" element={<ClientesRoute />} />
                    <Route path="/cliente/:slug" element={<ClienteRoute />} />
                    <Route path="/agentes" element={<AgentesList />} />
                    <Route path="/agente/:id" element={<AgenteRoute />} />
                    <Route path="/diagnostico" element={<DiagnosticoRoute />} />
                    <Route path="/nuevo-cliente" element={<NuevoCliente />} />
                    <Route path="*" element={<Placeholder name="404" />} />
                  </Routes>
                </Suspense>
              </Layout>
            </LoginGate>
          }
        />
      </Routes>
    </Suspense>
  );
}
