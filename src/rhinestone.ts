import {
  type Address,
  concatHex,
  encodeAbiParameters,
  getContractAddress,
  isAddressEqual,
  keccak256,
  stringToHex,
  type Hex,
  zeroAddress,
} from 'viem'

export interface DestinationContracts {
  readonly [name: string]: Address | bigint
  readonly standaloneHcaFactory: Address
  readonly standaloneHcaImplementation: Address
  readonly hcaOwnerAndSessionValidator: Address
  readonly verifiableFactory: Address
  readonly verifiableFactoryProxyLogic: Address
  readonly verifiableFactoryDeployBlock: bigint
  readonly permissionedResolverImpl: Address
  readonly ethRegistrar: Address
  readonly ethRegistry: Address
  readonly rootRegistry: Address
  readonly migrationHelper: Address
  readonly unlockedMigrationController: Address
  readonly lockedMigrationController: Address
  readonly publicResolverSet: Address
  readonly userRegistryImpl: Address
  readonly wrapperRegistryImpl: Address
  readonly publicResolverV2: Address
  readonly defaultReverseRegistrarHcaAdapter: Address
  readonly reverseRegistrarHcaAdapter: Address
  readonly legacyRegistry: Address
  readonly usdc: Address
}

const DESTINATION_CONTRACTS: Readonly<Record<number, DestinationContracts>> = {
  11155111: {
    standaloneHcaFactory: '0x6Bad0176236e97b346B5Dd13BCc8325B931EE8ab',
    standaloneHcaImplementation: '0xC940e5C5bF263C0e097054AECf73826769A72CEE',
    hcaOwnerAndSessionValidator: '0x4bF641590ab18E31B9F8789A3417A2620f860466',
    verifiableFactory: '0xDa70306C98E97eCe36F997a21368e53298572991',
    verifiableFactoryProxyLogic: '0xC41576B4B809B99CF0fF2e5B41b4F147cd9b6BDd',
    verifiableFactoryDeployBlock: 11_820_318n,
    permissionedResolverImpl: '0x115eb53F0c60696633855F90b138178Fb40b2b2C',
    ethRegistrar: '0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3',
    ethRegistry: '0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4',
    rootRegistry: '0xB458D6a3a77919449d03e7A6903C26827c1eC43f',
    migrationHelper: '0xA8F86EE5cdD28703bd876F3a8c10B1DE70f36899',
    unlockedMigrationController: '0x2a35B94DF22cc7354570be2284655E2CDC0e64A2',
    lockedMigrationController: '0x6029a063d69b09D23c52a754a90E4FE43aDac3A8',
    publicResolverSet: '0x5B2bd5208dac31905106d8e5a4973Ae1Cd7414F2',
    userRegistryImpl: '0x9BD8a88719068D09ecee662f36C0E3856708366a',
    wrapperRegistryImpl: '0xBe768b63E5fBBFBB0Ae97E9064E0002dF8001880',
    publicResolverV2: '0xdC4a563d00F5c3012b699794eB9e13A561Be386F',
    defaultReverseRegistrarHcaAdapter: '0x36f97328e843e37520cbF530e9402791c2754066',
    reverseRegistrarHcaAdapter: '0x56Bce5E727FAa9D237341Bb5B9E8a03D5919779d',
    legacyRegistry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  1: {
    standaloneHcaFactory: '0x742bf21897a78e2C98cC5f5C5473A370a081e561',
    standaloneHcaImplementation: '0x116F462FA078ec0009e9b25DCd60309E70aaC4F4',
    hcaOwnerAndSessionValidator: '0xa818428ed2F3F949bdc71b8A15bDD7B5D27ce938',
    verifiableFactory: '0x77510ba162dfeA3d8989E3f0928a691B345730D2',
    verifiableFactoryProxyLogic: '0x8E77da0dAb32EfCc1C75e0Bd0e17680EBe0b1414',
    verifiableFactoryDeployBlock: 26_105_299n,
    permissionedResolverImpl: '0x565b0F456a04Ac9b48758190e90030623Cff57C5',
    ethRegistrar: '0xD6D8369e55c94Ae8AFA714E6cF7AB5bE54D5CC81',
    ethRegistry: '0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2',
    rootRegistry: '0x2553c09bE6447BeFfdB86FA622ad41fB8f77A91e',
    migrationHelper: '0x6c8452AFc6043b5aF32eb345A8135108906F07ee',
    unlockedMigrationController: '0xaB821Ca676CF2e0790Fa273526a165CFa86aEB64',
    lockedMigrationController: '0x3ceA18620883a69ED349B23328A3B6302598e51A',
    publicResolverSet: '0xfFCedA021CBDF20f1a66ebbef32E49d208cAbf62',
    userRegistryImpl: '0xC927bCaA77cd7bE283518760896Be0CF3Cfbe08d',
    wrapperRegistryImpl: '0xe86A4ef4d7A210aAA1d6A9594fC7Add7cD2Cf888',
    publicResolverV2: '0x66f9F566fF2f26309C1Bd9134388478A801dA3e1',
    defaultReverseRegistrarHcaAdapter: '0xd86E32499eCAFe9c181dd7410f93A1a9bB61ef0d',
    reverseRegistrarHcaAdapter: '0x349151735790269a9C14668B58D7C83b5ecb9607',
    legacyRegistry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
}

export function getDestinationContracts(chainId: number): DestinationContracts {
  const contracts = DESTINATION_CONTRACTS[chainId]
  if (contracts === undefined) {
    throw new Error(`No destination contracts configured for chain ${chainId}`)
  }
  return contracts
}

export const ROLES_ALL =
  0x1111111111111111111111111111111111111111111111111111111111111111n

const MAX_REFUND_EXCHANGE_RATE = 20_000_000_000n
const MAX_REFUND_GAS_OVERHEAD = 500_000n
const MAX_REFUND_AMOUNT = 100_000_000n
const MAX_REFUND_GAS_OVERHEAD_CEILING = 100_000_000n

interface RefundCaps {
  readonly maxRefundExchangeRate: bigint
  readonly maxRefundGasOverhead: bigint
  readonly maxRefundAmount: bigint
}

const LEGACY_REFUND_CAPS: RefundCaps = {
  maxRefundExchangeRate: MAX_REFUND_EXCHANGE_RATE,
  maxRefundGasOverhead: MAX_REFUND_GAS_OVERHEAD,
  maxRefundAmount: MAX_REFUND_AMOUNT,
}

export interface QuotedGasRefund {
  readonly token: Address
  readonly exchangeRate: bigint
  readonly refundAmount: bigint
  readonly gasOverhead: bigint
}

interface IntentRouteShape {
  readonly intentOp?: {
    readonly elements?: readonly {
      readonly mandate?: {
        readonly qualifier?: {
          readonly settlementContext?: {
            readonly gasRefund?: {
              readonly token?: Address
              readonly exchangeRate?: bigint | string | number
              readonly overhead?: bigint | string | number
            }
          }
        }
      }
    }[]
  }
}

const UINT128_MASK = (1n << 128n) - 1n
const NO_REFUND: QuotedGasRefund = {
  token: zeroAddress,
  exchangeRate: 0n,
  refundAmount: 0n,
  gasOverhead: 0n,
}

export function readQuotedGasRefunds(intentRoute: unknown): QuotedGasRefund[] {
  const elements = (intentRoute as IntentRouteShape | undefined)?.intentOp
    ?.elements
  if (elements === undefined) return []
  return elements.map((element) => {
    const refund = element.mandate?.qualifier?.settlementContext?.gasRefund
    if (refund?.token === undefined) return NO_REFUND
    const overhead = BigInt(refund.overhead ?? 0)
    return {
      token: refund.token,
      exchangeRate: BigInt(refund.exchangeRate ?? 0),
      refundAmount: overhead >> 128n,
      gasOverhead: overhead & UINT128_MASK,
    }
  })
}

export type GasRefundField =
  | 'refundToken'
  | 'exchangeRate'
  | 'refundAmount'
  | 'gasOverhead'

export interface GasRefundViolation {
  readonly field: GasRefundField
  readonly quoted: bigint
  readonly cap: bigint
}

export function findGasRefundViolations(
  refund: QuotedGasRefund,
  caps: RefundCaps,
  refundToken: Address,
): GasRefundViolation[] {
  if (isAddressEqual(refund.token, zeroAddress)) {
    return refund.exchangeRate !== 0n ||
      refund.refundAmount !== 0n ||
      refund.gasOverhead !== 0n
      ? [{ field: 'refundToken', quoted: 0n, cap: 0n }]
      : []
  }

  return [
    ...(!isAddressEqual(refund.token, refundToken)
      ? [{ field: 'refundToken' as const, quoted: 0n, cap: 0n }]
      : []),
    ...(refund.exchangeRate === 0n ||
    refund.exchangeRate > caps.maxRefundExchangeRate
      ? [
          {
            field: 'exchangeRate' as const,
            quoted: refund.exchangeRate,
            cap: caps.maxRefundExchangeRate,
          },
        ]
      : []),
    ...(refund.refundAmount === 0n ||
    refund.refundAmount > caps.maxRefundAmount
      ? [
          {
            field: 'refundAmount' as const,
            quoted: refund.refundAmount,
            cap: caps.maxRefundAmount,
          },
        ]
      : []),
    ...(refund.gasOverhead > caps.maxRefundGasOverhead
      ? [
          {
            field: 'gasOverhead' as const,
            quoted: refund.gasOverhead,
            cap: caps.maxRefundGasOverhead,
          },
        ]
      : []),
  ]
}

export function isFixableByNewSession(
  violations: readonly GasRefundViolation[],
): boolean {
  return (
    violations.length > 0 &&
    violations.every(
      (violation) =>
        violation.field === 'gasOverhead' &&
        violation.quoted <= MAX_REFUND_GAS_OVERHEAD_CEILING,
    )
  )
}

function computeResolverSalt(hca: Address): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [
          { name: 'id', type: 'bytes32' },
          { name: 'owner', type: 'address' },
          { name: 'version', type: 'uint256' },
        ],
        [keccak256(stringToHex('OwnedResolver')), hca, 0n],
      ),
    ),
  )
}

