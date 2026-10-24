# Evolving intelligence: staged rollout

## Goal

Add an improvement loop around a configurable OpenAI-compatible inference endpoint. The application does **not** train its own model weights from this daily workflow. It can improve through reviewed code changes, explicit user feedback, repeatable evaluations, and carefully versioned prompt/routing/memory changes.

## Phase 1 — safe inference adapter (this branch)

- Adds `src/evolving_intelligence.py`, an opt-in async client for the standard `/v1/chat/completions` API.
- Supports a custom base URL, model ID, optional bearer key, bounded timeout, and injectable HTTP transport for offline tests.
- Disabled by default. No existing model endpoint, session, memory, database, or stored user data is changed.
- The adapter is additive and is not yet wired into the normal chat route. Existing inference remains authoritative until a later integration passes the full chat and fallback test suite.

## Phase 2 — controlled integration

1. Add an admin-controlled provider configuration using the existing model-endpoint/settings mechanisms; never store provider secrets in Git or browser-visible settings.
2. Route a test cohort to the compatible endpoint while keeping the existing model as fallback.
3. Verify non-streaming and streaming chat, model discovery, tool calls, cancellation, timeout handling, and error fallback.
4. Keep the legacy route enabled until a documented acceptance suite passes on a non-production preview.

## Phase 3 — measured daily improvement

- Record explicit feedback and evaluation outcomes with data minimization; do not silently persist raw conversations for training.
- Run a small, deterministic regression set daily and compare candidate behavior with the current baseline.
- Let automation propose a branch/PR and summarize evidence. Require human review before merging, changing production routing, or deleting the legacy model path.
- Promote a candidate only when quality and reliability are at least as good as the baseline and the cost remains within the ₱0 budget.

## Configuration

The adapter reads these server-side environment variables:

- `ODYSSEUS_EVOLVING_AI_ENABLED` — opt-in flag; defaults to false.
- `ODYSSEUS_EVOLVING_AI_BASE_URL` — provider base URL or full Chat Completions URL.
- `ODYSSEUS_EVOLVING_AI_MODEL` — model ID understood by the configured provider.
- `ODYSSEUS_EVOLVING_AI_API_KEY` — optional server-side bearer key; never commit it.
- `ODYSSEUS_EVOLVING_AI_TIMEOUT` — request timeout in seconds (default 30, capped at 300).

A provider endpoint may be free, self-hosted, or paid. The code itself is provider-independent, but **₱0 is only guaranteed when the configured endpoint is genuinely free or self-hosted**. Do not enable a paid endpoint without explicit approval.

## Verification and rollout guardrails

- Adapter tests use an in-process mock HTTP transport and make no external network calls.
- No model weights are committed to the repository.
- No production deployment or merge is part of this change.
- The built-in model must not be removed until end-to-end acceptance tests prove the replacement is reliable and the owner explicitly approves the final cutover.
