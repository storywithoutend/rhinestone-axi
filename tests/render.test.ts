import { decode } from '@toon-format/toon'
import { describe, expect, it } from 'vitest'
import { emptyDiagnostic } from '../src/model.js'
import { renderAgentResult, renderHome } from '../src/render.js'

describe('renderAgentResult', () => {
  it('prints compact TOON with aggregates and only failed checks by default', () => {
    const base = emptyDiagnostic('inspect')
    const output = renderAgentResult({
      ...base,
      observations: [{ id: 'o', message: 'observed bytes', evidence: [] }],
      checks: [
        {
          id: 'pass',
          group: 'chain-deployment',
          status: 'pass',
          message: 'chain matched',
          evidence: [],
        },
        {
          id: 'fail',
          group: 'call-policy',
          status: 'fail',
          message: 'calldata differs',
          evidence: [],
        },
      ],
      findings: [
        {
          id: 'f',
          severity: 'warning',
          confidence: 'incident-match',
          message: 'resembles a historical incident but is not proof',
          evidence: [],
        },
      ],
      limitations: ['missing raw trace'],
    })
    const decoded = decode(output) as Record<string, unknown>

    expect(decoded.summary).toEqual({
      observations: 1,
      checks: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      findings: 1,
      limitations: 1,
    })
    expect(decoded.failedChecks).toEqual([
      expect.objectContaining({ id: 'fail', group: 'call-policy' }),
    ])
    expect(output).not.toContain('chain matched')
  })

  it('uses --full output to preserve every diagnostic section', () => {
    const result = {
      ...emptyDiagnostic('inspect'),
      checks: [
        {
          id: 'pass',
          group: 'chain-deployment' as const,
          status: 'pass' as const,
          message: 'chain matched',
          evidence: [],
        },
      ],
    }
    const decoded = decode(renderAgentResult(result, { full: true })) as Record<
      string,
      unknown
    >

    expect(decoded.checks).toEqual([
      expect.objectContaining({ id: 'pass', message: 'chain matched' }),
    ])
    expect(decoded.observations).toEqual([])
    expect(decoded.findings).toEqual([])
  })

  it('truncates large content with a size hint and --full escape hatch', () => {
    const message = 'x'.repeat(900)
    const result = {
      ...emptyDiagnostic('status'),
      observations: [{ id: 'raw', message, evidence: [] }],
    }
    const compact = decode(
      renderAgentResult(result, {
        invocation: 'ens-rhinestone status --intent-id 1',
      }),
    ) as Record<string, unknown>
    const full = decode(renderAgentResult(result, { full: true })) as Record<
      string,
      unknown
    >

    expect(compact.observations).toEqual([
      {
        id: 'raw',
        message: {
          preview: `${'x'.repeat(800)}…`,
          totalChars: 900,
        },
      },
    ])
    expect(compact.help).toContain(
      'Run `ens-rhinestone status --intent-id 1 --full` for complete output (0 hidden item(s), 1 truncated string(s)).',
    )
    expect(full.observations).toEqual([
      expect.objectContaining({ id: 'raw', message }),
    ])
  })

  it('shows a definitive empty home state without scanning for evidence', () => {
    const decoded = decode(renderHome('/tmp/ens-rhinestone')) as Record<
      string,
      unknown
    >

    expect(decoded).toMatchObject({
      bin: '/tmp/ens-rhinestone',
      evidence: '0 explicit artifacts selected',
    })
    expect(decoded.help).toHaveLength(4)
  })
})
