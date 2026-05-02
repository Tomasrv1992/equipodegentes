# Agent Instructions for `equipodegentes`

## What this repo is

- Monorepo for autonomous agent services focused on SMEs.
- Root contains shared workspace config, repo-level scripts, and Netlify deployment config.
- Each agent lives under `agentes/<agent-name>/` and is designed to be independent.
- `apps/` contains future web apps, `shared/` is reserved for cross-agent shared code.
- Netlify functions are in `netlify/functions/` and act as thin wrappers for agent logic.

## Primary conventions

- Treat each folder under `agentes/` as a separate agent service.
- Use root `package.json` scripts for the JavaScript/TypeScript agent stack.
- Do not assume a single runtime: `agentes/facturacion` is Node/TS, while `agentes/equipo-cartera` is Python/Anthropic.
- Keep changes isolated per agent unless you are intentionally adding shared functionality.

## Important paths

- `agentes/Equipo-facturacion/` — invoice automation agent.
- `agentes/equipo-cartera/` — cartera/cobranza agent.
- `netlify/functions/` — Netlify scheduled/background functions for production.
- `README.md` — repo-level overview and quick start.
- `agentes/Equipo-facturacion/README.md` — facturación setup, env vars, and commands.
- `agentes/equipo-cartera/README.md` — Python agent setup, tests, and prompt tooling.
- `agentes/equipo-cartera/CLAUDE.md` — agent prompt/context documentation.

## How to be productive here

- Start by reading the relevant agent README before editing that agent.
- For TypeScript work, use `npm install` at repo root and the root scripts in `package.json`.
- For Python work in `agentes/equipo-cartera/`, follow the local `venv` and `requirements.txt` setup.
- Use `npm run typecheck` to validate TS changes.
- Use `pytest -v` inside `agentes/equipo-cartera/` for Python unit tests.

## Agent-specific guidance

- `Equipo-facturacion`: Netlify scheduled/background functions and Google API integration. Focus on Gmail/Drive/Sheets orchestration and idempotent processing.
- `equipo-cartera`: Claude tool-driven decision loop, Google Sheets integration, and loan collection logic. Preserve the legal and contact rules documented in the README.

## Notes for AI coding agents

- Preserve existing environmental assumptions and credentials handling; do not hardcode secrets.
- Prefer linking to existing documentation in `README.md` and agent READMEs rather than duplicating details.
- If adding new cross-agent behavior, consider whether it belongs in `shared/`.
- If the task touches the deploy layer, check `netlify.toml` and the Netlify function files.
