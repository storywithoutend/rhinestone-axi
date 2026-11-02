# rhinestone-axi

A Node-only forensic CLI for captured Rhinestone intent failures. It packages evidence, checks invariants offline, replays historical simulations, and correlates orchestrator status. It never signs or submits a transaction.

## Install

```sh
npm install --global rhinestone-axi
```

The package installs both `ens-rhinestone` and `rhinestone-axi`. They run the same CLI.

Requires Node 22.19 or later. `replay` also requires Foundry's `cast` and an archive-capable RPC endpoint.

To build from source:

```sh
npm install
npm run build
./dist/bin.js --help
```

Running `ens-rhinestone` with no arguments prints a compact TOON home view with the executable path, an explicit `0`-evidence state, and executable next commands. It never scans for captures.

## Commands

### Bundle captured artifacts

```sh
ens-rhinestone bundle \
  --out ./failure.zip \
  request.json route.json session.json orchestrator-error.json telemetry.json
```

Use `--profile safe` by default. It hashes signatures and replay calldata. Use `--profile local-replay` only for a local mode-`0600` bundle that must retain those bytes for replay.

Inputs are explicit paths. The command never searches browser storage, application data directories, or the working tree. Accepted inputs include JSON captures and plain log files. The bundle records source paths, byte counts, SHA-256 hashes, repository revision, SDK patch hash, and relevant environment metadata.

The command refuses to write a bundle if any input contains a private key, API key, bearer token, cookie, or mnemonic. Functions are omitted and recorded by path. Raw simulations are stored separately from their bounded summaries.

### Inspect offline

```sh
ens-rhinestone inspect ./failure.zip
ens-rhinestone inspect --json ./failure.zip
```

Inspection compares captured chain identifiers, deployment addresses, call targets and selectors, canonical `deployProxy` calldata, resolver grants, session mode and envelope fields, destination salt, `auxiliaryFunds`, refund caps, and lifecycle evidence. It continues after a failed check so one run can expose multiple faults.

Historical incident findings are labeled `incident-match`. They are clues, not proof of cause.

### Replay at historical state

```sh
ens-rhinestone replay \
  --rpc-url "$ARCHIVE_RPC_URL" \
  ./failure.zip
```

Replay validates the captured chain id and historical block before invoking:

```sh
cast call --trace --block <captured-block> --override-state-diff <captured-diff> ...
```

It never uses full storage replacement. A reproduced revert is successful command execution and reports the deepest revert it can recover. A setup fault such as a wrong chain or missing archive state is not reported as an application finding.

The RPC URL is redacted from command evidence and output.

### Correlate orchestrator status

```sh
RHINESTONE_ACCESS_TOKEN=... ens-rhinestone status \
  --intent-id 12345 \
  --bundle ./failure.zip \
  --rpc-url "$RPC_URL"
```

For a local mockestrator, use `RHINESTONE_API_KEY` and `--endpoint-url`. Credentials are accepted only through environment variables and are never written to a bundle or result.

`status` preserves the raw HTTP response and timestamp, does not collapse unknown status values, and can compare terminal status with a captured fill hash and on-chain receipt.

## Output

The default output is TOON 4.4 optimized for agent consumption. It includes pre-computed counts, bounded observations, failed checks, findings, limitations, and contextual next commands. Passing and skipped check details are omitted from the compact view.

Use `--full` for the complete TOON result. Use `--json` for the full `ens-rhinestone-result-v1` JSON envelope.

`-v`, `-V`, and `--version` print only the bare version through a fast path that does not load the command graph.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Command completed and no deterministic contradiction was found. A reproduced revert also uses `0`. |
| `10` | One or more deterministic checks failed. |
| `20` | Input or command usage is malformed or unsafe. |
| `30` | Evidence is incomplete or the requested correlation/replay is inconclusive. |
| `40` | Environment or tooling setup is wrong, such as chain mismatch, unavailable archive state, or missing `cast`. |

## Evals and AXI

```sh
npm run eval
```

The deterministic suite covers command behavior, security boundaries, replay safety, exit codes, and AXI ergonomics. The AXI principle mapping and deliberate domain exceptions are documented in [`AXI.md`](AXI.md).

## Boundaries

The CLI reads evidence and calls read-only RPC or HTTP endpoints. It includes only the pure deployment, address-derivation, session-salt, and refund-cap logic required for offline inspection. It does not include transaction submission or signing code.
