import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { strToU8, zipSync } from 'fflate'
import { sha256 } from './hash.js'
import {
  type ArtifactKind,
  type BundleEntry,
  type BundleProfile,
  type CommandOutcome,
  type DiagnosticBundleManifest,
  type DiagnosticResult,
  emptyDiagnostic,
} from './model.js'
import { sanitizeArtifact } from './sanitize.js'

const execFileAsync = promisify(execFile)
const MAX_INPUT_BYTES = 32 * 1024 * 1024

export interface CreateDiagnosticBundleInput {
  readonly inputs: readonly string[]
  readonly output: string
  readonly profile: BundleProfile
  readonly cwd: string
  readonly now?: Date
}

interface PreparedEntry {
  readonly manifest: BundleEntry
  readonly bytes: Uint8Array
  readonly functionPaths: readonly string[]
  readonly redactions: DiagnosticBundleManifest['redactions']
  readonly unsafeMatches: ReturnType<typeof sanitizeArtifact>['unsafeMatches']
  readonly rawSimulations: readonly {
    readonly path: string
    readonly bytes: Uint8Array
  }[]
}

interface CollectedSimulation {
  readonly path: string
  readonly value: unknown
}

function simulationSummary(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const call =
    record.call && typeof record.call === 'object'
      ? (record.call as Record<string, unknown>)
      : undefined
  const details =
    record.details && typeof record.details === 'object'
      ? (record.details as Record<string, unknown>)
      : undefined
  const data = typeof call?.data === 'string' ? call.data : undefined
  return {
    ...(typeof call?.to === 'string' ? { to: call.to } : {}),
    ...(data
      ? {
          selector: data.slice(0, 10),
          calldataBytes: Math.max(0, (data.length - 2) / 2),
        }
      : {}),
    ...(call?.value !== undefined ? { value: call.value } : {}),
    ...(typeof details?.relayer === 'string'
      ? { relayer: details.relayer }
      : {}),
    ...(details?.blockNumber !== undefined
      ? { blockNumber: details.blockNumber }
      : {}),
    ...(record.errorSelector !== undefined
      ? { errorSelector: record.errorSelector }
      : {}),
    ...(record.category !== undefined ? { category: record.category } : {}),
  }
}

function collectAndSummarizeSimulations(
  value: unknown,
  path = '$',
): {
  readonly value: unknown
  readonly simulations: readonly CollectedSimulation[]
} {
  if (Array.isArray(value)) {
    const children = value.map((entry, index) =>
      collectAndSummarizeSimulations(entry, `${path}[${index}]`),
    )
    return {
      value: children.map((child) => child.value),
      simulations: children.flatMap((child) => child.simulations),
    }
  }
  if (!value || typeof value !== 'object') {
    return { value, simulations: [] }
  }
  const entries = Object.entries(value).map(([key, entry]) => {
    const entryPath = `${path}.${key}`
    if (key === 'simulations' && Array.isArray(entry)) {
      return {
        key,
        value: entry.map(simulationSummary),
        simulations: entry.map((simulation, index) => ({
          path: `${entryPath}[${index}]`,
          value: simulation,
        })),
      }
    }
    const child = collectAndSummarizeSimulations(entry, entryPath)
    return { key, value: child.value, simulations: child.simulations }
  })
  return {
    value: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
    simulations: entries.flatMap((entry) => entry.simulations),
  }
}

