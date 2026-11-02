import { describe, expect, it } from 'vitest'
import { sanitizeArtifact } from '../src/sanitize.js'

describe('sanitizeArtifact', () => {
  it('preserves bigint values, removes functions, and hashes signatures in safe bundles', () => {
    const result = sanitizeArtifact(
      {
        amount: 2n ** 200n,
        callback: () => undefined,
        signature: `0x${'11'.repeat(65)}`,
      },
      'safe',
    )

    expect(result.unsafeMatches).toEqual([])
    expect(result.functionPaths).toEqual(['$.callback'])
    expect(result.value).toEqual({
      amount: (2n ** 200n).toString(),
      signature: {
        redacted: 'sha256',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        byteCount: 65,
      },
    })
  })

  it('preserves structured authorization evidence without treating it as a bearer token', () => {
    const result = sanitizeArtifact(
      {
        authorization: {
          permissionId: `0x${'44'.repeat(32)}`,
          enableData: { validUntil: '1800000000' },
        },
      },
      'local-replay',
    )

    expect(result.unsafeMatches).toEqual([])
    expect(result.value).toEqual({
      authorization: {
        permissionId: `0x${'44'.repeat(32)}`,
        enableData: { validUntil: '1800000000' },
      },
    })
  })

  it('rejects credentials instead of placing them in the sanitized value', () => {
    const result = sanitizeArtifact(
      {
        sessionPrivateKey: `0x${'22'.repeat(32)}`,
        nested: { Authorization: 'Bearer secret-token' },
      },
      'local-replay',
    )

    expect(result.unsafeMatches.map((match) => match.path)).toEqual([
      '$.sessionPrivateKey',
      '$.nested.Authorization',
    ])
    expect(JSON.stringify(result.value)).not.toContain('secret-token')
    expect(JSON.stringify(result.value)).not.toContain('22222222')
  })
})
