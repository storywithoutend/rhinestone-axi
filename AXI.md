# AXI design contract

`ens-rhinestone` follows the ten Agent eXperience Interface principles from [`kunchenguid/axi`](https://github.com/kunchenguid/axi) at revision `4184081afe3ad7ef658a982c0c224df8fb4e97fe`.

TOON output targets specification 4.4 at [`toon-format/spec`](https://github.com/toon-format/spec) revision `8c9edee5f22facef696ccddc7ce109574fe6da0e`.

## Principle mapping

1. **Token-efficient output** — stdout defaults to TOON. `--json` returns the complete `ens-rhinestone-result-v1` envelope for programs that require JSON.
2. **Minimal default schemas** — default output shows aggregate counts, bounded observations, failed checks, findings, limitations, and next commands. Passing and skipped check details stay out of the default view.
3. **Content truncation** — default output limits collections to eight items and strings to 800 characters. A size-aware hint points to `--full` only when something was truncated.
4. **Pre-computed aggregates** — every result includes observation, check, pass, fail, skip, finding, and limitation counts.
5. **Definitive empty states** — empty collections encode explicitly. Running with no arguments states `0 explicit artifacts selected` rather than scanning for captures.
6. **Structured errors and exit codes** — preflight usage errors are TOON on stdout with a corrective command. Unknown flags fail before Effect CLI or a dependency runs. The forensic exit-code contract remains `0`, `10`, `20`, `30`, and `40`; this domain requirement intentionally replaces AXI's generic `0/1/2` recommendation.
7. **Ambient context** — the package ships `skills/review-rhinestone-failure/SKILL.md`. It does not install a session hook because ambient discovery would conflict with the security boundary against implicit evidence or browser-storage scans. Any future hook must be explicit opt-in and must not enumerate captures.
8. **Content first** — no arguments produce tool identity, the explicit empty evidence state, and four executable next actions instead of global help.
9. **Contextual disclosure** — command results carry forward bundle paths into relevant next commands. Self-contained output does not prescribe unnecessary workflow steps.
10. **Consistent help** — each subcommand has focused `--help`. `-v`, `-V`, and `--version` use a tiny entrypoint that prints the bare version before loading the 5.8 MB command graph.

## Non-negotiable boundaries

AXI ergonomics do not weaken forensic safety:

- no implicit filesystem or browser-storage discovery;
- no private keys, API keys, bearer tokens, cookies, or mnemonics in results or bundles;
- no transaction signing or submission;
- no incident match presented as proof;
- no replacement of historical storage state during replay.

The deterministic evals in `evals/` enforce this contract as the CLI evolves.
