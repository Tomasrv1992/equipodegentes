import { Routes, Route } from "react-router-dom";
import LoginGate from "./components/LoginGate";
import Layout from "./components/Layout";
import Home from "./routes/home";
import FeedRoute from "./routes/feed";
import RunRoute from "./routes/run";
import ClienteRoute from "./routes/cliente";
import AgenteRoute from "./routes/agente";
import AgentesList from "./routes/agentes";
import NuevoCliente from "./routes/nuevo-cliente";
import OnboardingPage from "./routes/onboarding";

function Placeholder({ name }: { name: string }) {
  return <h2 className="font-serif text-2xl">{name}</h2>;
}

export default function App() {
  return (
    <Routes>
      {/* Página pública del cliente (sin LoginGate, sin Layout admin) */}
      <Route path="/onboarding/:token" element={<OnboardingPage />} />

      {/* Resto del panel: protegido por LoginGate */}
      <Route
        path="*"
        element={
          <LoginGate>
            <Layout>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/feed" element={<FeedRoute />} />
                <Route path="/run/:id" element={<RunRoute />} />
                <Route path="/cliente/:slug" element={<ClienteRoute />} />
                <Route path="/agentes" element={<AgentesList />} />
                <Route path="/agente/:id" element={<AgenteRoute />} />
                <Route path="/nuevo-cliente" element={<NuevoCliente />} />
                <Route path="*" element={<Placeholder name="404" />} />
              </Routes>
            </Layout>
          </LoginGate>
        }
      />
    </Routes>
  );
}
