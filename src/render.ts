import { encode } from '@toon-format/toon'
import type { DiagnosticResult } from './model.js'

const DEFAULT_ITEM_LIMIT = 8
const DEFAULT_STRING_LIMIT = 800

interface RenderOptions {
  readonly full?: boolean
  readonly invocation?: string
}

interface TruncationState {
  truncatedItems: number
  truncatedStrings: number
}

function normalizeValue(
  value: unknown,
  full: boolean,
  state: TruncationState,
): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') {
    if (full || value.length <= DEFAULT_STRING_LIMIT) return value
    state.truncatedStrings += 1
    return {
      preview: `${value.slice(0, DEFAULT_STRING_LIMIT)}…`,
      totalChars: value.length,
    }
  }
  if (Array.isArray(value)) {
    const visible = full ? value : value.slice(0, DEFAULT_ITEM_LIMIT)
    if (!full && value.length > visible.length) {
      state.truncatedItems += value.length - visible.length
    }
    return visible.map((entry) => normalizeValue(entry, full, state))
  }
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      normalizeValue(entry, full, state),
    ]),
  )
}

export function renderHome(bin: string): string {
  return encode({
    bin,
    description:
      'Turn explicit Rhinestone failure captures into reproducible engineering evidence without submitting transactions',
    evidence: '0 explicit artifacts selected',
    help: [
      'Run `ens-rhinestone bundle --out <bundle.zip> <capture-path>...` to collect evidence.',
      'Run `ens-rhinestone inspect <bundle.zip>` to check captured invariants offline.',
      'Run `ens-rhinestone replay --rpc-url "$ARCHIVE_RPC_URL" <bundle.zip>` to reproduce a historical simulation.',
      'Run `ens-rhinestone status --intent-id <id> [--bundle <bundle.zip>]` to correlate orchestrator state.',
    ],
  })
}

export function renderAgentResult(
  result: DiagnosticResult,
  options: RenderOptions = {},
): string {
  const full = options.full === true
  const state: TruncationState = { truncatedItems: 0, truncatedStrings: 0 }
  if (full) return encode(normalizeValue(result, true, state))

  const passed = result.checks.filter((check) => check.status === 'pass')
  const failed = result.checks.filter((check) => check.status === 'fail')
  const skipped = result.checks.filter((check) => check.status === 'skip')
  const visibleObservations = result.observations.slice(0, DEFAULT_ITEM_LIMIT)
  if (result.observations.length > visibleObservations.length) {
    state.truncatedItems +=
      result.observations.length - visibleObservations.length
  }
  const visibleLimitations = result.limitations.slice(0, DEFAULT_ITEM_LIMIT)
  if (result.limitations.length > visibleLimitations.length) {
    state.truncatedItems +=
      result.limitations.length - visibleLimitations.length
  }

  const output = {
    command: result.command,
    schema: result.schemaVersion,
    summary: {
      observations: result.observations.length,
      checks: result.checks.length,
      passed: passed.length,
      failed: failed.length,
      skipped: skipped.length,
      findings: result.findings.length,
      limitations: result.limitations.length,
    },
    ...(Object.keys(result.identifiers).length > 0
      ? { identifiers: result.identifiers }
      : {}),
    observations: visibleObservations.map((observation) => ({
      id: observation.id,
      message: normalizeValue(observation.message, false, state),
    })),
    failedChecks: failed.map((check) => ({
      id: check.id,
      group: check.group,
      message: normalizeValue(check.message, false, state),
      ...(check.expected === undefined
        ? {}
        : { expected: normalizeValue(check.expected, false, state) }),
      ...(check.actual === undefined
        ? {}
        : { actual: normalizeValue(check.actual, false, state) }),
    })),
    findings: result.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      confidence: finding.confidence,
      message: normalizeValue(finding.message, false, state),
    })),
    limitations: visibleLimitations,
    help: [
      ...result.nextCommands,
      ...(state.truncatedItems > 0 || state.truncatedStrings > 0
        ? [
            `Run \`${options.invocation ?? `ens-rhinestone ${result.command}`} --full\` for complete output (${state.truncatedItems} hidden item(s), ${state.truncatedStrings} truncated string(s)).`,
          ]
        : []),
    ],
  }
  return encode(output)
}
