# llm-guard-probe

A defensive evaluation harness that regression-tests LLM applications against known prompt-injection and guardrail-bypass techniques, then produces a structured findings report.

## Scope and responsible use

This tool is for testing systems you **own or have written permission to test**. The included corpus contains only publicly documented technique categories (OWASP LLM Top 10, published research) — it is not, and will not become, a repository of novel or optimised bypasses. It is a defensive tool: it exists to help teams catch guardrail regressions, not to attack systems they don't control.

> Full build spec and phased plan: [docs/llm-guard-probe-spec.md](docs/llm-guard-probe-spec.md)
