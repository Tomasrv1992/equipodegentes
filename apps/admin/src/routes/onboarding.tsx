import { useState, useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";

interface OnboardingInfo {
  cliente_id: string;
  cliente_nombre: string;
  cliente_slug: string;
  agente_id: string;
  agente_nombre: string;
  step:
    | "pending"
    | "oauth_done"
    | "fiscal_pending"
    | "resources_done"
    | "completed"
    | "expired";
  expires_at: string;
}

interface DriveFolder {
  id: string;
  name: string;
  parents?: string[];
}

interface SheetItem {
  id: string;
  name: string;
  modifiedTime?: string;
}

/**
 * Página pública de onboarding del cliente.
 * URL: /onboarding/:token
 *
 * Flujo:
 *   step 'pending'        → Pantalla "Conectar mi Google" (botón inicia OAuth)
 *   step 'oauth_done'     → Selección Drive folder + Sheet
 *   step 'resources_done' → Listo (auto-marcado a 'completed' tras save)
 *   step 'completed'      → Pantalla "Ya está todo listo"
 */
export default function OnboardingPage() {
  const { token } = useParams<{ token: string }>();
  const [params] = useSearchParams();
  const [info, setInfo] = useState<OnboardingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const { data, error } = await supabase.rpc("onboarding_token_lookup", {
          p_token: token,
        });
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as OnboardingInfo[];
        if (rows.length === 0) {
          setErrorMsg("Link inválido o vencido. Pídele a Operatto uno nuevo.");
        } else {
          setInfo(rows[0]);
        }
      } catch (e: any) {
        setErrorMsg(e.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  // Mensaje de query string (errores del callback OAuth)
  const oauthError = params.get("error");
  const oauthOk = params.get("oauth") === "ok";

  if (!token) return <CenteredMessage>Token faltante.</CenteredMessage>;
  if (loading) return <CenteredMessage>Cargando…</CenteredMessage>;
  if (errorMsg && !info) return <ErrorScreen message={errorMsg} />;
  if (!info) return null;

  return (
    <div className="min-h-screen bg-paper">
      {/* Background ambient */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 70% 50% at 50% 20%, oklch(0.55 0.18 28 / 0.06) 0%, transparent 70%)",
        }}
      />

      <div className="relative max-w-[640px] mx-auto px-6 py-12">
        {/* Brand */}
        <div className="flex items-center gap-2 mb-12">
          <span className="w-2 h-2 rounded-full bg-accent" />
          <span className="font-display text-base font-semibold tracking-tighter text-ink">
            Operatto
          </span>
        </div>

        {/* Header */}
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-3">
          Onboarding · {info.agente_nombre}
        </div>
        <h1
          className="font-display font-medium leading-[0.95] tracking-tightest text-ink m-0 mb-3"
          style={{ fontSize: "clamp(36px, 5vw, 56px)" }}
        >
          Hola{" "}
          <em className="italic font-normal text-ink-2">{info.cliente_nombre}</em>
        </h1>
        <p className="font-sans text-base text-ink-3 leading-relaxed mb-12">
          Vamos a conectar tu cuenta de Google para que el agente de Operatto
          empiece a procesar tus facturas. Toma menos de 2 minutos.
        </p>

        {/* Steps progress */}
        <StepsBar step={info.step} />

        {/* OAuth error notice */}
        {oauthError && (
          <div className="mt-8 border border-fail bg-fail-soft text-fail rounded-lg p-4 font-mono text-[11px] tracking-[0.04em]">
            <strong>Error de Google:</strong> {oauthError}
            {oauthError === "no_refresh_token" && (
              <p className="mt-2 text-ink leading-relaxed">
                Esto pasa cuando ya autorizaste antes. Andá a{" "}
                <a
                  href="https://myaccount.google.com/permissions"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline"
                >
                  myaccount.google.com/permissions
                </a>
                , revocá Operatto, y volvé a clickear "Conectar Google".
              </p>
            )}
          </div>
        )}

        {/* Step 1: Conectar Google */}
        {(info.step === "pending" || (info.step === "oauth_done" && !oauthOk)) && (
          <StepConnectGoogle token={token} forceNew={info.step === "oauth_done"} />
        )}

        {/* Step 2: Seleccionar Drive + Sheet (fallback si auto-create falló) */}
        {info.step === "oauth_done" && oauthOk && (
          <StepResources token={token} cliente={info} />
        )}

        {/* Step 3: Datos fiscales (NIT + retenciones) */}
        {info.step === "fiscal_pending" && (
          <StepFiscalData token={token} cliente={info} />
        )}

        {/* Step 4: Listo */}
        {info.step === "completed" && <StepDone cliente={info} />}
      </div>
    </div>
  );
}

