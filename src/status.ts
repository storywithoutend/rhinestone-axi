import { type LoadedDiagnosticBundle, readDiagnosticBundle } from './archive.js'
import { sha256 } from './hash.js'
import {
  type CheckResult,
  type CommandOutcome,
  emptyDiagnostic,
} from './model.js'

const KNOWN_STATUSES = new Set([
  'PENDING',
  'PRECONFIRMED',
  'FILLED',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
  'NOT_FOUND',
])

type DiagnosticIntentStatus =
  | 'PENDING'
  | 'PRECONFIRMED'
  | 'FILLED'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED'
  | 'NOT_FOUND'
  | 'UNKNOWN'

export interface CorrelateIntentStatusInput {
  readonly intentId: string
  readonly bundlePath?: string
  readonly endpointUrl?: string
  readonly rpcUrl?: string
  readonly apiKey?: string
  readonly accessToken?: string
  readonly fetchFn?: typeof fetch
  readonly now?: Date
}

interface RpcReply {
  readonly result?: unknown
  readonly error?: { readonly message?: string }
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

function localEvidence(bundle: LoadedDiagnosticBundle | undefined): {
  readonly hasFailure: boolean
  readonly fillHash?: string
  readonly runId?: string
  readonly txId?: string
  readonly evidence: readonly {
    readonly source: string
    readonly path?: string
    readonly sha256?: string
  }[]
} {
  if (!bundle) return { hasFailure: false, evidence: [] }
  const located = bundle.artifacts.flatMap((artifact) =>
    walk(artifact.value).map((entry) => ({ artifact, ...entry })),
  )
  const failures = located.filter(
    (entry) =>
      typeof entry.value === 'string' &&
      /failed|error|revert|TransactionSubmissionError/i.test(entry.value),
  )
  const firstField = (names: readonly string[]) =>
    located.find(
      (entry) =>
        names.some((name) => entry.path.endsWith(`.${name}`)) &&
        (typeof entry.value === 'string' || typeof entry.value === 'number'),
    )
  const fill = firstField(['fillTransactionHash', 'fillHash'])
  const run = firstField(['runId'])
  const tx = firstField(['txId'])
  return {
    hasFailure: failures.length > 0,
    ...(fill ? { fillHash: String(fill.value) } : {}),
    ...(run ? { runId: String(run.value) } : {}),
    ...(tx ? { txId: String(tx.value) } : {}),
    evidence: failures.slice(0, 5).map((entry) => ({
      source: entry.artifact.entry.originalPath,
      path: entry.path,
      sha256: entry.artifact.entry.sha256,
    })),
  }
}

function statusFromResponse(
  httpStatus: number,
  parsed: unknown,
): DiagnosticIntentStatus {
  if (httpStatus === 404) return 'NOT_FOUND'
  if (!parsed || typeof parsed !== 'object') return 'UNKNOWN'
  const status = (parsed as Record<string, unknown>).status
  return typeof status === 'string' && KNOWN_STATUSES.has(status)
    ? (status as DiagnosticIntentStatus)
    : 'UNKNOWN'
}

function fillHashFromResponse(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined
  for (const entry of walk(parsed)) {
    if (
      (entry.path.endsWith('.fillTransactionHash') ||
        entry.path.endsWith('.fillHash') ||
        entry.path.endsWith('.fill.hash')) &&
      typeof entry.value === 'string'
    ) {
      return entry.value
    }
  }
  return undefined
}

async function verifyReceipt(
  rpcUrl: string,
  hash: string,
  fetchFn: typeof fetch,
): Promise<RpcReply> {
  const response = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionReceipt',
      params: [hash],
    }),
  })
  if (!response.ok) {
    return {
      error: { message: `Receipt RPC returned HTTP ${response.status}` },
    }
  }
  return (await response.json()) as RpcReply
}

function correlationChecks(params: {
  readonly status: DiagnosticIntentStatus
  readonly local: ReturnType<typeof localEvidence>
  readonly orchestratorFillHash?: string
  readonly receipt?: RpcReply
}): readonly CheckResult[] {
  const completed = params.status === 'FILLED' || params.status === 'COMPLETED'
  const dead = params.status === 'FAILED' || params.status === 'EXPIRED'
  const checks: CheckResult[] = []
  if (completed && params.local.hasFailure) {
    checks.push({
      id: 'status.orchestrator-vs-local',
      group: 'status',
      status: 'fail',
      message: `${params.status} orchestrator state is paired with a retained local failure.`,
      expected: 'local success or cleared error',
      actual: 'local failure retained',
      evidence: params.local.evidence,
    })
  } else {
    checks.push({
      id: 'status.orchestrator-vs-local',
      group: 'status',
      status: params.status === 'UNKNOWN' ? 'skip' : 'pass',
      message:
        params.status === 'UNKNOWN'
          ? 'The orchestrator returned an unknown status, so local correlation is inconclusive.'
          : 'No orchestrator and local-state contradiction was found.',
      actual: params.status,
      evidence: params.local.evidence,
    })
  }
  const anyFillHash = params.orchestratorFillHash ?? params.local.fillHash
  if (dead && anyFillHash) {
    checks.push({
      id: 'status.dead-with-fill',
      group: 'status',
      status: 'fail',
      message: `${params.status} orchestrator state is paired with fill hash ${anyFillHash}.`,
      expected: 'no fill hash for a dead intent',
      actual: anyFillHash,
      evidence: params.local.evidence,
    })
  }
  if (params.receipt) {
    const receiptExists = Boolean(params.receipt.result)
    checks.push({
      id: 'status.fill-receipt',
      group: 'status',
      status:
        params.receipt.error ||
        (completed && !receiptExists) ||
        (dead && receiptExists)
          ? 'fail'
          : 'pass',
      message: params.receipt.error
        ? (params.receipt.error.message ?? 'Receipt lookup failed.')
        : receiptExists
          ? 'The fill transaction receipt exists on chain.'
          : 'No fill transaction receipt was returned.',
      expected: completed
        ? 'receipt present'
        : dead
          ? 'receipt absent'
          : undefined,
      actual: receiptExists,
      evidence: params.local.evidence,
    })
  }
  return checks
}