function classifyArtifact(value: unknown, path: string): ArtifactKind {
  if (!value || typeof value !== 'object') return 'json'
  const record = value as Record<string, unknown>
  if (record.schemaVersion === 'tm-failed-run-v2') return 'telemetry'
  if (record.schemaVersion === 'ens-rhinestone-status-v1') {
    return 'status-response'
  }
  if (record.type === 'rhinestone-intent' || 'rhinestoneParams' in record) {
    return 'request'
  }
  if ('intentRoute' in record) return 'prepared-route'
  if ('signedTransaction' in record || record.kind === 'signed-transaction') {
    return 'signed-transaction'
  }
  if (
    'submittedTransaction' in record ||
    record.kind === 'submitted-transaction'
  ) {
    return 'submitted-transaction'
  }
  if (
    'orchestrator' in record ||
    'simulations' in record ||
    'traceId' in record
  ) {
    return 'orchestrator-error'
  }
  if (record._tag === 'TransactionSubmissionError') {
    return 'transaction-submission-error'
  }
  if (
    'permissionId' in record &&
    ('authorization' in record || 'enableData' in record)
  ) {
    return 'session'
  }
  if ('transactionHash' in record || 'fill' in record || 'receipt' in record) {
    return 'fill-receipt'
  }
  if ('buildInfoId' in record || ('input' in record && 'output' in record)) {
    return 'build-info'
  }
  if (record.kind === 'sdk-input') return 'sdk-input'
  const name = basename(path).toLowerCase()
  if (name.includes('sdk-input')) return 'sdk-input'
  if (name.includes('route') || name.includes('prepared'))
    return 'prepared-route'
  if (name.includes('signed')) return 'signed-transaction'
  if (name.includes('submitted')) return 'submitted-transaction'
  if (name.includes('session')) return 'session'
  if (name.includes('status')) return 'status-response'
  if (name.includes('receipt') || name.includes('fill')) return 'fill-receipt'
  if (name.includes('build-info')) return 'build-info'
  if (name.includes('telemetry')) return 'telemetry'
  if (name.includes('simulation') || name.includes('orchestrator')) {
    return 'orchestrator-error'
  }
  if (name.includes('request') || name.includes('input')) return 'request'
  return 'json'
}

