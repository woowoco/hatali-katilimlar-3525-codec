# AGENTS.md

> **STOP — read [`docs/SAFETY-CONTRACT.md`](docs/SAFETY-CONTRACT.md) before doing anything.**

This file gives an LLM-style coding agent (Claude, GPT, or anything
similar) the small set of project-specific guardrails so its work stays
inside the bounds the operator set.

## Hard rules

1. **The AI is read-only.**
   - `ai-proxy/src/categorize.ts` only produces structured annotations; it
     never POSTs to `/api/Menu3525/Charged`.
   - The system prompt in `ai-proxy/src/prompts.ts` must contain the
     explicit `READ-ONLY` rule. Do not weaken or paraphrase it.
   - Every call to `chargeOnce()` must be reachable only from a manual
     `button.onClick` in `extension/src/popup/`. If you find yourself
     putting one inside `useEffect`, `setTimeout`, a Promise chain, or
     an event listener attached to non-button elements — **stop and ask**.
2. **No automated charge scheduling.** Do not introduce `setInterval`,
   `setTimeout(...charge...)`, debounced auto-charges, or a chrome
   alarm that calls `chargeOnce`. The roster of charging triggers is
   exactly: per-row **Tümünü ücretlendir** and per-selection **Seçili**
   buttons.
3. **No live network in tests.** `tests/live-guard.ts` and the per-workspace
   `live-guard.ts` files throw on any non-localhost `fetch`. Set
   `LIVE=1` only with the operator's explicit go-ahead — and never in CI.
4. **`CODEC_ACCOUNT_EU_ID` is HAR-derived and not negotiable.** It equals
   `"00000000-0000-0000-0000-000000000000"` and is required for the
   operator's pre-existing manual Codec-billing flow. Don't "fix" it.
5. **No Anthropic SDK in the browser bundle.** The browser only speaks
   JSON to the local proxy. If a feature seems to require the API key
   client-side, do not implement it.

## Where to look first when a task lands

1. Read the related `docs/` document (`ARCHITECTURE.md`,
   `OPERATIONS.md`, `SAFETY-CONTRACT.md`).
2. Skim the entry points listed in `CLAUDE.md`.
3. If the task affects AI categorization or charging, **state explicitly**
   in the PR / commit message which safety rule applies and why the
   change respects it.

## Style rules already enforced by code review

- Match existing comment density: short JSDoc on exports, inline comments
  for non-obvious branches.
- Don't strip "why" comments — only strip pure restatement comments.
- Put response-shape normalization in `lib/`, not JSX.
- Run `npm run typecheck && npm test && npm run build:ext` before
  declaring anything done.
