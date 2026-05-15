import { useState } from "react";
import { sendMagicLink } from "../lib/auth";
import { ALLOWED_EMAIL } from "../lib/supabase";

export default function Login() {
  const [email, setEmail] = useState(ALLOWED_EMAIL);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    try {
      await sendMagicLink(email);
      setStatus("sent");
    } catch (err: any) {
      setErrMsg(err.message ?? String(err));
      setStatus("error");
    }
  }

  return (
    <div className="min-h-screen relative bg-paper">
      {/* Background ambient ellipse */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 60% 40% at 50% 30%, oklch(0.55 0.18 28 / 0.05) 0%, transparent 70%)",
        }}
      />

      <div className="relative min-h-screen flex items-center justify-center px-6">
        <form onSubmit={handle} className="w-full max-w-md">
          {/* Brand */}
          <div className="mb-10 flex items-center gap-2 justify-center">
            <span className="w-2 h-2 rounded-full bg-accent" />
            <span className="font-display text-base font-semibold tracking-tighter text-ink">
              Operatto
            </span>
          </div>

          <div className="text-center mb-9">
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-3">
              Panel de operación
            </div>
            <h1 className="font-display font-medium leading-[1] tracking-tightest text-ink text-4xl mb-3">
              Bienvenido
            </h1>
            <p className="font-sans text-sm text-ink-3">
              Acceso por magic link.<br/>Te mandamos un correo con el link de entrada.
            </p>
          </div>

          <div className="card">
            <label className="label mb-1.5 block">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input mb-4"
              required
            />

            <button
              type="submit"
              disabled={status === "sending" || status === "sent"}
              className="btn-primary w-full justify-center"
              style={{ display: "flex", justifyContent: "center" }}
            >
              {status === "sending" ? "Enviando…" : status === "sent" ? "Enviado ✓" : "Enviar link"}
            </button>

            {status === "sent" && (
              <p className="mt-4 text-xs text-ok font-mono tracking-[0.04em]">
                Revisa tu email. El link te trae de vuelta logueado.
              </p>
            )}
            {status === "error" && (
              <p className="mt-4 text-xs text-fail font-mono tracking-[0.04em]">
                Error: {errMsg}
              </p>
            )}
          </div>

          <p className="text-center font-mono text-[10px] text-ink-4 tracking-[0.06em] mt-8">
            Operations console · agentes para PYMEs
          </p>
        </form>
      </div>
    </div>
  );
}
