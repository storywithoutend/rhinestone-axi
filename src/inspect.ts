import {
  computeDestinationSessionSalt,
  computeResolverAddress,
  findGasRefundViolations,
  getDestinationContracts,
  isFixableByNewSession,
  type QuotedGasRefund,
  ROLES_ALL,
  readQuotedGasRefunds,
} from './rhinestone.js'
import {
  permissionedResolverInitializeSnippet,
  permissionedResolverSetAddressSnippet,
  permissionedResolverSetTextSnippet,
} from '@ensdomains/ensjs-abi/v2/permissionedResolver'
import { verifiableFactoryDeployProxySnippet } from '@ensdomains/ensjs-abi/v2/verifiableFactory'
import {
  type Address,
  decodeFunctionData,
  encodeFunctionData,
  type Hex,
  isAddress,
  isAddressEqual,
  isHex,
  parseAbi,
} from 'viem'
import { type BundleArtifact, readDiagnosticBundle } from './archive.js'
import {
  type CheckResult,
  type CommandOutcome,
  type DiagnosticResult,
  type EvidenceReference,
  emptyDiagnostic,
  type Finding,
  type Observation,
} from './model.js'

const OLD_V1_RECORD_SELECTORS = new Set(['0x8b95dd71', '0x10f13a8c'])
const CALL_ABI = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer)',
  'function setNameWithHCA(address addr, string name)',
  'function claimWithHCA(address addr, address resolver) returns (bytes32)',
  'function enableSessionWithRefund(bytes data)',
])

interface CallArtifact {
  readonly source: EvidenceReference
  readonly path: string
  readonly to: Address
  readonly data: Hex
  readonly value?: bigint
}

interface LocatedValue {
  readonly source: EvidenceReference
  readonly path: string
  readonly value: unknown
}

function evidence(artifact: BundleArtifact, path?: string): EvidenceReference {
  return {
    source: artifact.entry.originalPath,
    ...(path ? { path } : {}),
    sha256: artifact.entry.sha256,
  }
}

function walkValues(
  value: unknown,
  artifact: BundleArtifact,
  path = '$',
): LocatedValue[] {
  const current = [{ source: evidence(artifact, path), path, value }]
  if (Array.isArray(value)) {
    return [
      ...current,
      ...value.flatMap((entry, index) =>
        walkValues(entry, artifact, `${path}[${index}]`),
      ),
    ]
  }
  if (!value || typeof value !== 'object') return current
  return [
    ...current,
    ...Object.entries(value).flatMap(([key, entry]) =>
      walkValues(entry, artifact, `${path}.${key}`),
    ),
  ]
}

function fieldName(path: string): string {
  const match = path.match(/\.([^.[\]]+)$/)
  return match?.[1] ?? ''
}

function findFields(
  artifacts: readonly BundleArtifact[],
  names: ReadonlySet<string>,
): LocatedValue[] {
  return artifacts.flatMap((artifact) =>
    walkValues(artifact.value, artifact).filter((entry) =>
      names.has(fieldName(entry.path)),
    ),
  )
}

function toBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value)
  }
  if (typeof value === 'string' && /^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    try {
      return BigInt(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

function toChainId(value: unknown): number | undefined {
  const parsed = toBigInt(value)
  if (
    parsed === undefined ||
    parsed < 0n ||
    parsed > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return undefined
  }
  return Number(parsed)
}

function findCalls(artifacts: readonly BundleArtifact[]): CallArtifact[] {
  return artifacts.flatMap((artifact) =>
    walkValues(artifact.value, artifact).flatMap((located) => {
      if (
        !Array.isArray(located.value) ||
        fieldName(located.path) !== 'calls'
      ) {
        return []
      }
      return located.value.flatMap((value, index) => {
        if (!value || typeof value !== 'object') return []
        const record = value as Record<string, unknown>
        if (
          typeof record.to !== 'string' ||
          !isAddress(record.to) ||
          typeof record.data !== 'string' ||
          !isHex(record.data)
        ) {
          return []
        }
        return [
          {
            source: evidence(artifact, `${located.path}[${index}]`),
            path: `${located.path}[${index}]`,
            to: record.to,
            data: record.data,
            ...(toBigInt(record.value) !== undefined
              ? { value: toBigInt(record.value) }
              : {}),
          },
        ]
      })
    }),
  )
}

function addressLabels(
  chainId: number | undefined,
): ReadonlyMap<string, string> {
  if (chainId === undefined) return new Map()
  try {
    const contracts = getDestinationContracts(chainId)
    return new Map(
      Object.entries(contracts).flatMap(([label, value]) =>
        typeof value === 'string' && isAddress(value)
          ? [[value.toLowerCase(), label] as const]
          : [],
      ),
    )
  } catch {
    return new Map()
  }
}

function decodeCall(call: CallArtifact): {
  readonly name?: string
  readonly args?: readonly unknown[]
} {
  const abis = [
    verifiableFactoryDeployProxySnippet,
    permissionedResolverInitializeSnippet,
    permissionedResolverSetAddressSnippet,
    permissionedResolverSetTextSnippet,
    CALL_ABI,
  ] as const
  for (const abi of abis) {
    try {
      const decoded = decodeFunctionData({ abi, data: call.data })
      return {
        name: decoded.functionName,
        args: decoded.args as readonly unknown[] | undefined,
      }
    } catch {}
  }
  return {}
}

function chainChecks(artifacts: readonly BundleArtifact[]): {
  readonly checks: readonly CheckResult[]
  readonly chainId?: number
  readonly limitations: readonly string[]
} {
  const fields = findFields(
    artifacts,
    new Set(['chainId', 'sourceChainId', 'targetChainId']),
  )
  const values = fields.flatMap((entry) => {
    const value = toChainId(entry.value)
    return value === undefined ? [] : [{ ...entry, value }]
  })
  const unique = [...new Set(values.map((entry) => entry.value))]
  if (unique.length === 0) {
    return {
      checks: [
        {
          id: 'chain.consistent',
          group: 'chain-deployment',
          status: 'skip',
          message: 'No chain identifiers were captured.',
          evidence: [],
        },
      ],
      limitations: ['No chain identifier was available for deployment checks.'],
    }
  }
  if (unique.length > 1) {
    return {
      checks: [
        {
          id: 'chain.consistent',
          group: 'chain-deployment',
          status: 'fail',
          message: `Captured artifacts disagree on chain id: ${unique.join(', ')}.`,
          expected: unique[0],
          actual: unique.slice(1),
          evidence: values.map((entry) => entry.source),
        },
      ],
      limitations: [],
    }
  }
  return {
    chainId: unique[0],
    checks: [
      {
        id: 'chain.consistent',
        group: 'chain-deployment',
        status: 'pass',
        message: `All captured chain identifiers equal ${unique[0]}.`,
        actual: unique[0],
        evidence: values.map((entry) => entry.source),
      },
    ],
    limitations: [],
  }
}

function callChecks(
  calls: readonly CallArtifact[],
  chainId: number | undefined,
  artifacts: readonly BundleArtifact[],
): {
  readonly checks: readonly CheckResult[]
  readonly observations: readonly Observation[]
  readonly limitations: readonly string[]
} {
  if (calls.length === 0) {
    return {
      checks: [
        {
          id: 'calls.present',
          group: 'call-policy',
          status: 'skip',
          message: 'No complete call array was captured.',
          evidence: [],
        },
      ],
      observations: [],
      limitations: [
        'Call policy could not be evaluated without target and calldata.',
      ],
    }
  }
  const labels = addressLabels(chainId)
  let validator: Address | undefined
  let factory: Address | undefined
  let resolverImplementation: Address | undefined
  if (chainId !== undefined) {
    try {
      const contracts = getDestinationContracts(chainId)
      validator = contracts.hcaOwnerAndSessionValidator
      factory = contracts.verifiableFactory
      resolverImplementation = contracts.permissionedResolverImpl
    } catch {
      validator = undefined
    }
  }
  const capturedAddress = (names: ReadonlySet<string>) =>
    findFields(artifacts, names).find(
      (entry) => typeof entry.value === 'string' && isAddress(entry.value),
    )?.value
  const hca = capturedAddress(new Set(['from', 'hca']))
  const owner = capturedAddress(new Set(['wallet', 'owner']))

  const results = calls.flatMap((call, index) => {
    const selector = call.data.slice(0, 10).toLowerCase()
    const decoded = decodeCall(call)
    const checks: CheckResult[] = [
      {
        id: `call.${index + 1}.decode`,
        group: 'call-policy',
        status: decoded.name ? 'pass' : 'skip',
        message: decoded.name
          ? `Decoded call ${index + 1} as ${decoded.name}.`
          : `Call ${index + 1} keeps raw selector ${selector}; no matching ABI was available.`,
        actual: { selector, target: call.to, functionName: decoded.name },
        evidence: [call.source],
      },
    ]
    if (OLD_V1_RECORD_SELECTORS.has(selector)) {
      checks.push({
        id: `call.${index + 1}.old-v1-selector`,
        group: 'call-policy',
        status: 'fail',
        message: `Call ${index + 1} uses old V1 record selector ${selector}.`,
        expected: 'PermissionedResolver V2 record selector',
        actual: selector,
        evidence: [call.source],
      })
    }
    if (validator && isAddressEqual(call.to, validator)) {
      checks.push({
        id: `call.${index + 1}.validator-target`,
        group: 'call-policy',
        status: 'fail',
        message: `Call ${index + 1} targets the stateless validator. Session enable calls are not allowed in the batch.`,
        expected: 'No validator-targeting execution',
        actual: call.to,
        evidence: [call.source],
      })
    }
    if (decoded.name === 'deployProxy' && decoded.args) {
      const [implementation, salt, initData] = decoded.args
      if (
        typeof implementation === 'string' &&
        isAddress(implementation) &&
        typeof salt === 'bigint' &&
        typeof initData === 'string' &&
        isHex(initData)
      ) {
        const rebuilt = encodeFunctionData({
          abi: verifiableFactoryDeployProxySnippet,
          functionName: 'deployProxy',
          args: [implementation, salt, initData],
        })
        checks.push({
          id: `call.${index + 1}.deploy-proxy-calldata`,
          group: 'call-policy',
          status: rebuilt === call.data ? 'pass' : 'fail',
          message:
            rebuilt === call.data
              ? 'deployProxy calldata is canonical for the decoded arguments.'
              : 'deployProxy calldata does not rebuild byte-for-byte.',
          expected: rebuilt,
          actual: call.data,
          evidence: [call.source],
        })
        if (factory && resolverImplementation) {
          checks.push({
            id: `call.${index + 1}.deployment-addresses`,
            group: 'chain-deployment',
            status:
              isAddressEqual(call.to, factory) &&
              isAddressEqual(implementation, resolverImplementation)
                ? 'pass'
                : 'fail',
            message:
              'Compared factory and resolver implementation with the chain manifest.',
            expected: { factory, implementation: resolverImplementation },
            actual: { factory: call.to, implementation },
            evidence: [call.source],
          })
        }
        try {
          const initializer = decodeFunctionData({
            abi: permissionedResolverInitializeSnippet,
            data: initData,
          })
          const grants = initializer.args?.[0]
          const initializationCalls = initializer.args?.[1]
          const exactGrants =
            Array.isArray(grants) &&
            grants.length === 2 &&
            grants.every(
              (grant) =>
                grant &&
                typeof grant === 'object' &&
                'roleBitmap' in grant &&
                grant.roleBitmap === ROLES_ALL,
            ) &&
            (typeof hca !== 'string' ||
              ('account' in grants[0] &&
                typeof grants[0].account === 'string' &&
                isAddress(grants[0].account) &&
                isAddressEqual(grants[0].account, hca as Address))) &&
            (typeof owner !== 'string' ||
              ('account' in grants[1] &&
                typeof grants[1].account === 'string' &&
                isAddress(grants[1].account) &&
                isAddressEqual(grants[1].account, owner as Address))) &&
            Array.isArray(initializationCalls) &&
            initializationCalls.length === 0
          checks.push({
            id: `call.${index + 1}.resolver-initializer`,
            group: 'call-policy',
            status: exactGrants ? 'pass' : 'fail',
            message: exactGrants
              ? 'Resolver initializer has exactly two ordered ALL_ROLES grants and no embedded calls.'
              : 'Resolver initializer differs from the required two ordered grants and empty call list.',
            expected: {
              grants: [
                {
                  account: typeof hca === 'string' ? hca : 'captured HCA',
                  roleBitmap: ROLES_ALL.toString(),
                },
                {
                  account: typeof owner === 'string' ? owner : 'captured owner',
                  roleBitmap: ROLES_ALL.toString(),
                },
              ],
              calls: [],
            },
            actual: stableValue({ grants, calls: initializationCalls }),
            evidence: [call.source],
          })
        } catch {
          checks.push({
            id: `call.${index + 1}.resolver-initializer`,
            group: 'call-policy',
            status: 'fail',
            message:
              'deployProxy initializer is not PermissionedResolver.initialize calldata.',
            evidence: [call.source],
          })
        }
      }
    }
    return checks
  })

  return {
    checks: results,
    observations: calls.map((call, index) => ({
      id: `call.${index + 1}`,
      message: `Call ${index + 1} targets ${labels.get(call.to.toLowerCase()) ?? call.to} with selector ${call.data.slice(0, 10)}.`,
      evidence: [call.source],
    })),
    limitations: results.some((check) => check.status === 'skip')
      ? ['Unknown selectors were preserved because no exact ABI matched them.']
      : [],
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  )
}

function fieldFromArtifact(
  artifact: BundleArtifact,
  name: string,
): LocatedValue | undefined {
  return walkValues(artifact.value, artifact).find(
    (entry) => fieldName(entry.path) === name,
  )
}

function auxiliaryFundsCheck(
  artifacts: readonly BundleArtifact[],
): CheckResult {
  const stages = artifacts
    .filter((artifact) =>
      [
        'sdk-input',
        'request',
        'prepared-route',
        'signed-transaction',
        'submitted-transaction',
      ].includes(artifact.entry.kind),
    )
    .map((artifact) => ({
      artifact,
      located: fieldFromArtifact(artifact, 'auxiliaryFunds'),
    }))
  const firstWithFunds = stages.find((stage) => stage.located)
  const laterWithoutFunds = firstWithFunds
    ? stages
        .slice(stages.indexOf(firstWithFunds) + 1)
        .find((stage) => !stage.located)
    : undefined
  if (firstWithFunds && laterWithoutFunds) {
    return {
      id: 'funding.auxiliary-funds-stage-diff',
      group: 'funding',
      status: 'fail',
      message: `auxiliaryFunds is present in ${firstWithFunds.artifact.entry.kind} but absent in later ${laterWithoutFunds.artifact.entry.kind}.`,
      expected: stableValue(firstWithFunds.located?.value),
      actual: undefined,
      evidence: [
        evidence(firstWithFunds.artifact, firstWithFunds.located?.path),
        evidence(laterWithoutFunds.artifact),
      ],
    }
  }
  if (firstWithFunds) {
    const mismatched = stages.find(
      (stage) =>
        stage.located &&
        JSON.stringify(stableValue(stage.located.value)) !==
          JSON.stringify(stableValue(firstWithFunds.located?.value)),
    )
    if (mismatched) {
      return {
        id: 'funding.auxiliary-funds-stage-diff',
        group: 'funding',
        status: 'fail',
        message: `auxiliaryFunds changes between ${firstWithFunds.artifact.entry.kind} and ${mismatched.artifact.entry.kind}.`,
        expected: stableValue(firstWithFunds.located?.value),
        actual: stableValue(mismatched.located?.value),
        evidence: [
          evidence(firstWithFunds.artifact, firstWithFunds.located?.path),
          evidence(mismatched.artifact, mismatched.located?.path),
        ],
      }
    }
    const capturedFunds = firstWithFunds.located
    if (!capturedFunds) {
      return {
        id: 'funding.auxiliary-funds-stage-diff',
        group: 'funding',
        status: 'skip',
        message: 'No auxiliaryFunds field was captured at any artifact stage.',
        evidence: [],
      }
    }
    return {
      id: 'funding.auxiliary-funds-stage-diff',
      group: 'funding',
      status: 'pass',
      message:
        'auxiliaryFunds is preserved across every captured artifact stage.',
      actual: stableValue(capturedFunds.value),
      evidence: stages.flatMap((stage) =>
        stage.located ? [evidence(stage.artifact, stage.located.path)] : [],
      ),
    }
  }
  return {
    id: 'funding.auxiliary-funds-stage-diff',
    group: 'funding',
    status: 'skip',
    message: 'No auxiliaryFunds field was captured at any artifact stage.',
    evidence: [],
  }
}

function refundChecks(
  artifacts: readonly BundleArtifact[],
): readonly CheckResult[] {
  const capsRecords = artifacts.flatMap((artifact) =>
    walkValues(artifact.value, artifact).flatMap((entry) => {
      if (!entry.value || typeof entry.value !== 'object') return []
      const record = entry.value as Record<string, unknown>
      const exchangeRate = toBigInt(record.maxRefundExchangeRate)
      const gasOverhead = toBigInt(record.maxRefundGasOverhead)
      const amount = toBigInt(record.maxRefundAmount)
      const token = record.refundToken
      if (
        exchangeRate === undefined ||
        gasOverhead === undefined ||
        amount === undefined ||
        typeof token !== 'string' ||
        !isAddress(token)
      ) {
        return []
      }
      return [
        {
          caps: {
            maxRefundExchangeRate: exchangeRate,
            maxRefundGasOverhead: gasOverhead,
            maxRefundAmount: amount,
          },
          token,
          source: entry.source,
        },
      ]
    }),
  )
  const routes = artifacts.flatMap((artifact) =>
    walkValues(artifact.value, artifact).flatMap((entry) => {
      const refunds: QuotedGasRefund[] = readQuotedGasRefunds(entry.value)
      return refunds.length > 0 ? [{ artifact, refunds, path: entry.path }] : []
    }),
  )
  if (capsRecords.length === 0 || routes.length === 0) {
    return [
      {
        id: 'funding.refund-caps',
        group: 'funding',
        status: 'skip',
        message:
          'Refund checks need both a prepared route and signed session caps.',
        evidence: [],
      },
    ]
  }
  const caps = capsRecords[0]
  if (!caps) return []
  const violations = routes.flatMap(({ artifact, path, refunds }) =>
    refunds.flatMap((refund, index) =>
      findGasRefundViolations(refund, caps.caps, caps.token).map(
        (violation) => ({
          violation,
          source: evidence(artifact, `${path}.refund[${index}]`),
        }),
      ),
    ),
  )
  if (violations.length === 0) {
    return [
      {
        id: 'funding.refund-caps',
        group: 'funding',
        status: 'pass',
        message: 'Every quoted gas refund is within the signed session caps.',
        evidence: [
          caps.source,
          ...routes.map(({ artifact }) => evidence(artifact)),
        ],
      },
    ]
  }
  return violations.map(({ violation, source }, index) => {
    const fixable = isFixableByNewSession([violation])
    return {
      id: `funding.refund-cap-${index + 1}`,
      group: 'funding' as const,
      status: 'fail' as const,
      message: `Quoted ${violation.field} ${violation.quoted} violates signed cap ${violation.cap}.${fixable ? ' This overhead-only miss can be corrected by authorizing a newly sized session.' : ''}`,
      expected: violation.cap.toString(),
      actual: {
        field: violation.field,
        quoted: violation.quoted.toString(),
        fixableByNewSession: fixable,
      },
      evidence: [caps.source, source],
    }
  })
}

interface DecodedSessionEnvelope {
  readonly hasZeroPrefix: boolean
  readonly mode: number
  readonly permissionId: Hex
  readonly sessionKey: Address
  readonly validUntil: bigint
  readonly sessionNonce: bigint
  readonly resolver: Address
  readonly refundToken: Address
  readonly maxRefundExchangeRate: bigint
  readonly maxRefundGasOverhead: bigint
  readonly maxRefundAmount: bigint
  readonly chainCount: number
}

function decodeSessionEnvelope(
  value: string,
): DecodedSessionEnvelope | undefined {
  if (!/^0x[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0)
    return undefined
  const bytes = Buffer.from(value.slice(2), 'hex')
  const hasZeroPrefix =
    bytes.length >= 20 && bytes.subarray(0, 20).every((byte) => byte === 0)
  let offset = hasZeroPrefix ? 20 : 0
  const minimum = 1 + 32 + 20 + 6 + 12 + 20 + 20 + 12 + 6 + 12 + 1 + 1
  if (bytes.length - offset < minimum) return undefined
  const take = (length: number) => {
    const result = bytes.subarray(offset, offset + length)
    offset += length
    return result
  }
  const asHex = (part: Uint8Array) => `0x${Buffer.from(part).toString('hex')}`
  const asBigInt = (part: Uint8Array) =>
    part.length === 0 ? 0n : BigInt(asHex(part))
  const mode = take(1)[0]
  if (mode === undefined) return undefined
  const permissionId = asHex(take(32))
  const sessionKey = asHex(take(20))
  const validUntil = asBigInt(take(6))
  const sessionNonce = asBigInt(take(12))
  const resolver = asHex(take(20))
  const refundToken = asHex(take(20))
  const maxRefundExchangeRate = asBigInt(take(12))
  const maxRefundGasOverhead = asBigInt(take(6))
  const maxRefundAmount = asBigInt(take(12))
  take(1)
  const chainCount = take(1)[0]
  if (
    chainCount === undefined ||
    !isHex(permissionId) ||
    !isAddress(sessionKey) ||
    !isAddress(resolver) ||
    !isAddress(refundToken)
  ) {
    return undefined
  }
  return {
    hasZeroPrefix,
    mode,
    permissionId,
    sessionKey,
    validUntil,
    sessionNonce,
    resolver,
    refundToken,
    maxRefundExchangeRate,
    maxRefundGasOverhead,
    maxRefundAmount,
    chainCount,
  }
}

function sessionChecks(
  artifacts: readonly BundleArtifact[],
  chainId: number | undefined,
): readonly CheckResult[] {
  const sessionRecords = artifacts.flatMap((artifact) =>
    walkValues(artifact.value, artifact).flatMap((entry) => {
      if (!entry.value || typeof entry.value !== 'object') return []
      const record = entry.value as Record<string, unknown>
      const nonce = toBigInt(record.hcaSessionNonce)
      const validUntil = toBigInt(record.validUntil)
      const resolver = record.resolver
      const refundToken = record.refundToken
      if (
        nonce === undefined ||
        validUntil === undefined ||
        typeof resolver !== 'string' ||
        !isAddress(resolver) ||
        typeof refundToken !== 'string' ||
        !isAddress(refundToken)
      ) {
        return []
      }
      return [
        {
          record,
          nonce,
          validUntil,
          resolver,
          refundToken,
          source: entry.source,
        },
      ]
    }),
  )
  const checks: CheckResult[] = []
  const permissionIds = findFields(artifacts, new Set(['permissionId'])).filter(
    (entry) => typeof entry.value === 'string' && isHex(entry.value),
  )
  const signatures = findFields(
    artifacts,
    new Set(['signature', 'authorization', 'userSignature']),
  ).flatMap((entry) =>
    typeof entry.value === 'string'
      ? [{ ...entry, decoded: decodeSessionEnvelope(entry.value) }]
      : [],
  )
  for (const [index, signature] of signatures.entries()) {
    if (!signature.decoded) {
      checks.push({
        id: `session.signature-${index + 1}.decode`,
        group: 'session',
        status: 'skip',
        message:
          'Captured signature bytes did not contain a complete fixed session envelope.',
        evidence: [signature.source],
      })
      continue
    }
    checks.push(
      {
        id: `session.signature-${index + 1}.outer-prefix`,
        group: 'session',
        status: signature.decoded.hasZeroPrefix ? 'pass' : 'fail',
        message: signature.decoded.hasZeroPrefix
          ? 'Signature carries the expected 20-byte outer prefix.'
          : 'Signature has no expected 20-byte outer prefix.',
        evidence: [signature.source],
      },
      {
        id: `session.signature-${index + 1}.inner-mode`,
        group: 'session',
        status: signature.decoded.mode === 0x05 ? 'pass' : 'fail',
        message: `Decoded inner session mode 0x${signature.decoded.mode.toString(16).padStart(2, '0')}.`,
        expected: '0x05',
        actual: `0x${signature.decoded.mode.toString(16).padStart(2, '0')}`,
        evidence: [signature.source],
      },
    )
    const observedPermissionId = permissionIds[0]
    if (observedPermissionId) {
      checks.push({
        id: `session.signature-${index + 1}.permission-id`,
        group: 'session',
        status:
          String(observedPermissionId.value).toLowerCase() ===
          signature.decoded.permissionId.toLowerCase()
            ? 'pass'
            : 'fail',
        message:
          'Compared the envelope permission id with the captured session permission id.',
        expected: observedPermissionId.value,
        actual: signature.decoded.permissionId,
        evidence: [signature.source, observedPermissionId.source],
      })
    }
  }
  for (const [index, session] of sessionRecords.entries()) {
    const salt = computeDestinationSessionSalt({
      hcaSessionNonce: session.nonce,
      validUntil: session.validUntil,
      resolver: session.resolver,
      refundToken: session.refundToken,
      ...(toBigInt(session.record.maxRefundExchangeRate) !== undefined
        ? {
            maxRefundExchangeRate: toBigInt(
              session.record.maxRefundExchangeRate,
            ),
          }
        : {}),
      ...(toBigInt(session.record.maxRefundGasOverhead) !== undefined
        ? {
            maxRefundGasOverhead: toBigInt(session.record.maxRefundGasOverhead),
          }
        : {}),
      ...(toBigInt(session.record.maxRefundAmount) !== undefined
        ? { maxRefundAmount: toBigInt(session.record.maxRefundAmount) }
        : {}),
    })
    const observedSalt = session.record.salt
    checks.push({
      id: `session.${index + 1}.salt`,
      group: 'session',
      status:
        typeof observedSalt === 'string' && isHex(observedSalt)
          ? observedSalt.toLowerCase() === salt.toLowerCase()
            ? 'pass'
            : 'fail'
          : 'skip',
      message:
        typeof observedSalt === 'string'
          ? observedSalt.toLowerCase() === salt.toLowerCase()
            ? 'Session salt matches nonce, expiry, resolver, refund token, and caps.'
            : 'Session salt does not match the captured authorization fields.'
          : 'Session authorization fields were captured without the derived salt.',
      expected: salt,
      actual: observedSalt,
      evidence: [session.source],
    })
  }

  const requests = artifacts.filter(
    (artifact) => artifact.entry.kind === 'request',
  )
  for (const [index, request] of requests.entries()) {
    const signer = fieldFromArtifact(request, 'signers')?.value
    const signerType =
      signer && typeof signer === 'object'
        ? (signer as Record<string, unknown>).type
        : undefined
    const sessionMode = signerType === 'experimental_session'
    const hasEnableData = Boolean(
      fieldFromArtifact(request, 'sessionEnableData') ??
        fieldFromArtifact(request, 'enableData'),
    )
    if (sessionRecords.length > 0 && signerType === 'owner') {
      checks.push({
        id: `session.request-${index + 1}.owner-mode`,
        group: 'session',
        status: 'fail',
        message: 'A scoped session request was emitted in owner mode.',
        expected: 'experimental_session',
        actual: signerType,
        evidence: [evidence(request)],
      })
    }
    if (sessionMode || sessionRecords.length > 0) {
      checks.push({
        id: `session.request-${index + 1}.enable-data`,
        group: 'session',
        status: hasEnableData ? 'pass' : 'fail',
        message: hasEnableData
          ? 'Session-signed request carries enableData.'
          : 'Session-signed request has no enableData for the stateless validator.',
        expected: 'enableData on every session-signed leg',
        actual: hasEnableData,
        evidence: [evidence(request)],
      })
    }
  }

  if (chainId !== undefined) {
    const requestFrom = findFields(artifacts, new Set(['from'])).find(
      (entry) => typeof entry.value === 'string' && isAddress(entry.value),
    )
    const resolver = sessionRecords[0]?.resolver
    if (requestFrom && typeof requestFrom.value === 'string' && resolver) {
      try {
        const expected = computeResolverAddress({
          chainId,
          hca: requestFrom.value as Address,
        })
        checks.push({
          id: 'session.resolver-address',
          group: 'session',
          status: isAddressEqual(expected, resolver) ? 'pass' : 'fail',
          message: isAddressEqual(expected, resolver)
            ? 'Session resolver matches the deterministic HCA resolver address.'
            : 'Session resolver does not match the deterministic HCA resolver address.',
          expected,
          actual: resolver,
          evidence: [requestFrom.source, sessionRecords[0]?.source].filter(
            (entry): entry is EvidenceReference => Boolean(entry),
          ),
        })
      } catch {
        // Unsupported chains are already reported by the deployment check.
      }
    }
  }
  return checks.length > 0
    ? checks
    : [
        {
          id: 'session.evidence',
          group: 'session',
          status: 'skip',
          message: 'No session authorization fields were captured.',
          evidence: [],
        },
      ]
}

function lifecycleChecks(
  artifacts: readonly BundleArtifact[],
): readonly CheckResult[] {
  const fillFields = findFields(
    artifacts,
    new Set(['fillTransactionHash', 'fillHash']),
  ).filter((entry) => typeof entry.value === 'string')
  const errors = findFields(
    artifacts,
    new Set(['error', 'finalError', 'message']),
  ).filter(
    (entry) =>
      typeof entry.value === 'string' &&
      /error|failed|revert|not registered/i.test(entry.value),
  )
  if (fillFields.length > 0 && errors.length > 0) {
    return [
      {
        id: 'lifecycle.fill-with-stale-failure',
        group: 'lifecycle',
        status: 'fail',
        message:
          'A fill transaction hash is paired with retained failure evidence.',
        evidence: [fillFields[0]?.source, errors[0]?.source].filter(
          (entry): entry is EvidenceReference => Boolean(entry),
        ),
      },
    ]
  }
  return [
    {
      id: 'lifecycle.fill-with-stale-failure',
      group: 'lifecycle',
      status: fillFields.length > 0 ? 'pass' : 'skip',
      message:
        fillFields.length > 0
          ? 'No retained failure was found beside the captured fill hash.'
          : 'No fill hash was captured for stale-failure correlation.',
      evidence: fillFields.map((entry) => entry.source),
    },
  ]
}

function identifiersFromArtifacts(
  artifacts: readonly BundleArtifact[],
): DiagnosticResult['identifiers'] {
  const firstString = (names: readonly string[]) =>
    findFields(artifacts, new Set(names))
      .map((entry) => entry.value)
      .find(
        (value): value is string =>
          typeof value === 'string' || typeof value === 'number',
      )
  const traceId = firstString(['traceId'])
  const intentId = firstString(['intentId', 'registrationIntentId'])
  const fillTransactionHash = firstString(['fillTransactionHash', 'fillHash'])
  const runId = firstString(['runId'])
  const txId = firstString(['txId'])
  return {
    ...(traceId !== undefined ? { traceId: String(traceId) } : {}),
    ...(intentId !== undefined ? { intentId: String(intentId) } : {}),
    ...(fillTransactionHash !== undefined
      ? { fillTransactionHash: String(fillTransactionHash) }
      : {}),
    ...(runId !== undefined ? { runId: String(runId) } : {}),
    ...(txId !== undefined ? { txId: String(txId) } : {}),
  }
}

function incidentFindings(checks: readonly CheckResult[]): Finding[] {
  const findings: Finding[] = []
  if (
    checks.some(
      (check) =>
        check.id === 'funding.auxiliary-funds-stage-diff' &&
        check.status === 'fail',
    )
  ) {
    findings.push({
      id: 'incident.artifact-stage-discrepancy',
      severity: 'error',
      confidence: 'incident-match',
      message:
        'This matches a known artifact-stage discrepancy pattern. The match is not proof that the same implementation caused this incident.',
      evidence:
        checks.find(
          (check) => check.id === 'funding.auxiliary-funds-stage-diff',
        )?.evidence ?? [],
    })
  }
  const refundOverhead = checks.find(
    (check) =>
      check.id.startsWith('funding.refund-cap-') &&
      check.status === 'fail' &&
      typeof check.actual === 'object' &&
      check.actual !== null &&
      (check.actual as Record<string, unknown>).field === 'gasOverhead',
  )
  if (refundOverhead) {
    findings.push({
      id: 'incident.refund-overhead-pattern',
      severity: 'error',
      confidence: 'incident-match',
      message:
        'This matches a known refund-overhead failure pattern. The numeric invariant is proven, but the incident match does not prove which code path produced it.',
      evidence: refundOverhead.evidence,
    })
  }
  if (
    checks.some(
      (check) =>
        check.id === 'lifecycle.fill-with-stale-failure' &&
        check.status === 'fail',
    )
  ) {
    findings.push({
      id: 'incident.stale-error-pattern',
      severity: 'warning',
      confidence: 'incident-match',
      message:
        'This matches a known stale-error pattern. The match does not establish that the same retry path ran here.',
      evidence:
        checks.find((check) => check.id === 'lifecycle.fill-with-stale-failure')
          ?.evidence ?? [],
    })
  }
  return findings
}

export async function inspectDiagnosticBundle(
  path: string,
): Promise<CommandOutcome> {
  const base = emptyDiagnostic('inspect')
  try {
    const bundle = await readDiagnosticBundle(path)
    const chain = chainChecks(bundle.artifacts)
    const calls = findCalls(bundle.artifacts)
    const callResults = callChecks(calls, chain.chainId, bundle.artifacts)
    const checks = [
      ...chain.checks,
      ...callResults.checks,
      ...sessionChecks(bundle.artifacts, chain.chainId),
      auxiliaryFundsCheck(bundle.artifacts),
      ...refundChecks(bundle.artifacts),
      ...lifecycleChecks(bundle.artifacts),
    ]
    const failed = checks.filter((check) => check.status === 'fail')
    const limitations = [
      ...bundle.manifest.limitations,
      ...chain.limitations,
      ...callResults.limitations,
      ...(bundle.manifest.environment.buildInfoId
        ? []
        : [
            'No deployment build-info id was captured, so unknown selectors stay raw.',
          ]),
    ]
    const observations: Observation[] = [
      {
        id: 'bundle.loaded',
        message: `Loaded ${bundle.artifacts.length} artifact(s) from ${path}.`,
        evidence: [{ source: path }],
      },
      ...bundle.artifacts.map((artifact) => ({
        id: `artifact.${artifact.entry.id}`,
        message: `Captured ${artifact.entry.kind} from ${artifact.entry.originalPath}.`,
        evidence: [evidence(artifact)],
      })),
      ...callResults.observations,
    ]
    return {
      exitCode: failed.length > 0 ? 10 : 0,
      result: {
        ...base,
        environment: {
          ...bundle.manifest.environment,
          ...(chain.chainId !== undefined ? { chainId: chain.chainId } : {}),
          ...(chain.chainId !== undefined
            ? (() => {
                try {
                  return {
                    validator: getDestinationContracts(chain.chainId)
                      .hcaOwnerAndSessionValidator,
                  }
                } catch {
                  return {}
                }
              })()
            : {}),
        },
        identifiers: identifiersFromArtifacts(bundle.artifacts),
        observations,
        checks,
        findings: incidentFindings(checks),
        limitations,
        nextCommands: [
          `ens-rhinestone replay --rpc-url "$ARCHIVE_RPC_URL" ${path}`,
        ],
      },
    }
  } catch (error) {
    return {
      exitCode: 20,
      result: {
        ...base,
        findings: [
          {
            id: 'inspect.invalid-bundle',
            severity: 'error',
            confidence: 'deterministic',
            message: error instanceof Error ? error.message : String(error),
            evidence: [{ source: path }],
          },
        ],
      },
    }
  }
}
