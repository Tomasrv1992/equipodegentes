import { Routes, Route } from "react-router-dom";
import LoginGate from "./components/LoginGate";
import Layout from "./components/Layout";
import Home from "./routes/home";
import FeedRoute from "./routes/feed";
import RunRoute from "./routes/run";
import ClienteRoute from "./routes/cliente";

function Placeholder({ name }: { name: string }) {
  return <h2 className="font-serif text-2xl">{name}</h2>;
}

export default function App() {
  return (
    <LoginGate>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/feed" element={<FeedRoute />} />
          <Route path="/run/:id" element={<RunRoute />} />
          <Route path="/cliente/:slug" element={<ClienteRoute />} />
          <Route path="/agente/:id" element={<Placeholder name="Agente" />} />
          <Route path="*" element={<Placeholder name="404" />} />
        </Routes>
      </Layout>
    </LoginGate>
  );
}
