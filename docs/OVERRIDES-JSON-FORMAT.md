# Overrides JSON format

Spec for the on-disk shape of the operator-maintained keyword → firm
override rules. This is **both** the file format (download/upload from
/Verileri Çek and /Bağlantı Ayarları) **and** the wire format sent to
the LLM as a fenced JSON block in the categorize prompt.

## File format

```jsonc
{
  "format": "hatali-katilimlar.overrides",
  "version": 2,
  "exportedAt": "2026-09-30T14:22:11.000Z",
  "rules": [
    {
      "id": "ov-1717123456789-3-k7p2",
      "accountName": "Aktif Bank",
      "acntEuId": "11111111-1111-1111-1111-111111111111",
      "keywords": ["EVET", "aktifbank"],
      "matchMode": "contains",
      "notes": "Kargo/EFT onay SMS'leri"
    }
  ]
}
```

### Envelope fields

| Field         | Type                    | Required | Notes                                                  |
| ------------- | ----------------------- | -------- | ------------------------------------------------------ |
| `format`      | string                  | yes      | Must equal `"hatali-katilimlar.overrides"` exactly.    |
| `version`     | number                  | yes      | `1` (legacy bare array) or `2` (current envelope).     |
| `exportedAt`  | ISO-8601 string         | optional | Set on export; informational only.                     |
| `rules`       | `KeywordOverride[]`     | yes      | See per-rule schema below.                             |

`format` is the strict gate — wrong format → file rejected. `version`
is informational; legacy `version: 1` bare arrays are auto-detected on
import without an envelope.

### Per-rule fields

| Field         | Type                       | Required | Notes                                                |
| ------------- | -------------------------- | -------- | ---------------------------------------------------- |
| `id`          | string                     | optional | `ov-<ts>-<idx>-<rand>`. Auto-generated if missing or duplicate. |
| `accountName` | string                     | yes      | Display name. Trimmed.                               |
| `acntEuId`    | string \| null             | optional | Operator's cached UUID. Null when firm isn't in the customer list (still imports, but `chargeOnce` will throw). |
| `keywords`    | string[]                   | yes      | At least one non-blank entry after trim. Blank entries are stripped. |
| `matchMode`   | `"contains"` \| `"exact"`  | optional | Defaults to `"contains"`. Unknown values → row dropped with reason. |
| `notes`       | string                     | optional | Free-form, ignored by the AI.                         |

## Validation rules

- **Strict types**: `accountName` must be a non-empty trimmed string,
  `keywords` must be an array of strings with at least one non-blank
  entry, `matchMode` (if present) must be `"contains"` or `"exact"`.
- **Lenient missing-optional fields**: missing `id`, missing
  `acntEuId`, missing `matchMode` → defaults applied (id regenerated,
  `null`, `"contains"`).
- **Per-row errors are non-fatal**: rows that fail validation are
  dropped with a reason string. The rest of the file still imports.
  The toast shows: `"12 eklendi · 3 güncellendi · 1 atlandı (hata: …)"`.

## Merge strategy

- Deduped by `id`.
- **Newer wins**: when an imported rule's `id` matches an existing
  local rule, the imported rule replaces the local one. Operators
  editing their exported file expect their edits to be authoritative.
- **Missing id** → regenerated as `ov-<ts>-<idx>-<rand>`. The rule
  is appended as new.
- **Duplicate id within the imported file** → first occurrence wins;
  later occurrences are processed as new rows with a regenerated id.

## Wire format → LLM

In `ai-proxy/src/prompts.ts::buildOverrideFragment`, the same rule
objects are serialized as a fenced ` ```json ` block:

```
=== OVERRIDES (3) — operator-maintained routing rules ===

These are SUGGESTIONS the operator reviews manually — the AI NEVER auto-charges.
A rule's `keywords` are matched (per `matchMode`) against the LITERAL contents
of an item's keyword1, keyword2, or msgContent fields.

```json
{
  "rules": [
    {
      "accountName": "Aktif Bank",
      "acntEuId": 17,
      "keywords": ["EVET", "aktifbank"],
      "matchMode": "contains",
      "notes": "Kargo/EFT onay SMS'leri",
      "resolvedFromCustomerList": true
    },
    {
      "accountName": "PTT",
      "acntEuId": null,
      "keywords": ["ptt"],
      "matchMode": "contains",
      "notes": "",
      "resolvedFromCustomerList": false,
      "warning": "müşteri listesinde yok — yine de öner, chargeOnce throw eder"
    }
  ]
}
```

Key wire-format differences from the on-disk file:

- `acntEuId` is rewritten as the **1-based integer index** from the
  customer list (or `null` when the firm isn't found / the cached
  UUID doesn't match the canonical one). The proxy translates the
  integer back to the real UUID before charging — same mechanism as
  the rest of the LLM `suggestedAccountEuId` flow.
- A `resolvedFromCustomerList: boolean` and an optional `warning`
  field are added so the LLM can see when a rule has no resolvable
  firm.
- The `id` and `exportedAt` envelope fields are dropped — they're
  operator-side bookkeeping, irrelevant to routing.

Empty-keyword rules (where every entry in `keywords` is blank after
trim) are dropped before either serialization — both file and wire
formats silently omit them.

## Match semantics

Mirrored verbatim in `extension/src/lib/overrideMatcher.ts` so the
editor's dry-run report and the AI's behaviour match exactly:

- **`matchMode: "contains"`** — case-insensitive substring match.
  The rule's keyword must appear somewhere in the item's `keyword1`,
  `keyword2`, or `msgContent`.
- **`matchMode: "exact"`** — case-insensitive whole-field equality
  after trim. The field's full value (whitespace stripped) must equal
  one of the rule's keywords.
- Empty keyword arrays never match.

## Why JSON, not the old TSV/CSV

The previous pipe-separated format had two problems that JSON fixes:

1. **Pipe characters in notes** would silently split a row into two.
2. **Empty keyword cells** (e.g. `Aktif Bank | EVET | | | Kargo`) were
   rendered as `—` and silently dropped — operators had no way to
   spot that their third keyword was lost.

The legacy pipe / TSV / CSV bulk-paste path is **still supported** as
"Eski format" inside the editor — 41 existing tests cover it — so
operators who already have Excel sheets don't have to migrate. New
rules should go through JSON.

## Migration & backward compatibility

- `chrome.storage.local["overrides.v1"]` (bare `KeywordOverride[]`)
  is still readable. `loadOverrides()` returns it verbatim; the next
  `saveOverrides()` writes the data into the new
  `overrides.v2` envelope.
- `overrides.v1` files on disk (no envelope) are auto-detected on
  import and accepted as-is.
- `chrome.storage.local["overrides.v2"]` (envelope) is the
  authoritative key going forward.

## File location

- **Download**: `kurallar-YYYY-MM-DD.json` (the envelope's
  `exportedAt` provides the date).
- **Upload**: any path on disk. The `<input type="file">` filter
  accepts `application/json,.json`.

## References

- `extension/src/lib/overrideExport.ts` — exporter + importer.
- `extension/src/lib/overrideMatcher.ts` — match semantics (used by
  both the dry-run report and the LLM contract).
- `ai-proxy/src/prompts.ts::buildOverrideFragment` — wire format
  emitter.
- `extension/src/__tests__/overrideExport.test.ts` (21 tests) —
  round-trip, schema validation, merge strategies, legacy bare-array.
- `extension/src/__tests__/overrideMatcher.test.ts` (16 tests) —
  contains/exact/empty-keyword behaviour.
- `ai-proxy/src/__tests__/prompts-overrides.test.ts` (11 tests) —
  wire-format regression, safety contract line.
