# Wendy — Menlo / Remax AI Platform

Wendy is a single, persistent executive intelligence: it observes signals, connects them to
persisted context (people, relationships, meetings, commitments, memory), reasons with Claude
over real evidence, anticipates what matters, prepares actions and asks for approval when the
impact requires it.

Current status: **Phase 1 built; reality gate NOT passed** (live Claude tests blocked by API
credit balance). See `WENDY_PHASE_1_COMPLETION_REPORT.md`.

## Requirements

- Node ≥ 22 (tested on 24)
- PostgreSQL 16 running locally, with databases `wendy` and `wendy_test`
  (`createdb wendy && createdb wendy_test`)
- `.env` in this folder (gitignored) with an Anthropic API key **for this project**:
  `ANTHROPIC_API_KEY=...` and, only for keys not scoped to a workspace, `ANTHROPIC_WORKSPACE_ID=wrkspc_...`

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run migrate` | Create/upgrade the schema in `wendy` |
| `npm test` | Deterministic suite (85 tests, isolated schemas in `wendy_test`; no Claude) |
| `npm run test:live` | Live suite against real Claude (11 tests; requires API credit) |
| `npm run demo` / `npm run demo -- b` | "First wow": one new email → one cognitive cycle with real Claude |
| `npm run worker` | Continuous loop: detectors, event processing, execution (real Claude) |
| `npm run inspector` | Read-only UI at http://127.0.0.1:3457 (Hoje, Aprovações, Atividade, Ontologia, Pessoas e memória, Integrações, Auditoria) |
| `npm run inspector:sample` | Builds a `sample_test_double` schema for the UI using the **test double, not Claude** (clearly labeled in the UI) |
| `npm run typecheck` | TypeScript check |
| `npm run legacy:ui` / `npm run legacy:test` | Frozen legacy prototype (not connected to the core) |

## Layout

```
src/          Cognitive Core (TypeScript): events, cognition, actions, audit, repositories, runtime
fixtures/     Parameterized DEV worlds (kept outside src/ so the anti-hardcode scan can prove src/ knows no scenario)
tests/unit    Deterministic tests (mechanics use a labeled test double)
tests/live    Real-Claude tests
inspector/    Read-only UI server + pages (DB sessions forced read-only)
scripts/      demo, sample data
legacy/       Frozen prototype
```

## Ground rules (from the product spec)

- Claude reasons; code decides facts, state, salience, policy, idempotency, execution and audit.
- No keyword intelligence, no scenario-specific code, no fake provenance, delivery or verification.
- Anything not real is labeled as such in code, UI and reports.
