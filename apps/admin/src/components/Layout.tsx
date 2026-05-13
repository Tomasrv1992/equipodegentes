import { type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { signOut } from "../lib/auth";
import { ALLOWED_EMAIL } from "../lib/supabase";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="relative z-10 border-b border-edge bg-paper-2">
        <div className="max-w-[1240px] mx-auto px-8 py-3.5 flex items-center gap-8">
          <Link
            to="/"
            className="flex items-center gap-2 font-display text-base font-semibold tracking-tighter text-ink hover:text-accent transition-colors"
          >
            <span className="w-2 h-2 rounded-full bg-accent" />
            Operatto
          </Link>

          <nav className="flex gap-1">
            <NavLink to="/" end className={navClass}>
              Operación
            </NavLink>
            <NavLink to="/clientes" className={navClass}>
              Clientes
            </NavLink>
            <NavLink to="/agentes" className={navClass}>
              Agentes
            </NavLink>
            <NavLink to="/diagnostico" className={navClass}>
              Diagnóstico
            </NavLink>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <Link to="/nuevo-cliente" className="btn-primary">
              + Nuevo cliente
            </Link>
            <button
              onClick={() => signOut()}
              className="font-mono text-[11px] text-ink-3 hover:text-ink transition-colors"
              title={ALLOWED_EMAIL}
            >
              {shortEmail(ALLOWED_EMAIL)}
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-[1240px] mx-auto px-8 py-12">
        {children}
      </main>
    </div>
  );
}

function navClass({ isActive }: { isActive: boolean }) {
  const base =
    "font-sans text-[13px] font-medium px-2.5 py-1.5 rounded-md transition-all duration-150 ease-out-expo";
  if (isActive) {
    return `${base} text-ink bg-paper-sunken`;
  }
  return `${base} text-ink-3 hover:text-ink hover:bg-paper-sunken`;
}

function shortEmail(email: string): string {
  const [user] = email.split("@");
  return `${user}@`;
}
