/**
 * SaludOAuth — alerta visual de clientes con refresh_token próximo a expirar.
 *
 * Caso real 2026-05-15: la app OAuth de Operatto está en modo Testing de
 * Google Cloud. En ese modo, los refresh_tokens emitidos a usuarios EXPIRAN
 * 7 DÍAS después de su emisión. Los clientes que onboardan no se enteran y
 * el cron empieza a fallar con invalid_grant exactamente 7 días después.
 *
 * Solución definitiva: publicar la app a Production (refresh_tokens
 * indefinidos). Mientras tanto, este componente:
 *   - Lista clientes con onboarded_at >= 5 días → alerta naranja "re-onboardear pronto"
 *   - Lista clientes con onboarded_at >= 7 días → alerta roja "ya expirado"
 *   - Solo se renderiza si HAY clientes en riesgo (cero ruido si todo OK)
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

interface RiesgoCliente {
  cliente_slug: string;
  cliente_nombre: string | null;
  onboarded_at: string;
  dias_desde_onboarding: number;
  oauth_status: string | null;
  /** 'rojo' si expired/>=7d, 'naranja' si 5-6d */
  nivel: "rojo" | "naranja";
}

const DIAS_EXPIRY_TESTING_MODE = 7;
const DIAS_ALERTA_NARANJA = 5;

function useClientesEnRiesgoOAuth() {
  return useQuery({
    queryKey: ["clientes-oauth-riesgo"],
    refetchInterval: 10 * 60_000,
    queryFn: async (): Promise<RiesgoCliente[]> => {
      const { data, error } = await supabase
        .from("client_credentials")
        .select(`
          cliente_id,
          onboarded_at,
          google_oauth_status,
          clientes(slug, nombre, activo)
        `)
        .eq("agente_id", "facturacion")
        .not("onboarded_at", "is", null);
      if (error) throw error;

      const today = new Date();
      const enRiesgo: RiesgoCliente[] = [];
      for (const row of (data ?? []) as any[]) {
        const cli = Array.isArray(row.clientes) ? row.clientes[0] : row.clientes;
        if (!cli || !cli.activo || !row.onboarded_at) continue;

        const obDate = new Date(row.onboarded_at);
        const dias = Math.floor((today.getTime() - obDate.getTime()) / (24 * 3600 * 1000));

        const isExpired = row.google_oauth_status === "expired" || dias >= DIAS_EXPIRY_TESTING_MODE;
        const isNaranja = !isExpired && dias >= DIAS_ALERTA_NARANJA;

        if (isExpired || isNaranja) {
          enRiesgo.push({
            cliente_slug: cli.slug,
            cliente_nombre: cli.nombre ?? null,
            onboarded_at: row.onboarded_at,
            dias_desde_onboarding: dias,
            oauth_status: row.google_oauth_status,
            nivel: isExpired ? "rojo" : "naranja",
          });
        }
      }
      enRiesgo.sort((a, b) => b.dias_desde_onboarding - a.dias_desde_onboarding);
      return enRiesgo;
    },
  });
}

export default function SaludOAuth() {
  const { data, isLoading } = useClientesEnRiesgoOAuth();

  if (isLoading) return null;
  if (!data || data.length === 0) return null;

  const rojos = data.filter((d) => d.nivel === "rojo");
  const naranjas = data.filter((d) => d.nivel === "naranja");

  return (
    <section className="mb-9">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="section-title">
            ⚠ Salud OAuth · {data.length} cliente{data.length !== 1 ? "s" : ""} en riesgo
          </h2>
          <p className="font-mono text-[10px] text-ink-3 tracking-[0.04em] uppercase mt-0.5">
            App OAuth en modo Testing → refresh_tokens expiran 7 días después del onboarding
          </p>
        </div>
        <a
          href="https://console.cloud.google.com/apis/credentials/consent"
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] text-accent hover:underline tracking-[0.04em]"
        >
          publicar app a Production →
        </a>
      </div>

      <div className="card overflow-hidden p-0">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-edge bg-paper-sunken">
              <th className="text-left py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                Cliente
              </th>
              <th className="text-left py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                Onboarded
              </th>
              <th className="text-right py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                Días
              </th>
              <th className="text-left py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                Estado
              </th>
              <th className="text-left py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                Acción
              </th>
            </tr>
          </thead>
          <tbody>
            {rojos.map((c) => (
              <ClienteRow key={c.cliente_slug} cliente={c} />
            ))}
            {naranjas.map((c) => (
              <ClienteRow key={c.cliente_slug} cliente={c} />
            ))}
          </tbody>
        </table>
      </div>

      <details className="mt-3 font-mono text-[10px] text-ink-3 tracking-[0.04em]">
        <summary className="cursor-pointer hover:text-ink-2">
          ¿Qué es esto?
        </summary>
        <div className="mt-2 leading-relaxed">
          <p>
            Cuando una app OAuth de Google está en modo <strong>Testing</strong> (no publicada),
            los refresh_tokens emitidos a usuarios EXPIRAN 7 DÍAS después de su
            emisión. Los clientes onboardados hace 7+ días empiezan a fallar
            con "invalid_grant" automáticamente.
          </p>
          <p className="mt-2">
            <strong>Solución definitiva:</strong> publicar la app a Production en
            Google Cloud Console. Esto requiere privacy policy URL, terms of
            service, y eventualmente verificación de Google (puede tomar 1-6
            semanas). Pero el cambio de Testing → "Pending verification" toma
            efecto inmediato y los refresh_tokens nuevos ya no expiran a los 7 días.
          </p>
          <p className="mt-2">
            <strong>Mientras tanto:</strong> re-onboardar a los clientes que
            llegan a 5+ días desde su último OAuth. Los refresh_tokens nuevos
            empiezan el ciclo de 7 días de nuevo.
          </p>
        </div>
      </details>
    </section>
  );
}

function ClienteRow({ cliente }: { cliente: RiesgoCliente }) {
  const rowClass =
    cliente.nivel === "rojo"
      ? "border-b border-edge-2 bg-fail-soft/30"
      : "border-b border-edge-2 bg-warn-soft/30";

  return (
    <tr className={rowClass}>
      <td className="py-2 px-3">
        <Link
          to={`/cliente/${cliente.cliente_slug}`}
          className="text-ink hover:text-accent font-medium"
        >
          {cliente.cliente_nombre ?? cliente.cliente_slug}
        </Link>
      </td>
      <td className="py-2 px-3 font-mono text-[11px] text-ink-3">
        {cliente.onboarded_at.slice(0, 10)}
      </td>
      <td className="py-2 px-3 text-right font-mono tabular-nums">
        {cliente.dias_desde_onboarding}
      </td>
      <td className="py-2 px-3">
        {cliente.nivel === "rojo" ? (
          <span className="font-mono text-[10px] tracking-[0.04em] bg-fail-soft text-fail px-2 py-0.5 rounded">
            🔴 {cliente.oauth_status === "expired" ? "EXPIRADO" : `${cliente.dias_desde_onboarding}d ≥ 7`}
          </span>
        ) : (
          <span className="font-mono text-[10px] tracking-[0.04em] bg-warn-soft text-warn px-2 py-0.5 rounded">
            🟡 expira en {7 - cliente.dias_desde_onboarding}d
          </span>
        )}
      </td>
      <td className="py-2 px-3">
        <Link
          to={`/cliente/${cliente.cliente_slug}`}
          className="font-mono text-[10px] text-accent hover:underline tracking-[0.04em]"
        >
          re-onboardear →
        </Link>
      </td>
    </tr>
  );
}
