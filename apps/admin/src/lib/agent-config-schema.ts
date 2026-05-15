/**
 * Schema dinámico de campos de configuración por agente.
 * Cada agente declara qué campos necesita y cómo presentarlos.
 *
 * Solo los agentes listados acá aparecen como activables en el form de nuevo cliente.
 * Esto permite tener agentes en la DB pero todavía sin form (ej: cartera mientras se diseña).
 *
 * IMPORTANTE: en Fase 3 (multi-tenant OAuth), todos los campos son OPCIONALES.
 * El cliente los llena durante el flujo `/onboarding/:token` después de conectar
 * su Google. Tomás solo crea el cliente con nombre + slug y manda el link de
 * onboarding. Los campos manuales solo se llenan si Tomás quiere hacer setup
 * legacy single-tenant (sin OAuth flow).
 */

export interface FieldSpec {
  key: string;            // clave dentro de config jsonb
  label: string;
  placeholder?: string;
  type?: "text" | "email" | "url";
  hint?: string;          // texto explicativo bajo el label
  required?: boolean;
}

export interface AgentSchema {
  agente_id: string;
  enabledForOnboarding: boolean;
  fields: FieldSpec[];
}

export const AGENT_SCHEMAS: Record<string, AgentSchema> = {
  facturacion: {
    agente_id: "facturacion",
    enabledForOnboarding: true,
    fields: [
      // Todos opcionales — el cliente los llena vía OAuth flow.
      {
        key: "sheet_id",
        label: "Sheet ID",
        placeholder: "(se llena en onboarding del cliente)",
        hint: "Solo si querés setup manual sin OAuth flow. Lo normal: dejar vacío y mandar link de onboarding.",
      },
      {
        key: "drive_folder",
        label: "Drive folder ID",
        placeholder: "(se llena en onboarding del cliente)",
        hint: "Solo si querés setup manual sin OAuth flow.",
      },
      {
        key: "notify_email",
        label: "Email del resumen",
        placeholder: "cliente@empresa.co",
        type: "email",
        hint: "A dónde llega el correo diario con el resumen. El cliente lo confirma durante onboarding.",
      },
      {
        key: "netlify_site",
        label: "Sitio Netlify del cron (legacy)",
        placeholder: "(no aplica en Fase 3)",
        hint: "Solo aplica al modo legacy single-tenant. En Fase 3 todos los clientes corren desde equipodegentes-cron.",
      },
    ],
  },
  cartera: {
    agente_id: "cartera",
    enabledForOnboarding: false,
    fields: [],
  },
};

export function enabledAgents(): AgentSchema[] {
  return Object.values(AGENT_SCHEMAS).filter((s) => s.enabledForOnboarding);
}

export function getSchema(agenteId: string): AgentSchema | undefined {
  return AGENT_SCHEMAS[agenteId];
}
