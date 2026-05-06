export interface ErrorClassification {
  causaProbable: string;
  fixSugerido: string | null;
}

const RULES: Array<{ match: RegExp; classification: ErrorClassification }> = [
  {
    match: /invalid_grant/i,
    classification: {
      causaProbable:
        "El refresh token de Google fue revocado o expiró (Google los expira a 6 meses si la app está en modo Testing).",
      fixSugerido:
        "Regenerar el refresh token: correr `npm run facturacion:setup-oauth` local, copiar el nuevo refresh token a las env vars de Netlify (sin el `=` al inicio), y re-disparar.",
    },
  },
  {
    match: /rate.?limit|429/i,
    classification: {
      causaProbable: "Rate limit de la API externa.",
      fixSugerido: "Esperar 5-15 min y re-disparar. Si recurrente, reducir frecuencia o batch size.",
    },
  },
  {
    match: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i,
    classification: {
      causaProbable: "Problema de red llegando a la API externa.",
      fixSugerido: "Re-disparar. Si persiste, revisar status de la API afectada.",
    },
  },
];

export function classifyError(message: string | null): ErrorClassification | null {
  if (!message) return null;
  for (const r of RULES) {
    if (r.match.test(message)) return r.classification;
  }
  return {
    causaProbable: "No clasificado automáticamente.",
    fixSugerido: "Revisar el stack y los logs de Netlify para más contexto.",
  };
}
