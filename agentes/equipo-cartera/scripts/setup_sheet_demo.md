# Setup del Google Sheet demo — paso a paso

Este documento te guía para crear el Google Sheet que el agente
**Equipo Cartera** va a leer en producción. Está escrito para alguien
sin experiencia técnica: leelo de arriba hacia abajo, no te saltes pasos.

> **Cuánto te tomará:** 20–30 minutos la primera vez.

> **Importante:** mientras no hagas este setup, el agente funciona en
> "modo stub" con 5 préstamos hardcodeados. Eso sirve para probar, pero
> no toca cartera real. Cuando termines este setup y pegues el
> `GOOGLE_SHEETS_ID` en `.env`, el agente pasa automáticamente a leer
> del Sheet real.

---

## Paso 1 — Crear el Google Sheet

1. Andá a https://sheets.google.com.
2. Click en `+` (Hoja en blanco).
3. Nombre del archivo: **Equipo Cartera DEMO** (renombrá arriba a la
   izquierda).
4. **Copiá el ID del Sheet desde la URL del navegador.** La URL se ve
   así:
   ```
   https://docs.google.com/spreadsheets/d/1AbCdEfGh1234567890XyZ/edit#gid=0
                                          └─────── este es el ID ──────┘
   ```
   Guardalo en un bloc de notas — lo vas a pegar en `.env` al final.

## Paso 2 — Crear las dos pestañas con su esquema

El agente espera **dos pestañas** (sheets) dentro del archivo:
`prestamos` y `eventos`.

### Pestaña `prestamos`

1. Renombrá la pestaña por defecto (abajo, donde dice "Hoja 1") a
   **`prestamos`** (todo en minúscula, sin acentos).
2. En la fila 1, escribí estos encabezados de la columna A a la N (uno
   por celda):

   | A | B | C | D | E | F | G | H | I | J | K | L | M | N |
   |---|---|---|---|---|---|---|---|---|---|---|---|---|---|
   | id | cliente_nombre | cliente_telefono | cliente_cedula | monto_capital | tasa_mes | fecha_desembolso | fecha_vencimiento | frecuencia | saldo_pendiente | estado | ultimo_contacto | ultimo_canal | consentimiento_cobro |

3. Cargá los **datos demo** copiándolos desde
   `agentes/equipo-cartera/scripts/datos_demo.csv`:
   - Abrí ese archivo CSV en cualquier editor de texto.
   - Copiá las **filas de datos** (no la fila de encabezados — esos ya
     los pusiste en el paso 2).
   - En el Sheet, hacé click en la celda `A2` y pegá. Google Sheets
     debería distribuir los valores en las columnas automáticamente.
     Si todo queda en una sola columna, usá `Datos → Dividir texto en
     columnas → Separador: coma`.

### Pestaña `eventos`

1. Abajo, click en `+` para crear una pestaña nueva. Renombrala a
   **`eventos`**.
2. En la fila 1, encabezados de la columna A a la G:

   | A | B | C | D | E | F | G |
   |---|---|---|---|---|---|---|
   | timestamp | prestamo_id | tipo | canal | contenido | resultado | costo_usd |

3. Dejá la pestaña vacía debajo de los encabezados — el agente la va a
   ir llenando solo a medida que tome decisiones.

## Paso 3 — Crear un Service Account en Google Cloud

Un Service Account es una "cuenta de máquina" que el agente usa para
leer el Sheet sin necesitar tu password personal.

1. Andá a https://console.cloud.google.com.
2. Si nunca usaste Google Cloud, te va a pedir aceptar términos. Aceptá.
3. **Crear un proyecto** (si no tenés uno):
   - Arriba a la izquierda, donde dice "Selecciona un proyecto", click.
   - Botón **Proyecto nuevo** (arriba a la derecha en el modal).
   - Nombre: `equipo-cartera`. Click **Crear**.
   - Esperá a que termine de crearse (15-30 segundos) y seleccionalo.

