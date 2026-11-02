import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createDiagnosticBundle } from '../src/bundle.js'

describe('createDiagnosticBundle', () => {
  it('writes an atomic mode-0600 bundle with provenance and the ordered report sections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ens-rhinestone-bundle-'))
    const input = join(directory, 'request.json')
    const output = join(directory, 'failure.zip')
    await writeFile(
      input,
      JSON.stringify({
        type: 'rhinestone-intent',
        chainId: 11155111,
        rhinestoneParams: {
          calls: [
            {
              to: '0x0000000000000000000000000000000000000001',
              data: '0x12345678',
              value: '0',
            },
          ],
        },
      }),
    )

    const outcome = await createDiagnosticBundle({
      inputs: [input],
      output,
      profile: 'safe',
      now: new Date('2026-10-31T12:00:00.000Z'),
      cwd: directory,
    })

    expect(outcome.exitCode).toBe(0)
    expect((await stat(output)).mode & 0o777).toBe(0o600)

    const archive = unzipSync(new Uint8Array(await readFile(output)))
    const manifest = JSON.parse(strFromU8(archive['manifest.json']))
    expect(manifest.schemaVersion).toBe('ens-rhinestone-bundle-v1')
    expect(manifest.entries[0]).toMatchObject({
      originalPath: input,
      kind: 'request',
      byteCount: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })

    const report = strFromU8(archive['report.md'])
    expect(report.indexOf('## Direct observations')).toBeLessThan(
      report.indexOf('## Failed deterministic checks'),
    )
    expect(report.indexOf('## Failed deterministic checks')).toBeLessThan(
      report.indexOf('## Inferences'),
    )
    expect(report.indexOf('## Inferences')).toBeLessThan(
      report.indexOf('## Missing evidence'),
    )
    expect(report.indexOf('## Missing evidence')).toBeLessThan(
      report.indexOf('## Exact next commands'),
    )
  })

  it('rejects credentials embedded in plain log text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ens-rhinestone-log-'))
    const input = join(directory, 'orchestrator.log')
    const output = join(directory, 'failure.zip')
    await writeFile(
      input,
      'request failed Authorization: Bearer secret-token-value\n',
    )

    const outcome = await createDiagnosticBundle({
      inputs: [input],
      output,
      profile: 'safe',
      now: new Date('2026-10-31T12:00:00.000Z'),
      cwd: directory,
    })

    expect(outcome.exitCode).toBe(20)
    expect(outcome.result.findings[0]?.message).toContain('unsafe credential')
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not write a bundle when an input contains a private key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ens-rhinestone-unsafe-'))
    const input = join(directory, 'session.json')
    const output = join(directory, 'failure.zip')
    await writeFile(
      input,
      JSON.stringify({ sessionPrivateKey: `0x${'33'.repeat(32)}` }),
    )
    await chmod(input, 0o600)

    const outcome = await createDiagnosticBundle({
      inputs: [input],
      output,
      profile: 'safe',
      now: new Date('2026-10-31T12:00:00.000Z'),
      cwd: directory,
    })

    expect(outcome.exitCode).toBe(20)
    expect(outcome.result.findings[0]?.message).toContain('unsafe credential')
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
