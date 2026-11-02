import { homedir } from 'node:os'
import { Effect, Option } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import { createDiagnosticBundle } from './bundle.js'
import { inspectDiagnosticBundle } from './inspect.js'
import type { CommandOutcome } from './model.js'
import { renderAgentResult, renderHome } from './render.js'
import { replayDiagnosticBundle } from './replay.js'
import { correlateIntentStatus } from './status.js'

function invocationWithoutOutputFlags(): string {
  return process.argv
    .slice(1)
    .filter((argument) => argument !== '--json' && argument !== '--full')
    .join(' ')
}

function printOutcome(
  outcome: CommandOutcome,
  options: { readonly json: boolean; readonly full: boolean },
): void {
  process.stdout.write(
    options.json
      ? `${JSON.stringify(
          outcome.result,
          (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
          2,
        )}\n`
      : renderAgentResult(outcome.result, {
          full: options.full,
          invocation: invocationWithoutOutputFlags(),
        }),
  )
  process.exitCode = outcome.exitCode
}

function runOutcome(
  options: { readonly json: boolean; readonly full: boolean },
  thunk: () => Promise<CommandOutcome>,
) {
  return Effect.promise(thunk).pipe(
    Effect.flatMap((outcome) =>
      Effect.sync(() => printOutcome(outcome, options)),
    ),
  )
}

const outputFlags = {
  json: Flag.Boolean('json').pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      'Print the full ens-rhinestone-result-v1 JSON envelope',
    ),
  ),
  full: Flag.Boolean('full').pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      'Print complete TOON output without item or text truncation',
    ),
  ),
} as const

const bundleCommand = Command.make(
  'bundle',
  {
    output: Flag.Path('out').pipe(
      Flag.withDescription('Path of the diagnostic zip to write'),
    ),
    profile: Flag.Literals('profile', ['safe', 'local-replay']).pipe(
      Flag.withDefault('safe'),
      Flag.withDescription('Redaction profile for signatures and replay data'),
    ),
    ...outputFlags,
    artifacts: Argument.String('artifacts').pipe(
      Argument.atLeast(1),
      Argument.withDescription('Captured JSON artifacts or plain log files'),
    ),
  },
  ({ artifacts, full, json, output, profile }) =>
    runOutcome({ json, full }, () =>
      createDiagnosticBundle({
        inputs: artifacts,
        output,
        profile,
        cwd: process.cwd(),
      }),
    ),
).pipe(
  Command.withDescription(
    'Collect captured Rhinestone evidence into one redacted, versioned bundle.\n\nExamples:\n  ens-rhinestone bundle --out failure.zip request.json route.json\n  ens-rhinestone bundle --profile local-replay --out failure.zip error.json',
  ),
)

const inspectCommand = Command.make(
  'inspect',
  {
    ...outputFlags,
    bundle: Argument.String('bundle'),
  },
  ({ bundle, full, json }) =>
    runOutcome({ json, full }, () => inspectDiagnosticBundle(bundle)),
).pipe(
  Command.withDescription(
    'Decode and compare request, route, session, funding, and lifecycle artifacts offline.\n\nExamples:\n  ens-rhinestone inspect failure.zip\n  ens-rhinestone inspect --full failure.zip\n  ens-rhinestone inspect --json failure.zip',
  ),
)

const replayCommand = Command.make(
  'replay',
  {
    ...outputFlags,
    rpcUrl: Flag.String('rpc-url').pipe(
      Flag.withDescription(
        'Archive RPC URL used for historical state and cast replay',
      ),
    ),
    bundle: Argument.String('bundle'),
  },
  ({ bundle, full, json, rpcUrl }) =>
    runOutcome({ json, full }, () =>
      replayDiagnosticBundle({ bundlePath: bundle, rpcUrl }),
    ),
).pipe(
  Command.withDescription(
    'Replay the exact historical simulation with Foundry and report the deepest revert.\n\nExamples:\n  ens-rhinestone replay --rpc-url "$ARCHIVE_RPC_URL" failure.zip\n  ens-rhinestone replay --full --rpc-url "$ARCHIVE_RPC_URL" failure.zip',
  ),
)

const statusCommand = Command.make(
  'status',
  {
    ...outputFlags,
    intentId: Flag.String('intent-id').pipe(
      Flag.withDescription('Orchestrator intent operation id'),
    ),
    bundle: Flag.String('bundle').pipe(Flag.optional),
    endpointUrl: Flag.String('endpoint-url').pipe(Flag.optional),
    rpcUrl: Flag.String('rpc-url').pipe(Flag.optional),
  },
  ({ bundle, endpointUrl, full, intentId, json, rpcUrl }) => {
    const bundlePath = Option.getOrUndefined(bundle)
    const endpoint = Option.getOrUndefined(endpointUrl)
    const rpc = Option.getOrUndefined(rpcUrl)
    return runOutcome({ json, full }, () =>
      correlateIntentStatus({
        intentId,
        ...(bundlePath ? { bundlePath } : {}),
        ...(endpoint ? { endpointUrl: endpoint } : {}),
        ...(rpc ? { rpcUrl: rpc } : {}),
        ...(process.env.RHINESTONE_ACCESS_TOKEN
          ? { accessToken: process.env.RHINESTONE_ACCESS_TOKEN }
          : process.env.RHINESTONE_API_KEY
            ? { apiKey: process.env.RHINESTONE_API_KEY }
            : {}),
      }),
    )
  },
).pipe(
  Command.withDescription(
    'Fetch raw orchestrator status and compare it with local and on-chain evidence.\n\nExamples:\n  ens-rhinestone status --intent-id 123\n  ens-rhinestone status --intent-id 123 --bundle failure.zip --rpc-url "$RPC_URL"',
  ),
)

function displayedBinaryPath(): string {
  const path = process.argv[1] ?? 'ens-rhinestone'
  const home = homedir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

export const cli = Command.make('ens-rhinestone', {}, () =>
  Effect.sync(() => {
    process.stdout.write(renderHome(displayedBinaryPath()))
  }),
).pipe(
  Command.withDescription(
    'Turn captured Rhinestone intent failures into reproducible engineering evidence',
  ),
  Command.withSubcommands([
    bundleCommand,
    inspectCommand,
    replayCommand,
    statusCommand,
  ]),
)