function safeArchiveName(index: number, path: string, suffix: string): string {
  const normalized = basename(path)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${String(index + 1).padStart(3, '0')}-${normalized || 'artifact'}${suffix}`
}

async function prepareEntry(
  path: string,
  index: number,
  profile: BundleProfile,
): Promise<PreparedEntry> {
  const absolute = resolve(path)
  const metadata = await stat(absolute)
  if (!metadata.isFile()) throw new Error(`${absolute} is not a file`)
  if (metadata.size > MAX_INPUT_BYTES) {
    throw new Error(
      `${absolute} is ${metadata.size} bytes, above the ${MAX_INPUT_BYTES}-byte input limit`,
    )
  }
  const raw = new Uint8Array(await readFile(absolute))
  const digest = sha256(raw)
  const isJson = extname(absolute).toLowerCase() === '.json'
  if (!isJson) {
    const archivePath = `attachments/${safeArchiveName(index, absolute, '.txt')}`
    const sanitized = sanitizeArtifact(
      Buffer.from(raw).toString('utf8'),
      profile,
    )
    const content =
      typeof sanitized.value === 'string'
        ? sanitized.value
        : JSON.stringify(sanitized.value, null, 2)
    return {
      manifest: {
        id: `artifact-${index + 1}`,
        originalPath: absolute,
        archivePath,
        kind: 'log',
        sha256: digest,
        byteCount: raw.byteLength,
        truncated: sanitized.redactions.some(
          (redaction) => redaction.reason === 'long-string',
        ),
      },
      bytes: strToU8(`${content}\n`),
      functionPaths: sanitized.functionPaths.map(
        (pathValue) => `${absolute}:${pathValue}`,
      ),
      redactions: sanitized.redactions.map((redaction) => ({
        ...redaction,
        path: `${absolute}:${redaction.path}`,
      })),
      unsafeMatches: sanitized.unsafeMatches.map((match) => ({
        ...match,
        path: `${absolute}:${match.path}`,
      })),
      rawSimulations: [],
    }
  }

  const parsed: unknown = JSON.parse(Buffer.from(raw).toString('utf8'))
  const collected = collectAndSummarizeSimulations(parsed)
  const sanitized = sanitizeArtifact(collected.value, profile)
  const archivePath = `artifacts/${safeArchiveName(index, absolute, '')}`
  return {
    manifest: {
      id: `artifact-${index + 1}`,
      originalPath: absolute,
      archivePath,
      kind: classifyArtifact(parsed, absolute),
      sha256: digest,
      byteCount: raw.byteLength,
      truncated: sanitized.redactions.some(
        (redaction) => redaction.reason === 'long-string',
      ),
    },
    bytes: strToU8(`${JSON.stringify(sanitized.value, null, 2)}\n`),
    functionPaths: [
      ...sanitized.functionPaths.map((pathValue) => `${absolute}:${pathValue}`),
      ...collected.simulations.flatMap((simulation) => {
        const raw = sanitizeArtifact({ simulation: simulation.value }, profile)
        return raw.functionPaths.map(
          (pathValue) =>
            `${absolute}:${simulation.path}${pathValue.slice('$.simulation'.length)}`,
        )
      }),
    ],
    redactions: [
      ...sanitized.redactions.map((redaction) => ({
        ...redaction,
        path: `${absolute}:${redaction.path}`,
      })),
      ...collected.simulations.flatMap((simulation) => {
        const raw = sanitizeArtifact({ simulation: simulation.value }, profile)
        return raw.redactions.map((redaction) => ({
          ...redaction,
          path: `${absolute}:${simulation.path}${redaction.path.slice('$.simulation'.length)}`,
        }))
      }),
    ],
    unsafeMatches: [
      ...sanitized.unsafeMatches.map((match) => ({
        ...match,
        path: `${absolute}:${match.path}`,
      })),
      ...collected.simulations.flatMap((simulation) => {
        const raw = sanitizeArtifact({ simulation: simulation.value }, profile)
        return raw.unsafeMatches.map((match) => ({
          ...match,
          path: `${absolute}:${simulation.path}${match.path.slice('$.simulation'.length)}`,
        }))
      }),
    ],
    rawSimulations: collected.simulations.map((simulation) => {
      const raw = sanitizeArtifact({ simulation: simulation.value }, profile)
      const value =
        raw.value && typeof raw.value === 'object' && 'simulation' in raw.value
          ? (raw.value as { simulation: unknown }).simulation
          : raw.value
      return {
        path: simulation.path,
        bytes: strToU8(`${JSON.stringify(value, null, 2)}\n`),
      }
    }),
  }
}

async function optionalCommand(
  cwd: string,
  command: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd })
    const value = stdout.trim()
    return value || undefined
  } catch {
    return undefined
  }
}

async function bundleEnvironment(
  cwd: string,
): Promise<DiagnosticResult['environment']> {
  const repoRevision = await optionalCommand(cwd, 'git', ['rev-parse', 'HEAD'])
  let patchSha256: string | undefined
  try {
    const patch = await readFile(
      join(cwd, 'patches', '@rhinestone__sdk@1.22.0.patch'),
    )
    patchSha256 = sha256(new Uint8Array(patch))
  } catch {
    patchSha256 = undefined
  }
  let sdkVersion: string | undefined
  try {
    const sdkPackage = JSON.parse(
      await readFile(
        join(cwd, 'node_modules', '@rhinestone', 'sdk', 'package.json'),
        'utf8',
      ),
    ) as { version?: unknown }
    sdkVersion =
      typeof sdkPackage.version === 'string' ? sdkPackage.version : undefined
  } catch {
    sdkVersion = undefined
  }
  return {
    ...(repoRevision ? { repoRevision } : {}),
    ...(sdkVersion ? { sdkVersion } : {}),
    ...(patchSha256 ? { patchSha256 } : {}),
  }
}

function renderReport(params: {
  readonly output: string
  readonly entries: readonly BundleEntry[]
  readonly functionPaths: readonly string[]
  readonly redactions: DiagnosticBundleManifest['redactions']
}): string {
  const observations = params.entries.map(
    (entry) =>
      `- Captured ${entry.kind} from \`${entry.originalPath}\` as \`${entry.archivePath}\` (${entry.byteCount} bytes, SHA-256 \`${entry.sha256}\`).`,
  )
  const missing = [
    ...(params.functionPaths.length > 0
      ? [
          `- ${params.functionPaths.length} function value(s) were removed. Their paths are in \`manifest.json\`.`,
        ]
      : []),
    ...(params.redactions.length > 0
      ? [
          `- ${params.redactions.length} sensitive or oversized value(s) were replaced by hashes.`,
        ]
      : []),
  ]
  return [
    '## Direct observations',
    '',
    ...(observations.length > 0
      ? observations
      : ['- No artifacts were captured.']),
    '',
    '## Failed deterministic checks',
    '',
    '- None. Run `inspect` to evaluate cross-artifact invariants.',
    '',
    '## Inferences',
    '',
    '- None. This command only collected and normalized evidence.',
    '',
    '## Missing evidence',
    '',
    ...(missing.length > 0
      ? missing
      : ['- No collection-time gaps were detected.']),
    '',
    '## Exact next commands',
    '',
    `- \`ens-rhinestone inspect ${params.output}\``,
    `- \`ens-rhinestone replay --rpc-url "$ARCHIVE_RPC" ${params.output}\``,
    `- \`ens-rhinestone status --intent-id <id> --bundle ${params.output}\``,
    '',
  ].join('\n')
}

