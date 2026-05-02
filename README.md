# Equipo de Agentes

Suite de agentes automatizados para PYMEs. Cada agente corre como un servicio
autónomo (cron diario en Netlify) que se conecta a las cuentas de Google del
cliente y le ahorra horas de trabajo manual.

## Estructura del monorepo

```
equipodegentes/
├── agentes/            # Cada agente = un servicio independiente
│   └── facturacion/    # MVP — control de facturas DIAN (Gmail → Drive → Sheets)
│
├── shared/             # Código compartido entre agentes (auth, billing, UI)
│   └── (vacío por ahora — se llena cuando 2+ agentes necesiten lo mismo)
│
├── apps/               # Apps web del producto
│   ├── landing/        # (futuro) marketing site
│   ├── admin/          # (futuro) panel del owner — ver todos los clientes
│   └── customer/       # (futuro) panel del cliente — configurar agentes
│
├── netlify/
│   └── functions/      # Functions Netlify (cron + workers)
│       ├── facturacion-cron.mts
│       └── facturacion-background.mts
│
└── docs/               # Specs, decisiones de arquitectura
```

## Agentes

| Agente | Estado | Descripción |
|---|---|---|
| **facturacion** | ✅ MVP single-tenant funcionando | Lee Gmail, extrae facturas DIAN, organiza Drive + Sheets, etiqueta correos, envía email diario |
| cartera | 🔜 planificado | (TBD) seguimiento de cuentas por cobrar |

## Quick start (desarrollo local)

```bash
# 1. Clonar
git clone https://github.com/Tomasrv1992/equipodegentes.git
cd equipodegentes

# 2. Instalar deps (todo el monorepo)
npm install

# 3. Configurar el agente que quieras correr
cd agentes/facturacion
cp .env.local.example .env.local
# editar .env.local con tus credenciales (ver agentes/facturacion/README.md)

# 4. Setup OAuth (one-time)
npm run setup-oauth

# 5. Probar
npm run dry-run
```

## Filosofía multi-agente

- Cada agente es **autónomo**: tiene su propia carpeta, scripts, lógica core.
- Las **netlify functions** viven en `netlify/functions/` con prefijo del agente
  (ej: `facturacion-cron.mts`) y son thin wrappers que importan la lógica de
  `agentes/<agente>/lib/`.
- El código duplicado entre agentes se mueve a `shared/` cuando aparezca.
- Cada agente puede deployarse independiente o desactivarse sin tocar a los otros.

## Visión comercial

Producto SaaS multi-tenant donde cada cliente:
1. Crea cuenta y conecta sus servicios (Google, Stripe, etc.)
2. Activa los agentes que quiera (facturación, cartera, etc.)
3. Define reglas custom por agente (qué procesar, qué ignorar, cómo notificar)
4. Paga suscripción mensual única que cubre todos los agentes activados

Spec inicial: `docs/vision-saas.md` (a escribir).
