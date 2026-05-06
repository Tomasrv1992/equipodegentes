import { type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { signOut } from "../lib/auth";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-edge bg-paperalt">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-6">
          <Link to="/" className="font-serif text-lg font-semibold">
            Equipo de Agentes
          </Link>
          <nav className="flex gap-4 text-sm">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                isActive ? "text-accent font-semibold" : "text-dim hover:text-ink"
              }
            >
              Matriz
            </NavLink>
            <NavLink
              to="/feed"
              className={({ isActive }) =>
                isActive ? "text-accent font-semibold" : "text-dim hover:text-ink"
              }
            >
              Feed
            </NavLink>
          </nav>
          <Link
            to="/nuevo-cliente"
            className="ml-auto bg-ink text-paper px-3 py-1.5 rounded text-[10px] uppercase tracking-wider font-semibold hover:bg-accent transition-colors"
          >
            + Nuevo cliente
          </Link>
          <button
            onClick={() => signOut()}
            className="text-xs text-muted hover:text-ink"
          >
            Salir
          </button>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-6">{children}</main>
    </div>
  );
}
