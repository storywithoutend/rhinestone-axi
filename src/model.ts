export const DIAGNOSTIC_SCHEMA_VERSION = 'ens-rhinestone-result-v1' as const

export type DiagnosticCommand = 'bundle' | 'inspect' | 'replay' | 'status'
export type CheckGroup =
  | 'bundle'
  | 'chain-deployment'
  | 'call-policy'
  | 'session'
  | 'funding'
  | 'lifecycle'
  | 'replay'
  | 'status'

export interface EvidenceReference {
  readonly source: string
  readonly path?: string
  readonly sha256?: string
}

export interface Observation {
  readonly id: string
  readonly message: string
  readonly data?: unknown
  readonly evidence: readonly EvidenceReference[]
}

export interface CheckResult {
  readonly id: string
  readonly group: CheckGroup
  readonly status: 'pass' | 'fail' | 'skip'
  readonly message: string
  readonly expected?: unknown
  readonly actual?: unknown
  readonly evidence: readonly EvidenceReference[]
}

export interface Finding {
  readonly id: string
  readonly severity: 'info' | 'warning' | 'error'
  readonly confidence: 'deterministic' | 'inference' | 'incident-match'
  readonly message: string
  readonly evidence: readonly EvidenceReference[]
}

export interface DiagnosticResult {
  readonly schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION
  readonly command: DiagnosticCommand
  readonly environment: {
    readonly repoRevision?: string
    readonly sdkVersion?: string
    readonly patchSha256?: string
    readonly chainId?: number
    readonly blockNumber?: string
    readonly validator?: string
    readonly deploymentRevision?: string
    readonly buildInfoId?: string
  }
  readonly identifiers: {
    readonly traceId?: string
    readonly intentId?: string
    readonly fillTransactionHash?: string
    readonly runId?: string
    readonly txId?: string
  }
  readonly observations: readonly Observation[]
  readonly checks: readonly CheckResult[]
  readonly findings: readonly Finding[]
  readonly limitations: readonly string[]
  readonly nextCommands: readonly string[]
}

export interface CommandOutcome {
  readonly result: DiagnosticResult
  readonly exitCode: 0 | 10 | 20 | 30 | 40
}

export type BundleProfile = 'safe' | 'local-replay'
export type ArtifactKind =
  | 'request'
  | 'sdk-input'
  | 'prepared-route'
  | 'signed-transaction'
  | 'submitted-transaction'
  | 'orchestrator-error'
  | 'transaction-submission-error'
  | 'telemetry'
  | 'session'
  | 'fill-receipt'
  | 'status-response'
  | 'build-info'
  | 'json'
  | 'log'

export interface BundleEntry {
  readonly id: string
  readonly originalPath: string
  readonly archivePath: string
  readonly kind: ArtifactKind
  readonly sha256: string
  readonly byteCount: number
  readonly truncated: boolean
}

export interface DiagnosticBundleManifest {
  readonly schemaVersion: 'ens-rhinestone-bundle-v1'
  readonly createdAt: string
  readonly profile: BundleProfile
  readonly environment: DiagnosticResult['environment']
  readonly entries: readonly BundleEntry[]
  readonly functionPaths: readonly string[]
  readonly redactions: readonly {
    readonly path: string
    readonly reason: 'signature' | 'replay-calldata' | 'long-string'
    readonly sha256: string
    readonly byteCount: number
  }[]
  readonly rawSimulations: readonly {
    readonly sourceEntryId: string
    readonly path: string
    readonly archivePath: string
  }[]
  readonly limitations: readonly string[]
}

export function emptyDiagnostic(command: DiagnosticCommand): DiagnosticResult {
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    command,
    environment: {},
    identifiers: {},
    observations: [],
    checks: [],
    findings: [],
    limitations: [],
    nextCommands: [],
  }
}
