import { sha256, valueBytes } from './hash.js'
import type { BundleProfile } from './model.js'

const OMIT = Symbol('omit')
const MAX_STRING_BYTES = 64 * 1024

export interface UnsafeMatch {
  readonly path: string
  readonly reason:
    | 'private-key'
    | 'api-key'
    | 'bearer-token'
    | 'cookie'
    | 'mnemonic'
}

export interface SanitizedArtifact {
  readonly value: unknown
  readonly functionPaths: readonly string[]
  readonly unsafeMatches: readonly UnsafeMatch[]
  readonly redactions: readonly {
    readonly path: string
    readonly reason: 'signature' | 'replay-calldata' | 'long-string'
    readonly sha256: string
    readonly byteCount: number
  }[]
}

interface NodeResult {
  readonly value: unknown | typeof OMIT
  readonly functionPaths: readonly string[]
  readonly unsafeMatches: readonly UnsafeMatch[]
  readonly redactions: SanitizedArtifact['redactions']
}

const CREDENTIAL_KEYS = {
  privateKey: /(^|[_-])(private|secret)[_-]?key($|[_-])/i,
  apiKey: /(^|[_-])api[_-]?key($|[_-])/i,
  bearer: /authorization|bearer|access[_-]?token|refresh[_-]?token/i,
  cookie: /cookie|set-cookie/i,
  mnemonic: /mnemonic|seed[_-]?phrase/i,
} as const

function credentialReason(
  key: string,
  value: unknown,
): UnsafeMatch['reason'] | undefined {
  const normalizedKey = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  if (
    CREDENTIAL_KEYS.privateKey.test(key) ||
    normalizedKey.includes('privatekey') ||
    normalizedKey.includes('secretkey')
  ) {
    return 'private-key'
  }
  if (CREDENTIAL_KEYS.apiKey.test(key) || normalizedKey.includes('apikey')) {
    return 'api-key'
  }
  if (CREDENTIAL_KEYS.cookie.test(key)) return 'cookie'
  if (
    CREDENTIAL_KEYS.mnemonic.test(key) ||
    normalizedKey.includes('seedphrase')
  ) {
    return 'mnemonic'
  }
  if (
    CREDENTIAL_KEYS.bearer.test(key) &&
    typeof value === 'string' &&
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    return 'bearer-token'
  }
  if (typeof value === 'string') {
    if (/\bBearer\s+[^\s,;]+/i.test(value)) return 'bearer-token'
    if (/\b(?:x-)?api[-_ ]?key\s*[:=]\s*[^\s,;]+/i.test(value)) {
      return 'api-key'
    }
    if (
      /\b(?:private[-_ ]?key|session[-_ ]?private[-_ ]?key)\s*[:=]\s*(?:0x)?[0-9a-f]{64}\b/i.test(
        value,
      )
    ) {
      return 'private-key'
    }
    if (/\b(?:cookie|set-cookie)\s*:/i.test(value)) return 'cookie'
    if (
      /\b(?:mnemonic|seed phrase)\s*[:=]\s*(?:[a-z]+\s+){11,23}[a-z]+\b/i.test(
        value,
      )
    ) {
      return 'mnemonic'
    }
  }
  return undefined
}

function isSignaturePath(path: string): boolean {
  return /(?:^|\.)(?:signature|authorization|userSignature|ownerSignature|sessionSignature)$/i.test(
    path,
  )
}

function isReplayCalldataPath(path: string): boolean {
  return /simulation/i.test(path) && /(?:^|\.)(?:data|calldata)$/i.test(path)
}

function redactedValue(value: string) {
  const bytes = valueBytes(value)
  return {
    redacted: 'sha256' as const,
    sha256: sha256(bytes),
    byteCount: bytes.byteLength,
  }
}

function merge(
  value: unknown | typeof OMIT,
  parts: readonly NodeResult[],
): NodeResult {
  return {
    value,
    functionPaths: parts.flatMap((part) => part.functionPaths),
    unsafeMatches: parts.flatMap((part) => part.unsafeMatches),
    redactions: parts.flatMap((part) => part.redactions),
  }
}