const VERIFIABLE_PROXY_PREFIX =
  '0x3d604d80600a3d3981f3363d3d373d3d3d363d73' as const
const VERIFIABLE_PROXY_SUFFIX = '0x5af43d82803e903d91602b57fd5bf3' as const

export function computeResolverAddress(params: {
  readonly chainId: number
  readonly hca: Address
}): Address {
  const contracts = getDestinationContracts(params.chainId)
  const salt = computeResolverSalt(params.hca)
  const outerSalt = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [params.hca, salt],
    ),
  )
  const bytecode = concatHex([
    VERIFIABLE_PROXY_PREFIX,
    contracts.verifiableFactoryProxyLogic,
    VERIFIABLE_PROXY_SUFFIX,
    outerSalt,
  ])
  return getContractAddress({
    bytecode,
    from: contracts.verifiableFactory,
    opcode: 'CREATE2',
    salt: outerSalt,
  })
}

export function computeDestinationSessionSalt(params: {
  readonly hcaSessionNonce: bigint
  readonly validUntil: bigint
  readonly resolver: Address
  readonly refundToken: Address
  readonly maxRefundExchangeRate?: bigint
  readonly maxRefundGasOverhead?: bigint
  readonly maxRefundAmount?: bigint
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint96' },
        { type: 'uint48' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint96' },
        { type: 'uint48' },
        { type: 'uint96' },
      ],
      [
        params.hcaSessionNonce,
        Number(params.validUntil),
        params.resolver,
        params.refundToken,
        params.maxRefundExchangeRate ??
          LEGACY_REFUND_CAPS.maxRefundExchangeRate,
        Number(
          params.maxRefundGasOverhead ??
            LEGACY_REFUND_CAPS.maxRefundGasOverhead,
        ),
        params.maxRefundAmount ?? LEGACY_REFUND_CAPS.maxRefundAmount,
      ],
    ),
  )
}
