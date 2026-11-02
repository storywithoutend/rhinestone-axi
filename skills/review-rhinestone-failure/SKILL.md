---
name: review-rhinestone-failure
description: Review captured or historical Rhinestone intent failure code with the ens-rhinestone forensic CLI. Use when asked to diagnose a failed Rhinestone registration, compare a candidate fix with captured evidence, or reproduce a historical orchestrator revert without submitting transactions.
---

# Review a Rhinestone failure

Use the built `ens-rhinestone` binary supplied with the task. Do not install another version.

## Rules

- Read only the supplied repository, captures, bundle, RPC endpoint, and build information.
- Never search browser storage or application data directories.
- Never request, print, or persist a private key, API key, bearer token, cookie, or mnemonic.
- Never sign, send, broadcast, or simulate with a transaction-writing command.
- Treat an `incident-match` as a lead, not proof.
- Separate observations, deterministic checks, findings, and limitations in the review.
- Preserve unknown selectors, status values, and error bytes instead of guessing.

## Workflow

1. Build the CLI if only source is supplied:

   ```sh
   npm run build
   ```

2. If captures are supplied instead of a bundle, create a local bundle from only those explicit paths:

   ```sh
   packages/rhinestone-cli/dist/bin.js bundle \
     --profile local-replay \
     --out ./failure.zip \
     <capture-path>...
   ```

3. Inspect before reading the candidate fix:

   ```sh
   packages/rhinestone-cli/dist/bin.js inspect ./failure.zip
   ```

   Record every failed deterministic check and every limitation. Do not stop at the first failure.

4. If the bundle contains a historical block, exact call bytes, and state diffs, replay it with the supplied archive endpoint:

   ```sh
   packages/rhinestone-cli/dist/bin.js replay \
     --rpc-url "$ARCHIVE_RPC_URL" \
     ./failure.zip
   ```

   A reproduced revert is valid evidence. Missing archive state, chain mismatch, or missing `cast` is a setup problem, not evidence against the candidate.

5. Read the candidate code and its tests. Compare them with the CLI checks. Focus on the invariant that failed, not file names or historical patch shape.

6. If an intent id is supplied, correlate status without placing credentials on the command line:

   ```sh
   RHINESTONE_ACCESS_TOKEN="$RHINESTONE_ACCESS_TOKEN" \
     packages/rhinestone-cli/dist/bin.js status \
     --intent-id "$INTENT_ID" \
     --bundle ./failure.zip
   ```

The default TOON output is the agent-oriented view. Use `--full` when passing or skipped check details matter, and `--json` only when another program needs the exact result envelope.

## Review output

Write:

1. **Verdict** — pass, fail, or inconclusive.
2. **Direct observations** — captured bytes, decoded calls, trace facts, and code facts.
3. **Deterministic checks** — each relevant CLI check and whether the candidate addresses it.
4. **Findings** — severity, exact file and line, and why it matters.
5. **Limitations** — missing captures, unavailable archive state, unknown selectors, or unverified deployment data.
6. **Reproduction** — exact commands and exit codes.

Do not claim the candidate is correct because it resembles a historical fix. Require a passing invariant, a focused test, or a successful historical replay.
