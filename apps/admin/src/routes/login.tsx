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
    <div className="min-h-screen flex items-center justify-center bg-paper">
      <form onSubmit={handle} className="card max-w-md w-full">
        <h1 className="font-serif text-2xl mb-1">Panel · Equipo de Agentes</h1>
        <p className="text-sm text-muted mb-6">Acceso por magic link.</p>

        <label className="label block mb-1">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border border-edge rounded px-3 py-2 mb-4 bg-white"
          required
        />

        <button
          type="submit"
          disabled={status === "sending" || status === "sent"}
          className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold uppercase tracking-wider disabled:opacity-50"
        >
          {status === "sending" ? "Enviando..." : status === "sent" ? "Enviado ✓" : "Enviar link"}
        </button>

        {status === "sent" && (
          <p className="mt-4 text-sm text-ok">
            Revisa tu email. El link te trae de vuelta logueado.
          </p>
        )}
        {status === "error" && (
          <p className="mt-4 text-sm text-fail">Error: {errMsg}</p>
        )}
      </form>
    </div>
  );
}