// ===== Step 1: Connect Google =====
function StepConnectGoogle({
  token,
  forceNew,
}: {
  token: string;
  forceNew?: boolean;
}) {
  const startUrl = `/api/auth/google/start?token=${encodeURIComponent(token)}`;
  return (
    <section className="card mt-10">
      <div className="label mb-3">Paso 1 de 2</div>
      <h2 className="font-display text-2xl font-semibold tracking-tighter mb-2">
        Conectá tu Google
      </h2>
      <p className="font-sans text-sm text-ink-3 leading-relaxed mb-5">
        Operatto va a leer las facturas que llegan a tu Gmail (con etiqueta
        DIAN), guardarlas en una carpeta de tu Drive y registrarlas en un
        Google Sheet de control. Vos elegís dónde, en el siguiente paso.
      </p>

      <a href={startUrl} className="btn-accent inline-flex items-center gap-2">
        {forceNew ? "Reconectar Google" : "Conectar mi cuenta Google"}
      </a>

      <p className="font-mono text-[10px] text-ink-3 tracking-[0.04em] mt-5 leading-relaxed">
        Permisos requeridos: leer Gmail, escribir Drive, escribir Sheets.
        <br />
        Podés revocar el acceso cuando quieras desde{" "}
        <a
          href="https://myaccount.google.com/permissions"
          target="_blank"
          rel="noreferrer"
          className="text-accent underline"
        >
          myaccount.google.com/permissions
        </a>
        .
      </p>
    </section>
  );
}

