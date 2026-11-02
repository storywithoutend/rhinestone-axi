# Deterministic evaluations

The deterministic suite exercises forensic behavior against synthetic captures. It makes no model calls.

Run all cases:

```sh
npm run eval
```

Run one case with complete evidence:

```sh
npm run eval -- --case refund-cap-overflow --full
```

Fixtures are synthetic and contain no live credentials. The `credential-log` case checks that bundling rejects credential-shaped input.
