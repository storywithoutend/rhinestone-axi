import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDiagnosticBundle } from '../src/bundle.js'
import { inspectDiagnosticBundle } from '../src/inspect.js'

const HCA = '0x1000000000000000000000000000000000000001'
const TOKEN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'

describe('inspectDiagnosticBundle', () => {
  it('reports auxiliaryFunds disappearing between preparation and submission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ens-rhinestone-inspect-'))
    const sdkInput = join(directory, 'sdk-input.json')
    const submitted = join(directory, 'submitted.json')
    const bundle = join(directory, 'failure.zip')
    await writeFile(
      sdkInput,
      JSON.stringify({
        kind: 'sdk-input',
        chainId: 11155111,
        auxiliaryFunds: { '11155111': { [TOKEN]: '20000000' } },
        calls: [{ to: TOKEN, data: '0x095ea7b3', value: '0' }],
      }),
    )
    await writeFile(
      submitted,
      JSON.stringify({
        kind: 'submitted-transaction',
        chainId: 11155111,
        calls: [{ to: TOKEN, data: '0x095ea7b3', value: '0' }],
      }),
    )
    const bundled = await createDiagnosticBundle({
      inputs: [sdkInput, submitted],
      output: bundle,
      profile: 'local-replay',
      cwd: directory,
    })
    expect(bundled.exitCode).toBe(0)

    const outcome = await inspectDiagnosticBundle(bundle)

    expect(outcome.exitCode).toBe(10)
    expect(outcome.result.checks).toContainEqual(
      expect.objectContaining({
        id: 'funding.auxiliary-funds-stage-diff',
        status: 'fail',
      }),
    )
    expect(outcome.result.findings).toContainEqual(
      expect.objectContaining({
        confidence: 'incident-match',
        message: expect.stringContaining('artifact-stage discrepancy'),
      }),
    )
  })

  it('reports only the refund field that exceeds the signed session caps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ens-rhinestone-refund-'))
    const session = join(directory, 'a.json')
    const route = join(directory, 'b.json')
    const bundle = join(directory, 'failure.zip')
    await writeFile(
      session,
      JSON.stringify({
        chainId: 11155111,
        refundToken: '0x768F42455A2D082E23ceeF7d51e5787C82d67a39',
        maxRefundExchangeRate: '20000000000',
        maxRefundGasOverhead: '500000',
        maxRefundAmount: '100000000',
      }),
    )
    await writeFile(
      route,
      JSON.stringify({
        intentRoute: {
          intentOp: {
            elements: [
              {
                mandate: {
                  qualifier: {
                    settlementContext: {
                      gasRefund: {
                        token: '0x768F42455A2D082E23ceeF7d51e5787C82d67a39',
                        exchangeRate: '2568073614',
                        overhead: '7030233700586588655153319389540331251653304',
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      }),
    )
    await createDiagnosticBundle({
      inputs: [session, route],
      output: bundle,
      profile: 'safe',
      cwd: directory,
    })

    const outcome = await inspectDiagnosticBundle(bundle)
    const violations = outcome.result.checks.filter((check) =>
      check.id.startsWith('funding.refund-cap-'),
    )

    expect(outcome.exitCode).toBe(10)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      message: expect.stringContaining('gasOverhead 2972344'),
      expected: '500000',
      actual: {
        field: 'gasOverhead',
        quoted: '2972344',
        fixableByNewSession: true,
      },
    })
  })

  it('accepts a quoted gas overhead below the signed cap', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'ens-rhinestone-refund-control-'),
    )
    const session = join(directory, 'a.json')
    const route = join(directory, 'b.json')
    const bundle = join(directory, 'failure.zip')
    await writeFile(
      session,
      JSON.stringify({
        chainId: 11155111,
        refundToken: '0x768F42455A2D082E23ceeF7d51e5787C82d67a39',
        maxRefundExchangeRate: '20000000000',
        maxRefundGasOverhead: '500000',
        maxRefundAmount: '100000000',
      }),
    )
    await writeFile(
      route,
      JSON.stringify({
        intentOp: {
          elements: [
            {
              mandate: {
                qualifier: {
                  settlementContext: {
                    gasRefund: {
                      token: '0x768F42455A2D082E23ceeF7d51e5787C82d67a39',
                      exchangeRate: '2568073614',
                      overhead: '7030233700586588655153319389540331249070000',
                    },
                  },
                },
              },
            },
          ],
        },
      }),
    )
    await createDiagnosticBundle({
      inputs: [session, route],
      output: bundle,
      profile: 'safe',
      cwd: directory,
    })

    const outcome = await inspectDiagnosticBundle(bundle)

    expect(outcome.exitCode).toBe(0)
    expect(
      outcome.result.checks.filter((check) =>
        check.id.startsWith('funding.refund-cap-'),
      ),
    ).toEqual([])
  })

  it('continues after policy violations and reports each bad call', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ens-rhinestone-policy-'))
    const request = join(directory, 'request.json')
    const bundle = join(directory, 'failure.zip')
    await writeFile(
      request,
      JSON.stringify({
        type: 'rhinestone-intent',
        from: HCA,
        chainId: 11155111,
        rhinestoneParams: {
          calls: [
            {
              to: '0x2000000000000000000000000000000000000002',
              data: '0x8b95dd71',
              value: '0',
            },
            {
              to: '0x4bF641590ab18E31B9F8789A3417A2620f860466',
              data: '0x12345678',
              value: '0',
            },
          ],
        },
      }),
    )
    await createDiagnosticBundle({
      inputs: [request],
      output: bundle,
      profile: 'local-replay',
      cwd: directory,
    })

    const outcome = await inspectDiagnosticBundle(bundle)

    expect(
      outcome.result.checks.filter(
        (check) => check.group === 'call-policy' && check.status === 'fail',
      ),
    ).toHaveLength(2)
  })
})