async function writeAtomic0600(path: string, bytes: Uint8Array): Promise<void> {
  const absolute = resolve(path)
  await mkdir(dirname(absolute), { recursive: true })
  const temporary = join(
    dirname(absolute),
    `.${basename(absolute)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(temporary, 0o600)
    await rename(temporary, absolute)
    await chmod(absolute, 0o600)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function createDiagnosticBundle(
  input: CreateDiagnosticBundleInput,
): Promise<CommandOutcome> {
  const base = emptyDiagnostic('bundle')
  if (input.inputs.length === 0) {
    return {
      exitCode: 20,
      result: {
        ...base,
        findings: [
          {
            id: 'bundle.no-inputs',
            severity: 'error',
            confidence: 'deterministic',
            message: 'At least one artifact path is required.',
            evidence: [],
          },
        ],
      },
    }
  }

  try {
    const entries = await Promise.all(
      input.inputs.map((path, index) =>
        prepareEntry(path, index, input.profile),
      ),
    )
    const unsafeMatches = entries.flatMap((entry) => entry.unsafeMatches)
    if (unsafeMatches.length > 0) {
      return {
        exitCode: 20,
        result: {
          ...base,
          findings: unsafeMatches.map((match, index) => ({
            id: `bundle.unsafe-${index + 1}`,
            severity: 'error' as const,
            confidence: 'deterministic' as const,
            message: `Rejected unsafe credential (${match.reason}) at ${match.path}.`,
            evidence: [{ source: match.path }],
          })),
          limitations: ['No bundle was written. Remove credentials and retry.'],
        },
      }
    }

    const environment = await bundleEnvironment(input.cwd)
    const functionPaths = entries.flatMap((entry) => entry.functionPaths)
    const redactions = entries.flatMap((entry) => entry.redactions)
    const limitations = [
      ...(functionPaths.length > 0
        ? ['Function values were removed. See manifest.json for their paths.']
        : []),
      ...(redactions.length > 0
        ? ['Redacted values can be compared by hash but cannot be decoded.']
        : []),
    ]
    const rawSimulations = entries.flatMap((entry) =>
      entry.rawSimulations.map((simulation, index) => ({
        sourceEntryId: entry.manifest.id,
        path: simulation.path,
        archivePath: `raw-simulations/${entry.manifest.id}-${index + 1}.json`,
        bytes: simulation.bytes,
      })),
    )
    const manifest: DiagnosticBundleManifest = {
      schemaVersion: 'ens-rhinestone-bundle-v1',
      createdAt: (input.now ?? new Date()).toISOString(),
      profile: input.profile,
      environment,
      entries: entries.map((entry) => entry.manifest),
      functionPaths,
      redactions,
      rawSimulations: rawSimulations.map(
        ({ bytes: _bytes, ...simulation }) => simulation,
      ),
      limitations,
    }
    const report = renderReport({
      output: input.output,
      entries: manifest.entries,
      functionPaths,
      redactions,
    })
    const archive = Object.fromEntries([
      ['manifest.json', strToU8(`${JSON.stringify(manifest, null, 2)}\n`)],
      ['report.md', strToU8(report)],
      ...entries.map(
        (entry) => [entry.manifest.archivePath, entry.bytes] as const,
      ),
      ...rawSimulations.map(
        (simulation) => [simulation.archivePath, simulation.bytes] as const,
      ),
    ])
    await writeAtomic0600(input.output, zipSync(archive, { level: 6 }))

    return {
      exitCode: 0,
      result: {
        ...base,
        environment,
        observations: [
          {
            id: 'bundle.written',
            message: `Wrote ${entries.length} artifact(s) to ${resolve(input.output)}.`,
            evidence: [{ source: resolve(input.output) }],
          },
        ],
        checks: [
          {
            id: 'bundle.credentials',
            group: 'bundle',
            status: 'pass',
            message:
              'No private keys, API keys, bearer tokens, cookies, or mnemonics remained.',
            evidence: entries.map((entry) => ({
              source: entry.manifest.originalPath,
              sha256: entry.manifest.sha256,
            })),
          },
        ],
        limitations,
        nextCommands: [
          `ens-rhinestone inspect ${resolve(input.output)}`,
          `ens-rhinestone replay --rpc-url "$ARCHIVE_RPC_URL" ${resolve(input.output)}`,
        ],
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      exitCode:
        message.includes('is not a file') ||
        message.includes('input limit') ||
        message.includes('ENOENT') ||
        message.includes('no such file')
          ? 20
          : 40,
      result: {
        ...base,
        findings: [
          {
            id: 'bundle.failed',
            severity: 'error',
            confidence: 'deterministic',
            message,
            evidence: [],
          },
        ],
      },
    }
  }
}
