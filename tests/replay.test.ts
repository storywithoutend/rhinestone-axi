import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticBundle } from '../src/bundle.js'
import { replayDiagnosticBundle } from '../src/replay.js'

const TARGET = '0x0000000000000000000000000000000000001000'
const RELAYER = '0x0000000000000000000000000000000000002000'
const TOKEN = '0x0000000000000000000000000000000000003000'

describe('replayDiagnosticBundle', () => {
  it('treats a reproduced revert as success and uses state diffs only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ens-rhinestone-replay-'))
    const errorPath = join(directory, 'error.json')
    const bundle = join(directory, 'failure.zip')
    await writeFile(
      errorPath,
      JSON.stringify({
        chainId: 11155111,
        traceId: 'trace-1',
        simulations: [
          {
            call: { to: TARGET, data: '0xabcdef01', value: '0' },
            details: {
              relayer: RELAYER,
              blockNumber: '12345678',
              stateOverride: {
                [RELAYER]: { balance: '0xffff' },
                [TOKEN]: {
                  state: {
                    '0x01': '0x02',
                  },
                },
              },
            },
          },
        ],
      }),
    )
    await createDiagnosticBundle({
      inputs: [errorPath],
      output: bundle,
      profile: 'local-replay',
      cwd: directory,
    })

    const fetchFn = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: body.method === 'eth_chainId' ? '0xaa36a7' : '0x6000',
          }),
          { status: 200 },
        )
      },
    )
    const runCast = vi.fn(async (_args: readonly string[]) => ({
      exitCode: 1,
      stdout: [
        'Traces:',
        `  [12000] ${TARGET}::fill()`,
        `    ├─ [4500] 0x4bF641590ab18E31B9F8789A3417A2620f860466::isValidSignatureWithSender()`,
        '    │   └─ ← [Revert] custom error 0xe50c42ea',
        '    └─ ← [Revert] InvalidSignature()',
      ].join('\n'),
      stderr: '',
    }))

    const outcome = await replayDiagnosticBundle({
      bundlePath: bundle,
      rpcUrl: 'https://archive.example/key',
      fetchFn,
      runCast,
    })

    expect(outcome.exitCode).toBe(0)
    expect(runCast).toHaveBeenCalledOnce()
    const args = runCast.mock.calls[0]?.[0]
    expect(args).toContain('--override-state-diff')
    expect(args).not.toContain('--override-state')
    expect(outcome.result.observations).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('0xe50c42ea'),
      }),
    )
    expect(outcome.result.observations).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('$ARCHIVE_RPC'),
      }),
    )
  })
})