function sanitizeNode(
  input: unknown,
  profile: BundleProfile,
  path: string,
  key: string,
  ancestors: ReadonlySet<object>,
): NodeResult {
  if (typeof input === 'function') {
    return {
      value: OMIT,
      functionPaths: [path],
      unsafeMatches: [],
      redactions: [],
    }
  }
  if (typeof input === 'bigint') {
    return {
      value: input.toString(),
      functionPaths: [],
      unsafeMatches: [],
      redactions: [],
    }
  }
  if (
    input === null ||
    typeof input === 'boolean' ||
    typeof input === 'number'
  ) {
    return {
      value: input,
      functionPaths: [],
      unsafeMatches: [],
      redactions: [],
    }
  }
  if (typeof input === 'string') {
    const unsafe = credentialReason(key, input)
    if (unsafe) {
      return {
        value: '[REJECTED UNSAFE VALUE]',
        functionPaths: [],
        unsafeMatches: [{ path, reason: unsafe }],
        redactions: [],
      }
    }
    if (profile === 'safe' && isSignaturePath(path)) {
      const redacted = redactedValue(input)
      return {
        value: redacted,
        functionPaths: [],
        unsafeMatches: [],
        redactions: [{ path, reason: 'signature', ...redacted }],
      }
    }
    if (profile === 'safe' && isReplayCalldataPath(path)) {
      const redacted = redactedValue(input)
      return {
        value: redacted,
        functionPaths: [],
        unsafeMatches: [],
        redactions: [{ path, reason: 'replay-calldata', ...redacted }],
      }
    }
    const bytes = valueBytes(input)
    if (bytes.byteLength > MAX_STRING_BYTES) {
      const redacted = redactedValue(input)
      return {
        value: {
          truncated: true,
          prefix: input.slice(0, 4096),
          ...redacted,
        },
        functionPaths: [],
        unsafeMatches: [],
        redactions: [{ path, reason: 'long-string', ...redacted }],
      }
    }
    return {
      value: input,
      functionPaths: [],
      unsafeMatches: [],
      redactions: [],
    }
  }
  if (typeof input === 'undefined' || typeof input === 'symbol') {
    return { value: OMIT, functionPaths: [], unsafeMatches: [], redactions: [] }
  }
  if (typeof input !== 'object') {
    return {
      value: String(input),
      functionPaths: [],
      unsafeMatches: [],
      redactions: [],
    }
  }
  if (ancestors.has(input)) {
    return {
      value: `[Circular ${path}]`,
      functionPaths: [],
      unsafeMatches: [],
      redactions: [],
    }
  }

  const nextAncestors = new Set(ancestors)
  nextAncestors.add(input)

  if (Array.isArray(input)) {
    const parts = input.map((value, index) =>
      sanitizeNode(
        value,
        profile,
        `${path}[${index}]`,
        String(index),
        nextAncestors,
      ),
    )
    return merge(
      parts.filter((part) => part.value !== OMIT).map((part) => part.value),
      parts,
    )
  }

  const parts = Object.entries(input).map(([entryKey, value]) => {
    const entryPath = `${path}.${entryKey}`
    const unsafe = credentialReason(entryKey, value)
    if (unsafe) {
      return {
        key: entryKey,
        result: {
          value: '[REJECTED UNSAFE VALUE]',
          functionPaths: [],
          unsafeMatches: [{ path: entryPath, reason: unsafe }],
          redactions: [],
        } satisfies NodeResult,
      }
    }
    return {
      key: entryKey,
      result: sanitizeNode(value, profile, entryPath, entryKey, nextAncestors),
    }
  })
  return merge(
    Object.fromEntries(
      parts
        .filter(({ result }) => result.value !== OMIT)
        .map(({ key: entryKey, result }) => [entryKey, result.value]),
    ),
    parts.map(({ result }) => result),
  )
}

export function sanitizeArtifact(
  input: unknown,
  profile: BundleProfile,
): SanitizedArtifact {
  const result = sanitizeNode(input, profile, '$', '', new Set())
  return {
    value: result.value === OMIT ? null : result.value,
    functionPaths: result.functionPaths,
    unsafeMatches: result.unsafeMatches,
    redactions: result.redactions,
  }
}