export async function correlateIntentStatus(
  input: CorrelateIntentStatusInput,
): Promise<CommandOutcome> {
  const base = emptyDiagnostic('status')
  const endpoint = (
    input.endpointUrl ?? 'https://v1.orchestrator.rhinestone.dev'
  ).replace(/\/$/, '')
  const url = `${endpoint}/intent-operation/${encodeURIComponent(input.intentId)}`
  const headers: Record<string, string> = {}
  if (input.accessToken) {
    headers.Authorization = `Bearer ${input.accessToken}`
    headers['x-api-key'] = 'jwt'
  } else if (input.apiKey) {
    headers['x-api-key'] = input.apiKey
  }

  try {
    const fetchFn = input.fetchFn ?? fetch
    const response = await fetchFn(url, { method: 'GET', headers })
    const rawBody = await response.text()
    if (!response.ok && response.status !== 404) {
      return {
        exitCode: 30,
        result: {
          ...base,
          identifiers: { intentId: input.intentId },
          findings: [
            {
              id: 'status.http-failure',
              severity: 'error',
              confidence: 'deterministic',
              message: `Orchestrator returned HTTP ${response.status}.`,
              evidence: [{ source: url, sha256: sha256(rawBody) }],
            },
          ],
          observations: [
            {
              id: 'status.raw-response',
              message: `Captured the raw HTTP ${response.status} response at ${(input.now ?? new Date()).toISOString()}.`,
              data: { rawBody, rawBodySha256: sha256(rawBody), endpoint: url },
              evidence: [{ source: url, sha256: sha256(rawBody) }],
            },
          ],
        },
      }
    }

    let parsed: unknown
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as unknown) : null
    } catch {
      parsed = null
    }
    const status = statusFromResponse(response.status, parsed)
    const bundle = input.bundlePath
      ? await readDiagnosticBundle(input.bundlePath)
      : undefined
    const local = localEvidence(bundle)
    const orchestratorFillHash = fillHashFromResponse(parsed)
    const fillHash = orchestratorFillHash ?? local.fillHash
    const receipt =
      input.rpcUrl && fillHash
        ? await verifyReceipt(input.rpcUrl, fillHash, fetchFn)
        : undefined
    const checks = correlationChecks({
      status,
      local,
      ...(orchestratorFillHash ? { orchestratorFillHash } : {}),
      ...(receipt ? { receipt } : {}),
    })
    const failed = checks.some((check) => check.status === 'fail')
    return {
      exitCode: failed ? 10 : 0,
      result: {
        ...base,
        environment: bundle?.manifest.environment ?? {},
        identifiers: {
          intentId: input.intentId,
          ...(fillHash ? { fillTransactionHash: fillHash } : {}),
          ...(local.runId ? { runId: local.runId } : {}),
          ...(local.txId ? { txId: local.txId } : {}),
        },
        observations: [
          {
            id: 'status.raw-response',
            message: `Captured HTTP ${response.status} from ${url} at ${(input.now ?? new Date()).toISOString()}.`,
            data: {
              httpStatus: response.status,
              endpoint: url,
              observedAt: (input.now ?? new Date()).toISOString(),
              rawBody,
              rawBodySha256: sha256(rawBody),
              status,
            },
            evidence: [{ source: url, sha256: sha256(rawBody) }],
          },
        ],
        checks,
        findings: failed
          ? [
              {
                id: 'status.contradiction',
                severity: 'error',
                confidence: 'deterministic',
                message:
                  'Orchestrator, chain, or local lifecycle evidence contradicts another captured source.',
                evidence: checks.flatMap((check) => check.evidence),
              },
            ]
          : [],
        limitations: [
          ...(status === 'UNKNOWN'
            ? ['The raw orchestrator status was preserved as UNKNOWN.']
            : []),
          ...(!input.rpcUrl || !fillHash
            ? ['No on-chain fill receipt verification was performed.']
            : []),
          ...(!input.apiKey && !input.accessToken
            ? ['The status request was sent without authentication.']
            : []),
        ],
        nextCommands: input.bundlePath
          ? [`ens-rhinestone inspect ${input.bundlePath}`]
          : [],
      },
    }
  } catch (error) {
    return {
      exitCode:
        error instanceof Error && /Bundle|manifest|JSON/.test(error.message)
          ? 20
          : 30,
      result: {
        ...base,
        identifiers: { intentId: input.intentId },
        findings: [
          {
            id: 'status.unavailable',
            severity: 'error',
            confidence: 'deterministic',
            message: error instanceof Error ? error.message : String(error),
            evidence: [{ source: url }],
          },
        ],
      },
    }
  }
}
