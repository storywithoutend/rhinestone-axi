import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticBundle } from '../src/bundle.js'
import { correlateIntentStatus } from '../src/status.js'

describe('correlateIntentStatus', () => {
  it('preserves the raw response and reports a completed intent beside a stale local failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ens-rhinestone-status-'))
    const telemetry = join(directory, 'telemetry.json')
    const bundle = join(directory, 'failure.zip')
    await writeFile(
      telemetry,
      JSON.stringify({
        schemaVersion: 'tm-failed-run-v2',
        run: { runId: 'run-1', txId: 'tx-1', status: 'error' },
        summary: {
          finalError: {
            name: 'TransactionSubmissionError',
            message: 'first attempt failed',
          },
        },
      }),
    )
    await createDiagnosticBundle({
      inputs: [telemetry],
      output: bundle,
      profile: 'safe',
      cwd: directory,
    })
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ status: 'COMPLETED', fillTransactionHash: '0xabc' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    )

    const outcome = await correlateIntentStatus({
      intentId: '42',
      bundlePath: bundle,
      endpointUrl: 'https://orchestrator.example',
      fetchFn,
      now: new Date('2026-10-31T13:00:00.000Z'),
    })

    expect(outcome.exitCode).toBe(10)
    expect(fetchFn).toHaveBeenCalledWith(
      'https://orchestrator.example/intent-operation/42',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(outcome.result.observations).toContainEqual(
      expect.objectContaining({
        id: 'status.raw-response',
        data: expect.objectContaining({
          rawBody: expect.stringContaining('COMPLETED'),
        }),
      }),
    )
    expect(outcome.result.checks).toContainEqual(
      expect.objectContaining({
        id: 'status.orchestrator-vs-local',
        status: 'fail',
      }),
    )
  })
})
