# Pendientes para vos (acciones manuales)

Esta es la lista de cosas que **vos tenés que hacer mañana**. El agente
no puede hacerlas porque requieren credenciales reales, plata, o crear
cuentas en servicios externos. Hacelas en orden.

> **TL;DR:** sin estos pasos el agente funciona en modo demo (datos
> hardcodeados, sin llamar a la API real). Con estos pasos hechos, el
> agente lee tu cartera real y la API de Claude responde de verdad.

---

## ☐ 1. Pegar tu API key de Anthropic en `.env`

**Por qué:** sin esta key, el agente no puede llamar a Claude. El
comando arroja un error claro pidiéndote configurarla.

**Cómo:**

1. Andá a https://console.anthropic.com/settings/keys.
2. Iniciá sesión (o creá cuenta — necesitás cargarle saldo, ~$5 USD
   alcanza para varias semanas de uso del MVP con Haiku 4.5).
3. Botón **Create Key**. Nombre: `equipo-cartera-mvp`.
4. **Copiá la key entera** (empieza con `sk-ant-...`). La key NO se
   vuelve a mostrar — si la perdés, hay que generar otra.
5. Abrí `agentes/equipo-cartera/.env` con cualquier editor de texto.
6. Pegá la key después del `=`:
   ```env
   ANTHROPIC_API_KEY=sk-ant-api03-tu_key_completa_acá
   ```
7. Guardá el archivo.

**Verificar que funcionó:**
```cmd
cd agentes\equipo-cartera
venv\Scripts\activate.bat
python -m src.agent --prestamo PR-DEMO-001 --verbose
```
Si ves el bloque `========== RESULTADO DEL AGENTE ==========` con una
decisión real (no error), está OK. Esto cuesta ~$0.001 USD.

---

## ☐ 2. Crear el Google Sheet "Equipo Cartera DEMO"

**Por qué:** el agente necesita una hoja de cálculo donde leer la
cartera real y donde anotar las decisiones que toma. Mientras no la
crees, opera con 5 préstamos demo en memoria.

**Cómo:** seguí el instructivo paso a paso en
[`scripts/setup_sheet_demo.md`](scripts/setup_sheet_demo.md).

> Está escrito específicamente para que lo siga alguien sin experiencia
> técnica. Te toma 20-30 minutos la primera vez.

**Verificar:** abrí el Sheet en el navegador. Debe tener dos pestañas
visibles abajo: `prestamos` (con los datos demo cargados) y `eventos`
(vacía debajo de los encabezados).

---

## ☐ 3. Crear el Service Account de Google Cloud

**Por qué:** es la "cuenta de máquina" que usa el agente para
autenticarse contra Google Sheets sin necesitar tu password personal.

**Cómo:** está incluido como Paso 3 dentro de
[`scripts/setup_sheet_demo.md`](scripts/setup_sheet_demo.md). Te lleva
por:
- Crear proyecto en Google Cloud Console.
- Habilitar Google Sheets API y Google Drive API.
- Crear el Service Account.
- Descargar la llave JSON.

**Resultado esperado:** un archivo
`agentes/equipo-cartera/credentials/service-account.json` en tu disco
(no se sube a git).

---

## ☐ 4. Compartir el Sheet con el Service Account

**Por qué:** Google Cloud crea el Service Account, pero todavía no
puede ver tu Sheet. Tenés que compartirlo manualmente.

**Cómo:** Paso 4 de
[`scripts/setup_sheet_demo.md`](scripts/setup_sheet_demo.md).
Resumen rápido:
1. Abrí el JSON, copiá el valor de `"client_email"`.
2. En el Sheet, botón **Compartir** → pegá el email → permiso
   **Editor** → click **Compartir**.

---

## ☐ 5. Pegar el `GOOGLE_SHEETS_ID` en `.env`

**Por qué:** sin esto, el agente no sabe en qué Sheet leer.

**Cómo:**
1. Abrí el Sheet "Equipo Cartera DEMO" en el navegador.
2. La URL es algo como:
   `https://docs.google.com/spreadsheets/d/1AbCdEfGh1234567890XyZ/edit`
3. El ID es lo que está entre `/d/` y `/edit` (sin las barras).
4. Pegalo en `agentes/equipo-cartera/.env`:
   ```env
   GOOGLE_SHEETS_ID=1AbCdEfGh1234567890XyZ
   ```

---

## ☐ 6. Correr el primer smoke test del agente

Este es el comando que NO pude correr yo durante la noche porque no
había API key. Una vez que tengas los pasos 1-5 hechos, corré:

```cmd
cd agentes\equipo-cartera
venv\Scripts\activate.bat
python -m src.agent --prestamo PR-DEMO-003 --verbose
```

**Qué esperás ver:**
- Logs detallados (verbose) mostrando cada llamada del modelo y cada
  invocación de la tool `obtener_prestamo`.
- Al final, un bloque `RESULTADO DEL AGENTE` con la decisión, razón,
  mensaje (si decidió enviar) y conteo de tokens.

**Probá los 5 préstamos demo** uno por uno para ver cómo cambia la
decisión:

```cmd
python -m src.agent --prestamo PR-DEMO-001     :: vence en 5 días → recordatorio
python -m src.agent --prestamo PR-DEMO-002     :: vence mañana → recordatorio firme
python -m src.agent --prestamo PR-DEMO-003     :: mora 2 días → cobranza cordial
python -m src.agent --prestamo PR-DEMO-004     :: mora 10 días → tono firme
python -m src.agent --prestamo PR-DEMO-005     :: sin consentimiento → escalar
```

**Costo estimado:** ~$0.005 USD para los 5 (Haiku 4.5 es barato).

> Si alguno falla con `403 PERMISSION_DENIED`, olvidaste compartir el
> Sheet con el Service Account (Paso 4). Si falla con
> `404 NOT_FOUND`, revisá el `GOOGLE_SHEETS_ID` (Paso 5).

---

## ☐ 7. Verificar que la pestaña `eventos` se llenó

Después de correr el smoke test, abrí el Sheet en el navegador. La
pestaña `eventos` debería tener nuevas filas con el resultado de cada
ejecución (timestamp, prestamo_id, decisión, razón).

Si las filas aparecen → end-to-end funciona.
Si no aparecen → el agente está corriendo en modo stub (revisá
credentials path y `GOOGLE_SHEETS_ID`).

---

## ☐ 8. (Opcional) Hacer `git push` del commit que dejé hecho

Yo dejé el commit creado pero NO hice push. Cuando estés conforme con
todo, desde la raíz del repo:

```cmd
cd ..\..
git log --oneline -1                        :: ver el commit
git push origin main
```

---

## Recordatorios de seguridad

- **Nunca pegues el `.env` real ni el `service-account.json` en chats,
  tickets, o repos públicos.** El `.gitignore` los excluye, pero es por
  precaución.
- Si por error subiste alguno: rotá la API key de Anthropic
  (revocala en console.anthropic.com) y borrá la llave del Service
  Account (en Google Cloud → IAM → Cuentas de servicio → Claves).
- Para clientes reales (no demo), revisá que tengas el campo
  `consentimiento_cobro` en TRUE solo para los que firmaron tu
  política de tratamiento de datos (Ley 1581 de 2012).
