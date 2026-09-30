# Safety contract — read this before touching AI or charge code

This document is normative. If any change here conflicts with what another
piece of code or documentation says, **this document wins**. The contract
exists because the entire project was specified by Tolga around one rule:

> "Yapay zeka kesinlikle kendi başına ücretlendirme falan yapamaz, yapay zeka
> sadece read only. Tüm ücretlendirmeler benim tarafımdan manuel
> tetiklenecek." ("AI cannot charge anything on its own — read only. Every
> charge is triggered by me, manually.")

## Rule 1 — AI is read-only

The AI categorizes. It does **not** charge. Specifically:

- `categorize()` (in `ai-proxy/src/categorize.ts`) makes
  `client.messages.create(...)` calls and parses structured `tool_use`
  responses. It never calls `/api/Menu3525/Charged`.
- The system prompt (in `ai-proxy/src/prompts.ts::buildSystemPrompt`)
  contains the literal line `"READ-ONLY"` and forbids the AI from
  suggesting bulk auto-charges.
- `extension/src/popup/components/StepReview.tsx` and any other UI code:
  the only way `chargeOnce()` is invoked is from a real `onClick`
  attached to one of the per-row buttons ("Tümünü ücretlendir" /
  "Seçili"). There is no `setInterval`, `setTimeout`, `useEffect`, or
  scheduler that fires a charge.

When in doubt, grep:

```
rg -n "chargeOnce\\(\\s*[^)]" extension/src/popup
```

Every match must be inside an `onClick` handler in a `<button>` (or
`onChange` of a select), bound to a human-driven event. If a match
appears anywhere else, **that change is unauthorized and must be
reverted**.

### Overrides are suggestions, not instructions

The operator maintains a per-tx keyword → firm override list
(`chrome.storage.local["overrides.v2"]`, see
`docs/OVERRIDES-JSON-FORMAT.md`). When the AI categorizes, those
rules are emitted as a fenced JSON block in the prompt
(`ai-proxy/src/prompts.ts::buildOverrideFragment`). The block is
framed as:

> "These are SUGGESTIONS the operator reviews manually — the AI NEVER
> auto-charges."

The AI's job is to produce a `suggestedAccountEuId` for each item —
the operator reviews every row in `/review` and clicks
`Ücretlendir` to actually POST. **Adding rules to the override list
must NEVER introduce a code path that calls `chargeOnce()` outside
of the existing manual button onClick handlers.** The only
write-capable surfaces are:

- `extension/src/popup/components/OverrideEditor.tsx`
  (bulk paste / JSON import / per-row edit) — writes
  `overrides.v2` via `saveOverrides`.
- `extension/src/popup/components/FirmOverrideMini.tsx`
  (single-firm keyword add/remove) — same key.
- `extension/src/popup/components/AddRuleInlinePopover.tsx`
  (per-tx popover in /review) — same key.

None of these call `chargeOnce`. The popover's only side effect is
persisting a rule.

## Rule 2 — No automatic charging of any kind

The Codec fallback row exists because HAR-confirmed unmatched items have
to land somewhere visible. **It is presented to the operator; it never
auto-charges.** The user clicks "Tümünü ücretlendir" (or per-item
"Ücretlendir") on the fallback row just like any other row.

There is no:

- `setTimeout(chargeTheCodecFallback, ms)`
- `Promise.resolve().then(chargeAllRows)`
- "auto-charge unmatched" toggle
- background-job script that charges anything on its own

If a future feature genuinely needs batch automation, **that feature
must NOT land until Tolga approves it in writing**, and this contract is
updated accordingly.

## Rule 3 — Tests never touch live

All HTTP calls from tests go to `127.0.0.1` / `localhost`. The guard
file `tests/live-guard.ts` (and equivalents in
`extension/src/__tests__/live-guard.ts`,
`ai-proxy/src/__tests__/live-guard.ts`) wraps `globalThis.fetch` to
**throw on any non-localhost URL**.

To override the guard you must set `LIVE=1`. CLI commands therefore
never set this. If you see a test running with `LIVE=1` in CI, **stop
the build**.

## Rule 4 — The HAR-derived fallback UUID is fixed

`CODEC_ACCOUNT_EU_ID = "00000000-0000-0000-0000-000000000000"` came from
`C:\Users\TGA\Desktop\admin-panel.codec.com.tr.har` — the
`/api/Menu3525/Charged` body for the operator's existing manual flow.
We never change this constant; it's the only firm id we charge "to
Codec" with. Adding a different fallback id would break the operator's
manual workflow.

## Rule 5 — Refusing a charge is easy and audit-visible

Every call to `chargeOnce()` writes a record into `chrome.storage.local`
under `audit.v1`. Failed calls write `"status": "error"`. The history
page (`StepHistory.tsx`) renders the log. **There is no
`storage.local.clear("audit.v1")` from app code** — only the explicit
"Geçmişi temizle" button, which is itself manual.