// ===== Step 2: Drive folder + Sheet =====
function StepResources({
  token,
  cliente,
}: {
  token: string;
  cliente: OnboardingInfo;
}) {
  const [folders, setFolders] = useState<DriveFolder[] | null>(null);
  const [sheets, setSheets] = useState<SheetItem[] | null>(null);
  const [folderId, setFolderId] = useState("");
  const [folderName, setFolderName] = useState("");
  const [sheetId, setSheetId] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [fResp, sResp] = await Promise.all([
          fetch("/api/onboarding/drive-list", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
          }),
          fetch("/api/onboarding/sheets-list", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
          }),
        ]);
        if (!fResp.ok) throw new Error(`drive: ${await fResp.text()}`);
        if (!sResp.ok) throw new Error(`sheets: ${await sResp.text()}`);
        const fJson = (await fResp.json()) as { folders: DriveFolder[] };
        const sJson = (await sResp.json()) as { sheets: SheetItem[] };
        setFolders(fJson.folders);
        setSheets(sJson.sheets);
      } catch (e: any) {
        setErrMsg(e.message ?? String(e));
      }
    })();
  }, [token]);

  async function handleSave() {
    if (!folderId || !sheetId) {
      setErrMsg("Tenés que elegir una carpeta y un Sheet.");
      return;
    }
    setSaving(true);
    setErrMsg("");
    try {
      const resp = await fetch("/api/onboarding/save-resources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          driveFolderId: folderId,
          driveFolderName: folderName,
          sheetId,
          sheetName,
          notifyEmail: notifyEmail || undefined,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setDone(true);
    } catch (e: any) {
      setErrMsg(e.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  if (done) return <StepDone cliente={cliente} />;

  return (
    <section className="card mt-10 space-y-6">
      <div>
        <div className="label mb-3">Paso 2 de 2</div>
        <h2 className="font-display text-2xl font-semibold tracking-tighter mb-2">
          Elegí dónde guardar las facturas
        </h2>
        <p className="font-sans text-sm text-ink-3 leading-relaxed">
          Si todavía no tenés una carpeta o un Sheet creado, andá a Drive,
          creá lo que necesitás, volvé acá y refrescá.
        </p>
      </div>

      <div>
        <label className="label mb-2">Carpeta de Drive</label>
        {!folders ? (
          <p className="text-ink-3 text-sm">Cargando carpetas…</p>
        ) : folders.length === 0 ? (
          <p className="text-ink-3 text-sm">
            No tenés carpetas en la raíz de Drive. Creá una y refrescá.
          </p>
        ) : (
          <div className="space-y-1.5 max-h-60 overflow-auto border border-edge rounded-md p-2 bg-paper">
            {folders.map((f) => (
              <label
                key={f.id}
                className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                  folderId === f.id
                    ? "bg-accent-soft border border-accent"
                    : "hover:bg-paper-sunken"
                }`}
              >
                <input
                  type="radio"
                  name="folder"
                  checked={folderId === f.id}
                  onChange={() => {
                    setFolderId(f.id);
                    setFolderName(f.name);
                  }}
                  className="accent-accent"
                />
                <span className="text-sm font-medium">📁 {f.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div>
        <label className="label mb-2">Google Sheet de control</label>
        {!sheets ? (
          <p className="text-ink-3 text-sm">Cargando sheets…</p>
        ) : sheets.length === 0 ? (
          <p className="text-ink-3 text-sm">
            No tenés Sheets. Creá uno y refrescá.
          </p>
        ) : (
          <div className="space-y-1.5 max-h-60 overflow-auto border border-edge rounded-md p-2 bg-paper">
            {sheets.map((s) => (
              <label
                key={s.id}
                className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                  sheetId === s.id
                    ? "bg-accent-soft border border-accent"
                    : "hover:bg-paper-sunken"
                }`}
              >
                <input
                  type="radio"
                  name="sheet"
                  checked={sheetId === s.id}
                  onChange={() => {
                    setSheetId(s.id);
                    setSheetName(s.name);
                  }}
                  className="accent-accent"
                />
                <span className="text-sm font-medium">📊 {s.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div>
        <label className="label mb-2">Email para el resumen diario (opcional)</label>
        <input
          type="email"
          value={notifyEmail}
          onChange={(e) => setNotifyEmail(e.target.value)}
          className="input"
          placeholder="tu@email.com"
        />
        <p className="font-mono text-[10px] text-ink-3 tracking-[0.04em] mt-1.5 leading-relaxed">
          Si lo dejás vacío, no se manda email diario.
        </p>
      </div>

      {errMsg && (
        <p className="font-mono text-[11px] text-fail tracking-[0.04em]">
          {errMsg}
        </p>
      )}

      <button
        onClick={handleSave}
        disabled={saving || !folderId || !sheetId}
        className="btn-accent"
      >
        {saving ? "Guardando…" : "Listo, terminar onboarding"}
      </button>
    </section>
  );
}

// ===== Step 3: Datos fiscales =====
const MUNICIPIOS_ICA = [
  { value: "", label: "— No aplica / no estoy seguro —" },
  { value: "BOGOTA", label: "Bogotá" },
  { value: "MEDELLIN", label: "Medellín" },
  { value: "CALI", label: "Cali" },
  { value: "BARRANQUILLA", label: "Barranquilla" },
  { value: "BUCARAMANGA", label: "Bucaramanga" },
  { value: "CARTAGENA", label: "Cartagena" },
  { value: "PEREIRA", label: "Pereira" },
  { value: "MANIZALES", label: "Manizales" },
  { value: "OTRO", label: "Otro municipio…" },
];

function StepFiscalData({
  token,
  cliente,
}: {
  token: string;
  cliente: OnboardingInfo;
}) {
  type TipoPersona = "juridica" | "natural_declarante" | "natural_no_declarante";

  const [tipoPersona, setTipoPersona] = useState<TipoPersona>("juridica");
  const [nitCliente, setNitCliente] = useState("");
  const [reteFuente, setReteFuente] = useState(true);
  const [reteIva, setReteIva] = useState(false);
  const [reteIca, setReteIca] = useState(false);
  const [municipioIca, setMunicipioIca] = useState("");
  const [municipioCustom, setMunicipioCustom] = useState("");
  const [oficioRtf, setOficioRtf] = useState(true);
  const [oficioIca, setOficioIca] = useState(false);
  const [notas, setNotas] = useState("");
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [done, setDone] = useState(false);

  // Auto-ajustar defaults cuando cambia tipo de persona
  function handleTipoPersonaChange(newTipo: TipoPersona) {
    setTipoPersona(newTipo);
    if (newTipo === "natural_no_declarante") {
      // Persona natural NO declarante: típicamente sin retenciones
      setReteFuente(false);
      setReteIva(false);
      setReteIca(false);
      setOficioRtf(false);
      setOficioIca(false);
    } else if (newTipo === "natural_declarante") {
      // Persona natural declarante: típicamente RTF activo
      setReteFuente(true);
      setReteIva(false);
      setReteIca(false);
      setOficioRtf(true);
      setOficioIca(false);
    } else {
      // Persona jurídica: típicamente RTF + ICA si tiene municipio
      setReteFuente(true);
      setReteIva(false);
      setReteIca(false);
      setOficioRtf(true);
      setOficioIca(false);
    }
  }

  const nitLabel =
    tipoPersona === "juridica"
      ? "NIT de tu empresa (sin dígito de verificación)"
      : "Tu cédula de ciudadanía";
  const nitPlaceholder =
    tipoPersona === "juridica" ? "Ej: 900507816" : "Ej: 1037621575";

  // Validación
  const nitLimpio = nitCliente.replace(/\D+/g, "");
  const nitValido = nitLimpio.length >= 6 && nitLimpio.length <= 11;

  async function handleSave() {
    if (!nitValido) {
      setErrMsg("Necesitamos un NIT/cédula válido (6-11 dígitos).");
      return;
    }
    setSaving(true);
    setErrMsg("");
    try {
      const municipioFinal =
        municipioIca === "OTRO"
          ? municipioCustom.toUpperCase().trim() || null
          : municipioIca || null;

      const resp = await fetch("/api/onboarding/save-fiscal-data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          tipo_persona: tipoPersona,
          nit_cliente: nitLimpio,
          agente_retenedor: {
            reteFuente,
            reteIva,
            reteIca,
          },
          municipio_ica: municipioFinal,
          aplicar_de_oficio: {
            rtf_si_xml_vacio: oficioRtf,
            ica_si_xml_vacio: oficioIca,
          },
          notas,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setDone(true);
    } catch (e: any) {
      setErrMsg(e.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  if (done) return <StepDone cliente={cliente} />;

  return (
    <section className="card mt-10 space-y-6">
      <div>
        <div className="label mb-3">Último paso</div>
        <h2 className="font-display text-2xl font-semibold tracking-tighter mb-2">
          Datos fiscales
        </h2>
        <p className="font-sans text-sm text-ink-3 leading-relaxed">
          Necesitamos saber un par de cosas para procesar tus facturas
          correctamente. Si no estás seguro de alguna respuesta, podés dejarla
          en su valor por defecto y editarlo después.
        </p>
      </div>

      {/* Tipo de persona */}
      <div>
        <label className="label mb-2 block">Tipo de cliente</label>
        <select
          value={tipoPersona}
          onChange={(e) => handleTipoPersonaChange(e.target.value as TipoPersona)}
          className="input"
        >
          <option value="juridica">Persona jurídica (empresa con NIT)</option>
          <option value="natural_declarante">
            Persona natural — declarante de renta
          </option>
          <option value="natural_no_declarante">
            Persona natural — NO declarante de renta
          </option>
        </select>
      </div>

      {/* NIT / Cédula */}
      <div>
        <label className="label mb-2 block">{nitLabel}</label>
        <input
          type="text"
          inputMode="numeric"
          value={nitCliente}
          onChange={(e) => setNitCliente(e.target.value.replace(/\D+/g, ""))}
          maxLength={11}
          placeholder={nitPlaceholder}
          className="input"
        />
        <p className="font-mono text-[10px] text-ink-3 mt-1.5 leading-relaxed">
          Lo usamos para descartar facturas donde vos figuras como emisor (tus
          propias cuentas de cobro), así no se cuelan como gastos.
        </p>
      </div>

      {/* Agente retenedor */}
      <div>
        <label className="label mb-2 block">¿Sos agente retenedor de…?</label>
        <div className="flex flex-col gap-2 font-mono text-[11px]">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={reteFuente}
              onChange={(e) => setReteFuente(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Retención en la Fuente (RTF)
              <br />
              <span className="text-ink-3 normal-case">
                La mayoría de empresas formales lo son.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={reteIva}
              onChange={(e) => setReteIva(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Retención de IVA
              <br />
              <span className="text-ink-3 normal-case">
                Solo si sos gran contribuyente.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={reteIca}
              onChange={(e) => setReteIca(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Retención de ICA
              <br />
              <span className="text-ink-3 normal-case">
                Solo en algunos municipios y según actividad económica.
              </span>
            </span>
          </label>
        </div>
      </div>

      {/* Municipio ICA */}
      <div>
        <label className="label mb-2 block">Municipio donde pagás ICA</label>
        <select
          value={municipioIca}
          onChange={(e) => setMunicipioIca(e.target.value)}
          className="input"
        >
          {MUNICIPIOS_ICA.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {municipioIca === "OTRO" && (
          <input
            type="text"
            value={municipioCustom}
            onChange={(e) => setMunicipioCustom(e.target.value)}
            placeholder="Ej: ENVIGADO, ITAGUI, RIONEGRO..."
            className="input input-mono mt-2"
          />
        )}
      </div>

      {/* Aplicar de oficio */}
      <div>
        <label className="label mb-2 block">
          Aplicar retención de oficio si el proveedor no la incluyó
        </label>
        <div className="flex flex-col gap-2 font-mono text-[11px]">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={oficioRtf}
              onChange={(e) => {
                setOficioRtf(e.target.checked);
                if (e.target.checked) setReteFuente(true);
              }}
            />
            <span>RTF (según categoría del servicio/producto)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={oficioIca}
              onChange={(e) => {
                setOficioIca(e.target.checked);
                if (e.target.checked) setReteIca(true);
              }}
            />
            <span>ICA (según tarifa del municipio)</span>
            {oficioIca && !municipioIca && (
              <span className="text-fail text-[10px] ml-2">
                ⚠ falta elegir municipio
              </span>
            )}
          </label>
        </div>
      </div>

      {/* Notas */}
      <div>
        <label className="label mb-2 block">Notas (opcional)</label>
        <textarea
          value={notas}
          onChange={(e) => setNotas(e.target.value)}
          className="input"
          rows={2}
          placeholder="Ej: régimen especial, observaciones del contador..."
        />
      </div>

      {errMsg && (
        <p className="font-mono text-[11px] text-fail tracking-[0.04em]">
          {errMsg}
        </p>
      )}

      <button
        onClick={handleSave}
        disabled={saving || !nitValido}
        className="btn-accent"
      >
        {saving ? "Guardando…" : "Listo, arrancar a procesar"}
      </button>

      {!nitValido && nitCliente.length > 0 && (
        <p className="font-mono text-[10px] text-fail tracking-[0.04em]">
          NIT/cédula debe tener entre 6 y 11 dígitos.
        </p>
      )}
    </section>
  );
}

// ===== Step 4: Done =====
interface EstimateResponse {
  total: number;
  estimatedMinutes: number;
  monthsToProcess: number;
  porMes: Array<{ mes: number; mesName: string; count: number }>;
}

function StepDone({ cliente }: { cliente: OnboardingInfo }) {
  const { token } = useParams<{ token: string }>();
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);
  const [estimating, setEstimating] = useState(true);

  useEffect(() => {
    if (!token) {
      setEstimating(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/onboarding/estimate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!resp.ok) {
          if (!cancelled) setEstimating(false);
          return;
        }
        const data = (await resp.json()) as EstimateResponse;
        if (!cancelled) {
          setEstimate(data);
          setEstimating(false);
        }
      } catch {
        if (!cancelled) setEstimating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Mes con más facturas — útil para setear expectativa del cuello de botella
  const peakMonth =
    estimate && estimate.porMes.length > 0
      ? estimate.porMes.reduce((a, b) => (b.count > a.count ? b : a))
      : null;

  return (
    <section className="card mt-10 text-center">
      <div className="relative w-12 h-12 mx-auto mb-4">
        <div className="absolute inset-0 rounded-full bg-accent/20 animate-ping" />
        <div className="relative w-12 h-12 rounded-full bg-ok-soft text-ok flex items-center justify-center font-display text-2xl">
          ✓
        </div>
      </div>
      <h2 className="font-display text-3xl font-semibold tracking-tighter mb-2">
        ¡Listo! Ya estamos procesando.
      </h2>

      {/* Estimación previa: setear expectativas reales del cliente */}
      {estimating && (
        <p className="font-mono text-[11px] text-ink-3 tracking-[0.04em] mb-3">
          Contando facturas en tu Gmail…
        </p>
      )}
      {estimate && estimate.total > 0 && (
        <div className="bg-accent-soft border border-accent/30 rounded-lg p-4 my-4 max-w-md mx-auto text-left">
          <div className="font-mono text-[10px] text-accent tracking-[0.06em] uppercase mb-1">
            Encontramos en tu Gmail
          </div>
          <div className="font-display text-2xl font-semibold tracking-tighter text-ink mb-1">
            ~{estimate.total} facturas{" "}
            <span className="font-sans text-sm text-ink-3 font-normal">
              · {estimate.monthsToProcess} mes
              {estimate.monthsToProcess === 1 ? "" : "es"}
            </span>
          </div>
          <p className="font-sans text-sm text-ink-2 leading-relaxed">
            Procesamiento estimado: <strong>~{estimate.estimatedMinutes} min</strong>
            {peakMonth && peakMonth.count > 0 && (
              <>
                {" "}
                · Mes más cargado: {peakMonth.mesName} ({peakMonth.count})
              </>
            )}
          </p>
        </div>
      )}
      {estimate && estimate.total === 0 && (
        <p className="font-sans text-sm text-ink-3 leading-relaxed mb-3 max-w-md mx-auto">
          No encontramos facturas DIAN nuevas en tu Gmail aún — apenas lleguen,
          las procesamos automáticamente.
        </p>
      )}
      {!estimating && !estimate && (
        <p className="font-sans text-base text-ink-3 leading-relaxed mb-3 max-w-md mx-auto">
          El agente de <strong>{cliente.agente_nombre}</strong> arrancó ahora
          mismo. Va a procesar todas tus facturas DIAN del año en curso (puede
          tardar 5–15 minutos según volumen).
        </p>
      )}

      <div className="font-mono text-[10px] text-ink-3 tracking-[0.06em] uppercase mt-4 mb-2">
        Lo que está pasando ahora
      </div>
      <ul className="font-sans text-sm text-ink-2 max-w-md mx-auto text-left space-y-1.5 mb-6">
        <li>· Buscando facturas en tu Gmail desde 1° de enero</li>
        <li>· Creando carpetas mensuales en tu Drive</li>
        <li>· Llenando tu Sheet con cada factura categorizada</li>
        <li>· Armando un Dashboard con métricas vivas</li>
      </ul>
      <p className="font-mono text-[11px] text-ink-3 tracking-[0.04em]">
        Vas a recibir un email cuando termine cada mes. Después corre solo,
        todos los días a las 7am Bogotá.
      </p>
    </section>
  );
}

// ===== Helpers UI =====
function StepsBar({ step }: { step: OnboardingInfo["step"] }) {
  const steps = [
    { id: "pending", label: "Conectar Google" },
    { id: "oauth_done", label: "Elegir destino" },
    { id: "completed", label: "Listo" },
  ];
  const currentIdx = steps.findIndex((s) => s.id === step);
  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => {
        const active = i <= currentIdx;
        return (
          <div key={s.id} className="flex items-center gap-2 flex-1">
            <div
              className={`flex items-center gap-2 ${active ? "" : "opacity-40"}`}
            >
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center font-mono text-[10px] font-bold ${
                  active ? "bg-accent text-paper" : "bg-paper-sunken text-ink-3"
                }`}
              >
                {i + 1}
              </span>
              <span className="font-mono text-[11px] tracking-[0.04em] text-ink-2">
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`flex-1 h-px ${active && i < currentIdx ? "bg-accent" : "bg-edge"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-paper">
      <p className="font-mono text-[11px] text-ink-3 tracking-[0.05em] uppercase">
        {children}
      </p>
    </div>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-paper px-6">
      <div className="max-w-md text-center">
        <div className="w-12 h-12 rounded-full bg-fail-soft text-fail flex items-center justify-center mx-auto mb-4 font-display text-2xl">
          ⚠
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tighter mb-2">
          Algo no anda bien
        </h1>
        <p className="font-sans text-sm text-ink-3 leading-relaxed">{message}</p>
      </div>
    </div>
  );
}
