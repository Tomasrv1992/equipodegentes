/**
 * Schema dinámico de campos de configuración por agente.
 * Cada agente declara qué campos necesita y cómo presentarlos.
 *
 * Solo los agentes listados acá aparecen como activables en el form de nuevo cliente.
 * Esto permite tener agentes en la DB pero todavía sin form (ej: cartera mientras se diseña).
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
      {
        key: "sheet_id",
        label: "Sheet ID",
        placeholder: "1aB2cD…",
        hint: "ID del Google Sheet de control. Está en la URL: /spreadsheets/d/<aquí>/edit",
        required: true,
      },
      {
        key: "drive_folder",
        label: "Drive folder ID",
        placeholder: "1xY2zA…",
        hint: "ID de la carpeta Drive donde se guardan las facturas. Está en la URL: /folders/<aquí>",
        required: true,
      },
      {
        key: "notify_email",
        label: "Email del resumen",
        placeholder: "cliente@empresa.co",
        type: "email",
        hint: "A dónde llega el correo diario con el resumen de facturas procesadas.",
        required: true,
      },
      {
        key: "netlify_site",
        label: "Sitio Netlify del cron",
        placeholder: "equipodegentes-cron-cliente",
        hint: "Slug del sitio Netlify dedicado al cron de este cliente (sin .netlify.app).",
      },
    ],
  },
  cartera: {
    agente_id: "cartera",
    enabledForOnboarding: false, // todavía no listo para onboarding desde panel
    fields: [],
  },
};

/** Devuelve los agentes habilitados para activar en el form de nuevo cliente. */
export function enabledAgents(): AgentSchema[] {
  return Object.values(AGENT_SCHEMAS).filter((s) => s.enabledForOnboarding);
}

export function getSchema(agenteId: string): AgentSchema | undefined {
  return AGENT_SCHEMAS[agenteId];
}
