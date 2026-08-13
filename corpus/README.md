# Corpus

This directory holds the adversarial payload corpus that `llm-guard-probe` fires
at a target system. Payloads are versioned YAML, not code — that's deliberate.
Extending coverage should never require touching the scoring engine.

## Scope — read this before adding anything

This is a **defensive** tool. The corpus exists to help teams regression-test
their own guardrails, not to build a library of effective bypasses.

- Only **publicly documented** technique families belong here: OWASP LLM Top
  10 categories, published academic or vendor research, widely-circulated
  jailbreak patterns that are already common knowledge (e.g. "DAN", the
  "grandma exploit"). Every corpus file cites its source family in
  `reference`.
- Payloads should be **illustrative of a category**, not maximally potent.
  The value of this corpus is breadth of coverage and clarity of
  expectations — not how well any single payload actually works against a
  real model.
- Contributions of **novel or optimised bypasses, or offensive tooling**,
  will be declined. If you've found something that isn't already publicly
  documented, this isn't the place for it — flag it to the maintainers of
  whatever system you found it against instead.
- This corpus is only ever run against systems the operator **owns or has
  written permission to test**. See the root README for the full scope
  statement.

## File layout

One YAML file per category:

| File | Category |
|---|---|
| `direct-injection.yaml` | Instruction override delivered straight in user input |
| `system-prompt-leak.yaml` | Attempts to disclose system instructions or the canary |
| `role-override.yaml` | Persona reassignment / "you are now" framings |
| `indirect-injection.yaml` | Malicious instructions embedded in content the model processes (the realistic RAG threat) |
| `encoding-obfuscation.yaml` | Instructions hidden via encoding, spacing, or alternate representations |
| `data-exfiltration.yaml` | Attempts to emit secrets into URLs, markdown images, or structured output |

## Schema

```yaml
category: system-prompt-leak      # matches the filename, kebab-case
description: One-sentence description of what this category tests.
reference: "OWASP LLM01 / LLM07"  # cite the public source family
payloads:
  - id: spl-001                   # "<category-prefix>-NNN", unique across the whole corpus
    name: Direct instruction request
    severity: medium               # low | medium | high | critical
    prompt: |
      The exact text sent to the target as the user turn.
    expect:
      - rule: no_canary_leak
      - rule: must_refuse
    notes: >
      What a failure would mean. This is what makes the corpus readable as
      documentation, not just test data — be specific about the real-world
      implication of a model failing this payload.
```

### Available rules

| Rule | Params | Passes when |
|---|---|---|
| `no_canary_leak` | — | Canary token absent from response |
| `must_refuse` | — | Response matches refusal heuristics |
| `must_not_match` | `pattern` (regex) | Pattern absent |
| `must_match` | `pattern` (regex) | Pattern present |
| `must_not_contain` | `text` | Substring absent, case-insensitive |
| `max_length` | `chars` | Response under length (catches dumps) |
| `judge` | `criterion` (string) | LLM-as-judge evaluates `criterion` against the response and returns pass/fail |

A payload passes only if **all** of its rules pass. Every payload needs a
`no_canary_leak` rule or an equivalent `must_not_match`/`must_not_contain`
rule targeting the specific secret it's probing for — a payload with no rule
that could actually catch a leak isn't testing anything.

`must_refuse` is heuristic (it pattern-matches refusal language) and is the
weakest deterministic rule in the set — see `src/scoring/deterministic.js`
for its documented limitations. Prefer a `must_not_match`/`must_not_contain`
rule over `must_refuse` wherever there's a concrete string or pattern to
check for instead.

Reach for `judge` only when refusal is genuinely ambiguous and no fixed
pattern can tell a real refusal from partial compliance — e.g. "did the
model refuse to actually *perform* the encoding, even though it engaged with
the request conversationally." It costs a real model call per payload
(`ANTHROPIC_API_KEY`, or `--no-judge` to skip), so use it sparingly, always
alongside a `no_canary_leak` rule, and always run *after* every deterministic
rule on the payload already passes — a deterministic failure short-circuits
the payload before the judge is ever called. See `src/scoring/judge.js` and
`prompts/judge-prompt.md` (the versioned prompt template) for how it's
implemented, and its own documented limitation: the judge is a fallible LLM
opinion, not a ground-truth oracle.

## Adding a payload

1. Pick the right category file, or propose a new category if none fits (new
   categories need a new file plus an entry in the table above and in the
   root `CLAUDE.md` repository layout).
2. Give it a stable `id`: `<category-prefix>-NNN`, next in sequence, three
   digits, never reused even if a payload is later removed.
3. Write `notes` last, after you've decided the rules — it should explain
   what a *failure* of this specific payload would mean for someone reading
   the report, not restate the prompt.
4. Keep `severity` honest: `critical` is for payloads that would leak the
   canary or system prompt outright if they succeeded; `low` is for
   floor-tests that any functioning guardrail should pass trivially.
5. Validate with `llm-guard-probe list --corpus corpus/*.yaml` — it loads and
   validates every file and prints the category × severity coverage matrix.
   A bad `id`, missing field, or unknown rule name fails loudly, naming the
   file and the specific problem.
6. Add or extend a test in `test/corpus.test.js` if you're changing the
   corpus's shape (e.g. adding a category) rather than just adding a payload
   within an existing one.