4. **Habilitar las APIs** (importantísimo, si no fallará todo):
   - En la barra de búsqueda de arriba escribí: `Google Sheets API`.
   - Click en el primer resultado → botón **Habilitar**.
   - Esperá a que diga "API habilitada".
   - Volvé a la barra de búsqueda y buscá: `Google Drive API`.
   - Click → botón **Habilitar**.

5. **Crear el Service Account:**
   - En la barra de búsqueda escribí: `Cuentas de servicio` (o
     `Service Accounts` si tu cuenta está en inglés).
   - Click en el resultado bajo "IAM y administración".
   - Botón **+ Crear cuenta de servicio** (arriba).
   - Nombre: `equipo-cartera-bot`. ID: se autocompleta. Descripción:
     `Agente cobrador — lectura cartera`.
   - Click **Crear y continuar**.
   - En "Otorgar acceso" podés saltarlo (click **Continuar**).
   - En el último paso click **Listo**.

6. **Generar la llave JSON:**
   - En la lista de cuentas de servicio, click sobre
     `equipo-cartera-bot@...`.
   - Pestaña **Claves** (arriba).
   - Botón **Agregar clave → Crear clave nueva**.
   - Tipo: **JSON**. Click **Crear**.
   - Se va a descargar automáticamente un archivo `.json`.
   - **Renombralo** a `service-account.json`.
   - **Movelo** a: `agentes/equipo-cartera/credentials/service-account.json`.

   > ⚠️ **Este archivo es secreto.** No lo subas a GitHub, no lo
   > compartas. El `.gitignore` ya lo excluye, pero verificá.

## Paso 4 — Compartir el Sheet con el Service Account

El Service Account es como un usuario más: necesita permisos para leer
y escribir el Sheet.

1. Abrí el archivo `service-account.json` con un editor de texto.
2. Buscá el campo `"client_email"`. Copiá el valor — algo como:
   `equipo-cartera-bot@equipo-cartera-12345.iam.gserviceaccount.com`.
3. Volvé al Google Sheet "Equipo Cartera DEMO".
4. Botón **Compartir** (arriba a la derecha, azul).
5. Pegá ese email en el campo.
6. Asegurate de que tenga permiso de **Editor** (no solo lector — el
   agente tiene que poder escribir en `eventos`).
7. Desmarcá "Notificar a las personas". Click **Compartir**.

## Paso 5 — Configurar el `.env`

1. Abrí `agentes/equipo-cartera/.env` con un editor de texto.
2. Pegá el ID del Sheet (Paso 1.4) en la línea correspondiente:
   ```env
   GOOGLE_SHEETS_ID=1AbCdEfGh1234567890XyZ
   ```
3. (Solo si moviste el JSON a otra ruta) ajustá
   `GOOGLE_CREDENTIALS_PATH`. Si lo dejaste en `credentials/service-account.json`
   no toques nada.
4. Pegá tu API key de Anthropic en `ANTHROPIC_API_KEY=`. Obtenela en
   https://console.anthropic.com/settings/keys.

## Paso 6 — Verificar que todo conecta

Desde la terminal, parado en `agentes/equipo-cartera/`:

```cmd
venv\Scripts\activate.bat
python -m src.agent --prestamo PR-DEMO-001 --verbose
```

Si ves logs que dicen "SheetsClient conectado a Sheet real id=..." y
una decisión final del agente, **todo funciona**. Si ves "modo STUB",
revisá Pasos 3 a 5.

---

## Problemas comunes

| Síntoma | Causa probable |
|---|---|
| `SheetsClient en modo STUB (credenciales no encontradas...)` | El JSON no está en `credentials/service-account.json`. |
| `403 PERMISSION_DENIED` al correr | Olvidaste compartir el Sheet con el `client_email` (Paso 4). |
| `404 NOT_FOUND` al correr | El `GOOGLE_SHEETS_ID` está mal copiado o el Sheet no existe. |
| `googleapiclient.errors.HttpError: 400` por las APIs | No habilitaste Sheets API o Drive API (Paso 3.4). |
