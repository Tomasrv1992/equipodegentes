# Evals del extractor LLM

Harness para evaluar `lib/llm-extractor.ts` (el extractor de datos de documentos
no-DIAN con Claude) contra casos conocidos. Mide si clasifica bien
factura/no-factura y si extrae bien los campos.

**No corre en CI** (llama a la API de Anthropic, cuesta centavos por caso).

## Correr

```bash
npx tsx --env-file=<archivo .env con ANTHROPIC_API_KEY> \
  agentes/Equipo-facturacion/evals/run-evals.ts
```

Imprime una tabla `caso | es_factura esperado/obtenido | estado` y un resumen
con precisión, recall, falsos positivos y falsos negativos.

## Agregar un caso

Creá una subcarpeta en `fixtures/` con dos archivos:

- `input.txt` — el texto del documento, tal como lo recibiría el LLM (lo que
  hoy sale de `extractTextFromPdf` / `extractTextFromDocx`).
- `expected.json`:

```json
{
  "presumedType": "cuenta_cobro",        // cuenta_cobro | recibo_internacional | recibo_servicio | email_body
  "nitCliente": "901117356",             // opcional, para probar el filtro self-emitted
  "nombreCliente": "Dentilandia",        // opcional
  "nota_caso": "texto libre describiendo el caso (opcional)",
  "expected": {
    "es_factura": true,
    "numero_documento": "143",
    "proveedor_nit": "43076121",
    "total": 1500000,
    "fecha": "2026-03-10",
    "categoria": "Servicios"
  }
}
```

Reglas de comparación:
- `es_factura`: el extractor devuelve `null` cuando NO es factura → el harness lo
  trata como `es_factura=false`.
- `numero_documento`, `proveedor_nit` (solo dígitos), `total` (exacto), `fecha`
  (YYYY-MM-DD) se comparan solo cuando el caso es factura en ambos lados.
- `categoria` es **informativa**: el extractor LLM NO categoriza (eso lo hace
  `categorizar()` en el pipeline, después). Se muestra pero no se evalúa.

## Importante

- Fixtures **100% sintéticos** (NITs/CUFEs/nombres inventados). Cero datos reales.
- El harness NO modifica `llm-extractor.ts` ni sus umbrales. Si un caso falla,
  es un hallazgo a documentar, no algo a "arreglar" tocando el extractor.
