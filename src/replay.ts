import { spawn } from 'node:child_process'
import { strFromU8 } from 'fflate'
import {
  type Address,
  type Hex,
  isAddress,
  isHex,
  toFunctionSelector,
} from 'viem'
import { type LoadedDiagnosticBundle, readDiagnosticBundle } from './archive.js'
import {
  type CommandOutcome,
  type EvidenceReference,
  emptyDiagnostic,
} from './model.js'

export interface CastRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type CastRunner = (args: readonly string[]) => Promise<CastRunResult>

export interface ReplayDiagnosticBundleInput {
  readonly bundlePath: string
  readonly rpcUrl: string
  readonly fetchFn?: typeof fetch
  readonly runCast?: CastRunner
}

interface ReplayCall {
  readonly target: Address
  readonly data: Hex
  readonly value: bigint
  readonly relayer: Address
  readonly blockNumber: string
  readonly stateOverride: Readonly<Record<string, unknown>>
  readonly source: EvidenceReference
}

interface RpcReply {
  readonly result?: unknown
  readonly error?: {
    readonly code?: number
    readonly message?: string
  }
}

interface DeepestRevert {
  readonly line: string
  readonly selector?: string
  readonly target?: string
  readonly gas?: string
  readonly depth: number
  readonly batchCall?: number
}

function defaultCastRunner(args: readonly string[]): Promise<CastRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('cast', [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    )
  })
}

async function rpc(
  url: string,
  method: string,
  params: readonly unknown[],
  fetchFn: typeof fetch,
): Promise<RpcReply> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) {
    throw new Error(`RPC ${method} returned HTTP ${response.status}`)
  }
  return (await response.json()) as RpcReply
}

function walk(
  value: unknown,
  path = '$',
): readonly { path: string; value: unknown }[] {
  const current = [{ path, value }]
  if (Array.isArray(value)) {
    return [
      ...current,
      ...value.flatMap((entry, index) => walk(entry, `${path}[${index}]`)),
    ]
  }
  if (!value || typeof value !== 'object') return current
  return [
    ...current,
    ...Object.entries(value).flatMap(([key, entry]) =>
      walk(entry, `${path}.${key}`),
    ),
  ]
}

function findChainId(bundle: LoadedDiagnosticBundle): number | undefined {
  if (bundle.manifest.environment.chainId !== undefined) {
    return bundle.manifest.environment.chainId
  }
  for (const artifact of bundle.artifacts) {
    for (const located of walk(artifact.value)) {
      if (!located.path.endsWith('.chainId')) continue
      const value = located.value
      if (typeof value === 'number' && Number.isSafeInteger(value)) return value
      if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
    }
  }
  return undefined
}

function parseReplayCall(
  bundle: LoadedDiagnosticBundle,
): ReplayCall | undefined {
  for (const raw of bundle.manifest.rawSimulations) {
    const bytes = bundle.files[raw.archivePath]
    if (!bytes) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(strFromU8(bytes)) as unknown
    } catch {
      continue
    }
    for (const located of walk(parsed)) {
      if (!located.value || typeof located.value !== 'object') continue
      const record = located.value as Record<string, unknown>
      if (!record.call || typeof record.call !== 'object') continue
      const call = record.call as Record<string, unknown>
      const details =
        record.details && typeof record.details === 'object'
          ? (record.details as Record<string, unknown>)
          : undefined
      if (
        typeof call.to !== 'string' ||
        !isAddress(call.to) ||
        typeof call.data !== 'string' ||
        !isHex(call.data) ||
        typeof details?.relayer !== 'string' ||
        !isAddress(details.relayer) ||
        (typeof details.blockNumber !== 'string' &&
          typeof details.blockNumber !== 'number')
      ) {
        continue
      }
      let value = 0n
      try {
        value = BigInt(
          typeof call.value === 'string' || typeof call.value === 'number'
            ? call.value
            : 0,
        )
      } catch {
        continue
      }
      const stateOverride =
        details.stateOverride && typeof details.stateOverride === 'object'
          ? (details.stateOverride as Readonly<Record<string, unknown>>)
          : {}
      const sourceEntry = bundle.manifest.entries.find(
        (entry) => entry.id === raw.sourceEntryId,
      )
      return {
        target: call.to,
        data: call.data,
        value,
        relayer: details.relayer,
        blockNumber: String(details.blockNumber),
        stateOverride,
        source: {
          source: sourceEntry?.originalPath ?? raw.sourceEntryId,
          path: raw.path,
          ...(sourceEntry ? { sha256: sourceEntry.sha256 } : {}),
        },
      }
    }
  }
  return undefined
}

