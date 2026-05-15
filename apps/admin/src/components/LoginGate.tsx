import { type ReactNode } from "react";
import { useSession, isAllowed } from "../lib/auth";
import Login from "../routes/login";

export default function LoginGate({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted">
        Cargando…
      </div>
    );
  }

  if (!session) return <Login />;

  if (!isAllowed(session)) {
    return (
      <div className="min-h-screen flex items-center justify-center text-fail">
        Email no autorizado.
      </div>
    );
  }

  return <>{children}</>;
}
