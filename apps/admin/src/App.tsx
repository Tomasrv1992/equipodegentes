import LoginGate from "./components/LoginGate";

export default function App() {
  return (
    <LoginGate>
      <div className="min-h-screen bg-paper text-ink p-6">
        <h1 className="font-serif text-3xl">Panel · Equipo de Agentes</h1>
        <p className="text-muted mt-2">Login OK · falta routing.</p>
      </div>
    </LoginGate>
  );
}