function overrideArgs(
  overrides: Readonly<Record<string, unknown>>,
): readonly string[] {
  const balances: string[] = []
  const nonces: string[] = []
  const codes: string[] = []
  const stateDiffs: string[] = []
  for (const [address, value] of Object.entries(overrides)) {
    if (!isAddress(address) || !value || typeof value !== 'object') continue
    const account = value as Record<string, unknown>
    if (typeof account.balance === 'string') {
      balances.push(`${address}:${account.balance}`)
    }
    if (
      typeof account.nonce === 'string' ||
      typeof account.nonce === 'number'
    ) {
      nonces.push(`${address}:${String(account.nonce)}`)
    }
    if (typeof account.code === 'string')
      codes.push(`${address}:${account.code}`)
    const storage =
      account.stateDiff && typeof account.stateDiff === 'object'
        ? (account.stateDiff as Record<string, unknown>)
        : account.state && typeof account.state === 'object'
          ? (account.state as Record<string, unknown>)
          : {}
    for (const [slot, slotValue] of Object.entries(storage)) {
      if (typeof slotValue === 'string') {
        stateDiffs.push(`${address}:${slot}:${slotValue}`)
      }
    }
  }
  return [
    ...(balances.length > 0 ? ['--override-balance', balances.join(',')] : []),
    ...(nonces.length > 0 ? ['--override-nonce', nonces.join(',')] : []),
    ...(codes.length > 0 ? ['--override-code', codes.join(',')] : []),
    ...(stateDiffs.length > 0
      ? ['--override-state-diff', stateDiffs.join(',')]
      : []),
  ]
}

function castArgs(call: ReplayCall, rpcUrl: string): readonly string[] {
  return [
    'call',
    call.target,
    call.data,
    '--from',
    call.relayer,
    '--value',
    call.value.toString(),
    '--block',
    call.blockNumber,
    '--rpc-url',
    rpcUrl,
    '--trace',
    ...overrideArgs(call.stateOverride),
  ]
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:$-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function redactedCastCommand(call: ReplayCall): string {
  return ['cast', ...castArgs(call, '$ARCHIVE_RPC').map(shellQuote)].join(' ')
}

function traceDepth(line: string): number {
  return line.match(/^[\s│├└─]*/)?.[0].length ?? 0
}

function parseDeepestRevert(trace: string): DeepestRevert | undefined {
  const lines = trace.split(/\r?\n/)
  const candidates = lines.flatMap((line, index) =>
    /\[Revert\]|revert/i.test(line)
      ? [{ line, index, depth: traceDepth(line) }]
      : [],
  )
  const deepest = candidates.sort((left, right) => right.depth - left.depth)[0]
  if (!deepest) return undefined
  const preceding = lines
    .slice(0, deepest.index)
    .reverse()
    .find((line) => /0x[0-9a-fA-F]{40}/.test(line))
  return {
    line: deepest.line.trim(),
    selector: deepest.line.match(/0x[0-9a-fA-F]{8}/)?.[0],
    target: preceding?.match(/0x[0-9a-fA-F]{40}/)?.[0],
    gas: preceding?.match(/\[([0-9_]+)\]/)?.[1]?.replaceAll('_', ''),
    depth: deepest.depth,
    batchCall: preceding
      ? Number(preceding.match(/call\[(\d+)\]/i)?.[1] ?? Number.NaN)
      : undefined,
  }
}

function buildInfoSelectors(
  bundle: LoadedDiagnosticBundle,
): ReadonlyMap<string, string> {
  const signatures = bundle.artifacts.flatMap((artifact) =>
    walk(artifact.value).flatMap((located) => {
      if (!located.value || typeof located.value !== 'object') return []
      const entry = located.value as Record<string, unknown>
      if (entry.type !== 'error' || typeof entry.name !== 'string') return []
      const inputs = Array.isArray(entry.inputs)
        ? entry.inputs.map((input) =>
            input &&
            typeof input === 'object' &&
            typeof (input as Record<string, unknown>).type === 'string'
              ? String((input as Record<string, unknown>).type)
              : '',
          )
        : []
      return [`${entry.name}(${inputs.join(',')})`]
    }),
  )
  return new Map(
    signatures.map((signature) => [toFunctionSelector(signature), signature]),
  )
}

export async function replayDiagnosticBundle(
  input: ReplayDiagnosticBundleInput,
): Promise<CommandOutcome> {
  const base = emptyDiagnostic('replay')
  try {
    const bundle = await readDiagnosticBundle(input.bundlePath)
    const call = parseReplayCall(bundle)
    const chainId = findChainId(bundle)
    if (!call || chainId === undefined) {
      return {
        exitCode: 30,
        result: {
          ...base,
          findings: [
            {
              id: 'replay.missing-input',
              severity: 'error',
              confidence: 'deterministic',
              message:
                'Replay needs a chain id and a raw simulation with call target, calldata, value, relayer, block, and state overrides.',
              evidence: [{ source: input.bundlePath }],
            },
          ],
        },
      }
    }

    const fetchFn = input.fetchFn ?? fetch
    const chainReply = await rpc(input.rpcUrl, 'eth_chainId', [], fetchFn)
    if (chainReply.error) {
      return {
        exitCode: 40,
        result: {
          ...base,
          findings: [
            {
              id: 'replay.rpc-chain-unavailable',
              severity: 'error',
              confidence: 'deterministic',
              message: chainReply.error.message ?? 'RPC chain lookup failed.',
              evidence: [],
            },
          ],
        },
      }
    }
    const rpcChainId =
      typeof chainReply.result === 'string'
        ? Number(BigInt(chainReply.result))
        : undefined
    if (rpcChainId !== chainId) {
      return {
        exitCode: 40,
        result: {
          ...base,
          environment: { ...bundle.manifest.environment, chainId },
          checks: [
            {
              id: 'replay.rpc-chain',
              group: 'replay',
              status: 'fail',
              message: `RPC chain ${String(rpcChainId)} does not match simulation chain ${chainId}.`,
              expected: chainId,
              actual: rpcChainId,
              evidence: [call.source],
            },
          ],
        },
      }
    }

    const codeReply = await rpc(
      input.rpcUrl,
      'eth_getCode',
      [call.target, `0x${BigInt(call.blockNumber).toString(16)}`],
      fetchFn,
    )
    if (codeReply.error || typeof codeReply.result !== 'string') {
      return {
        exitCode: 40,
        result: {
          ...base,
          environment: {
            ...bundle.manifest.environment,
            chainId,
            blockNumber: call.blockNumber,
          },
          findings: [
            {
              id: 'replay.historical-state-unavailable',
              severity: 'error',
              confidence: 'deterministic',
              message:
                codeReply.error?.message ??
                'The RPC did not return historical state for the simulation block.',
              evidence: [call.source],
            },
          ],
        },
      }
    }

    const args = castArgs(call, input.rpcUrl)
    let run: CastRunResult
    try {
      run = await (input.runCast ?? defaultCastRunner)(args)
    } catch (error) {
      return {
        exitCode: 30,
        result: {
          ...base,
          findings: [
            {
              id: 'replay.cast-unavailable',
              severity: 'error',
              confidence: 'deterministic',
              message: error instanceof Error ? error.message : String(error),
              evidence: [],
            },
          ],
        },
      }
    }
    const trace = [run.stdout, run.stderr].filter(Boolean).join('\n')
    const deepest = parseDeepestRevert(trace)
    const reproduced = Boolean(deepest)
    const selectors = buildInfoSelectors(bundle)
    const decoded = deepest?.selector
      ? selectors.get(deepest.selector)
      : undefined
    const command = redactedCastCommand(call)

    return {
      exitCode: reproduced ? 0 : 10,
      result: {
        ...base,
        environment: {
          ...bundle.manifest.environment,
          chainId,
          blockNumber: call.blockNumber,
        },
        identifiers: {
          ...(bundle.artifacts
            .flatMap((artifact) => walk(artifact.value))
            .find(
              (located) =>
                located.path.endsWith('.traceId') &&
                typeof located.value === 'string',
            )?.value
            ? {
                traceId: String(
                  bundle.artifacts
                    .flatMap((artifact) => walk(artifact.value))
                    .find(
                      (located) =>
                        located.path.endsWith('.traceId') &&
                        typeof located.value === 'string',
                    )?.value,
                ),
              }
            : {}),
        },
        observations: [
          {
            id: 'replay.cast-command',
            message: `Reproduce with: ${command}`,
            evidence: [call.source],
          },
          ...(deepest
            ? [
                {
                  id: 'replay.deepest-revert',
                  message: `Deepest revert${deepest.selector ? ` ${deepest.selector}` : ''}${decoded ? ` (${decoded})` : ''}${deepest.target ? ` at ${deepest.target}` : ''}${deepest.gas ? ` after ${deepest.gas} gas` : ''}.`,
                  evidence: [call.source],
                },
              ]
            : []),
        ],
        checks: [
          {
            id: 'replay.rpc-chain',
            group: 'replay',
            status: 'pass',
            message: `RPC and simulation both use chain ${chainId}.`,
            actual: chainId,
            evidence: [call.source],
          },
          {
            id: 'replay.historical-state',
            group: 'replay',
            status: 'pass',
            message: `RPC returned state at block ${call.blockNumber}.`,
            evidence: [call.source],
          },
          {
            id: 'replay.reproduced',
            group: 'replay',
            status: reproduced ? 'pass' : 'fail',
            message: reproduced
              ? 'The historical call reproduced a revert. The revert is diagnostic data, so the command succeeded.'
              : `cast exited ${run.exitCode} without a recognizable reverting frame.`,
            actual: deepest?.line ?? trace.slice(-2000),
            evidence: [call.source],
          },
        ],
        findings: deepest
          ? [
              {
                id: 'replay.root-frame',
                severity: 'error',
                confidence: 'deterministic',
                message: decoded
                  ? `The deepest reverting frame returned ${decoded}.`
                  : `The deepest reverting frame returned ${deepest.selector ?? deepest.line}. Source-level decoding was unavailable.`,
                evidence: [call.source],
              },
            ]
          : [],
        limitations: [
          ...(deepest?.selector && !decoded
            ? ['No exact deployment build-info decoded the deepest selector.']
            : []),
          ...(deepest?.batchCall === undefined
            ? ['The trace did not label a batch call index.']
            : []),
        ],
        nextCommands: [`ens-rhinestone inspect ${input.bundlePath}`],
      },
    }
  } catch (error) {
    return {
      exitCode: 40,
      result: {
        ...base,
        findings: [
          {
            id: 'replay.failed',
            severity: 'error',
            confidence: 'deterministic',
            message: error instanceof Error ? error.message : String(error),
            evidence: [{ source: input.bundlePath }],
          },
        ],
      },
    }
  }
}
