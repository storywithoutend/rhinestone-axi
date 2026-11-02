#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decode, encode } from '@toon-format/toon'

const EVAL_ROOT = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(EVAL_ROOT, '..')
const BINARY = join(PACKAGE_ROOT, 'dist', 'bin.js')
const FIXTURES = join(EVAL_ROOT, 'fixtures')
const VERSION = '0.1.0'

function fail(message, details) {
  const error = new Error(message)
  error.details = details
  throw error
}

function assert(condition, message, details) {
  if (!condition) fail(message, details)
}

function runCli(args, options = {}) {
  const result = spawnSync(BINARY, args, {
    cwd: options.cwd ?? PACKAGE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 20 * 1024 * 1024,
  })
  return {
    exitCode: result.status ?? 40,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function parseJson(run) {
  try {
    return JSON.parse(run.stdout)
  } catch (error) {
    fail('command did not return JSON', {
      error: String(error),
      stdoutPreview: run.stdout.slice(0, 500),
    })
  }
}

function parseToon(run) {
  try {
    return decode(run.stdout)
  } catch (error) {
    fail('command did not return valid TOON', {
      error: String(error),
      stdoutPreview: run.stdout.slice(0, 500),
    })
  }
}

function fixture(...parts) {
  return join(FIXTURES, ...parts)
}

function bundle(directory, inputs, profile = 'local-replay') {
  const output = join(directory, 'failure.zip')
  const run = runCli([
    'bundle',
    '--json',
    '--profile',
    profile,
    '--out',
    output,
    ...inputs,
  ])
  assert(run.exitCode === 0, 'bundle command failed', run)
  assert(existsSync(output), 'bundle command did not write its output', {
    output,
  })
  return output
}

function startServer(mode, directory) {
  const portFile = join(directory, `${mode}.port`)
  const child = spawn(
    process.execPath,
    [join(EVAL_ROOT, 'support', 'http-server.cjs'), mode, portFile],
    { stdio: 'ignore' },
  )
  const deadline = Date.now() + 5_000
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) {
      child.kill('SIGTERM')
      fail(`timed out starting ${mode} server`)
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  return {
    port: Number(readFileSync(portFile, 'utf8')),
    stop: () => child.kill('SIGTERM'),
  }
}

const cases = [
  {
    id: 'axi-home-empty-state',
    category: 'agent-ergonomics',
    run() {
      const result = runCli([])
      const output = parseToon(result)
      assert(result.exitCode === 0, 'home view did not exit 0', result)
      assert(
        result.stderr === '',
        'home view wrote diagnostics to stderr',
        result,
      )
      assert(
        output.evidence === '0 explicit artifacts selected',
        'home view did not state the definitive empty evidence state',
        output,
      )
      assert(
        Array.isArray(output.help) && output.help.length === 4,
        'home view lacks contextual commands',
        output,
      )
      return { evidence: output.evidence, suggestions: output.help.length }
    },
  },
  {
    id: 'axi-version-fast-path',
    category: 'agent-ergonomics',
    run() {
      const outputs = ['-v', '-V', '--version'].map((flag) => runCli([flag]))
      for (const result of outputs) {
        assert(result.exitCode === 0, 'version probe failed', result)
        assert(
          result.stdout === `${VERSION}\n`,
          'version output was not bare',
          result,
        )
        assert(result.stderr === '', 'version probe wrote to stderr', result)
      }
      const binBytes = statSync(BINARY).size
      assert(
        binBytes < 2_048,
        'version entrypoint is too large to be a fast path',
        { binBytes },
      )
      return { probes: outputs.length, binBytes }
    },
  },
  {
    id: 'axi-structured-usage-error',
    category: 'error-recovery',
    run() {
      const result = runCli(['bundle', '--definitely-unknown'])
      assert(
        result.exitCode === 20,
        'unknown flag did not use usage exit code 20',
        result,
      )
      assert(result.stderr === '', 'usage error leaked to stderr', result)
      assert(
        result.stdout.includes('definitely-unknown'),
        'usage error omitted the bad flag',
        result,
      )
      assert(
        result.stdout.includes('--help'),
        'usage error omitted self-correction help',
        result,
      )
      return { exitCode: result.exitCode, stdoutBytes: result.stdout.length }
    },
  },
  {
    id: 'axi-subcommand-help',
    category: 'agent-ergonomics',
    run() {
      const result = runCli(['inspect', '--help'])
      assert(result.exitCode === 0, 'subcommand help did not exit 0', result)
      assert(result.stderr === '', 'subcommand help wrote to stderr', result)
      for (const expected of ['Examples:', '--full', '--json', '<bundle>']) {
        assert(
          result.stdout.includes(expected),
          `subcommand help omitted ${expected}`,
          result,
        )
      }
      return { exitCode: result.exitCode, stdoutBytes: result.stdout.length }
    },
  },
  {
    id: 'axi-missing-file-error',
    category: 'error-recovery',
    run(directory) {
      const output = join(directory, 'missing.zip')
      const result = runCli([
        'bundle',
        '--out',
        output,
        join(directory, 'does-not-exist.json'),
      ])
      const body = parseToon(result)
      assert(
        result.exitCode === 20,
        'missing input path did not use exit 20',
        result,
      )
      assert(
        result.stderr === '',
        'domain input error leaked to stderr',
        result,
      )
      assert(
        body.summary.failed === 0,
        'domain error was misreported as a failed invariant',
        body,
      )
      assert(
        body.findings[0]?.id === 'bundle.failed',
        'domain error finding changed',
        body,
      )
      assert(!existsSync(output), 'missing-input bundle was written', {
        output,
      })
      return { exitCode: result.exitCode, finding: body.findings[0].id }
    },
  },
  {
    id: 'refund-cap-overflow',
    category: 'diagnosis',
    run(directory) {
      const path = bundle(directory, [
        fixture('refund-cap-overflow', 'session.json'),
        fixture('refund-cap-overflow', 'route.json'),
        fixture('refund-cap-overflow', 'status.json'),
      ])
      const result = runCli(['inspect', '--json', path])
      const output = parseJson(result)
      const violation = output.checks.find(
        (check) => check.actual?.field === 'gasOverhead',
      )
      assert(
        result.exitCode === 10,
        'overflow did not fail deterministic inspection',
        result,
      )
      assert(
        violation?.actual?.quoted === '2972344',
        'quoted overhead was decoded incorrectly',
        violation,
      )
      assert(
        violation?.expected === '500000',
        'signed cap was decoded incorrectly',
        violation,
      )
      return {
        check: violation.id,
        quoted: violation.actual.quoted,
        cap: violation.expected,
      }
    },
  },
  {
    id: 'refund-cap-control',
    category: 'negative-control',
    run(directory) {
      const path = bundle(directory, [
        fixture('refund-cap-control', 'session.json'),
        fixture('refund-cap-control', 'route.json'),
      ])
      const result = runCli(['inspect', '--json', path])
      const output = parseJson(result)
      assert(
        result.exitCode === 0,
        'valid refund quote produced a false positive',
        result,
      )
      assert(
        !output.checks.some((check) =>
          check.id.startsWith('funding.refund-cap-'),
        ),
        'valid refund quote emitted a cap violation',
        output.checks,
      )
      return {
        exitCode: result.exitCode,
        failedChecks: output.checks.filter((check) => check.status === 'fail')
          .length,
      }
    },
  },
  {
    id: 'auxiliary-funds-stage-loss',
    category: 'diagnosis',
    run(directory) {
      const path = bundle(directory, [
        fixture('auxiliary-funds-loss', 'sdk-input.json'),
        fixture('auxiliary-funds-loss', 'submitted.json'),
      ])
      const result = runCli(['inspect', '--json', path])
      const output = parseJson(result)
      const check = output.checks.find(
        (entry) => entry.id === 'funding.auxiliary-funds-stage-diff',
      )
      assert(
        result.exitCode === 10 && check?.status === 'fail',
        'stage loss was not detected',
        { result, check },
      )
      return { check: check.id, status: check.status }
    },
  },
  {
    id: 'multi-policy-fault-exhaustive',
    category: 'investigation',
    run(directory) {
      const path = bundle(directory, [
        fixture('multi-policy-fault', 'request.json'),
      ])
      const result = runCli(['inspect', '--json', path])
      const output = parseJson(result)
      const failedIds = output.checks
        .filter((check) => check.status === 'fail')
        .map((check) => check.id)
      assert(
        result.exitCode === 10,
        'policy faults did not produce exit 10',
        result,
      )
      assert(
        failedIds.includes('call.1.old-v1-selector'),
        'old selector fault was missed',
        failedIds,
      )
      assert(
        failedIds.includes('call.2.validator-target'),
        'validator target fault was missed',
        failedIds,
      )
      return { failedChecks: failedIds.length, checkIds: failedIds }
    },
  },
  {
    id: 'credential-log-rejected',
    category: 'security',
    run(directory) {
      const output = join(directory, 'unsafe.zip')
      const result = runCli([
        'bundle',
        '--json',
        '--out',
        output,
        fixture('credential-log', 'orchestrator.log'),
      ])
      const body = parseJson(result)
      assert(
        result.exitCode === 20,
        'credential input did not use exit 20',
        result,
      )
      assert(!existsSync(output), 'unsafe bundle was written', { output })
      assert(
        body.findings[0]?.message.includes('unsafe credential'),
        'credential error was not actionable',
        body,
      )
      return { exitCode: result.exitCode, bundleWritten: existsSync(output) }
    },
  },
  {
    id: 'malformed-bundle-rejected',
    category: 'error-recovery',
    run() {
      const result = runCli([
        'inspect',
        '--json',
        fixture('malformed', 'not-a-bundle.zip'),
      ])
      const output = parseJson(result)
      assert(
        result.exitCode === 20,
        'malformed bundle did not use exit 20',
        result,
      )
      assert(
        output.findings[0]?.id === 'inspect.invalid-bundle',
        'malformed bundle finding changed',
        output,
      )
      return { exitCode: result.exitCode, finding: output.findings[0].id }
    },
  },
  {
    id: 'incomplete-replay-inconclusive',
    category: 'error-recovery',
    run(directory) {
      const path = bundle(directory, [
        fixture('auxiliary-funds-loss', 'sdk-input.json'),
      ])
      const result = runCli([
        'replay',
        '--json',
        '--rpc-url',
        'http://127.0.0.1:1',
        path,
      ])
      const output = parseJson(result)
      assert(
        result.exitCode === 30,
        'missing replay evidence did not use exit 30',
        result,
      )
      assert(
        output.findings[0]?.id === 'replay.missing-input',
        'missing replay finding changed',
        output,
      )
      return { exitCode: result.exitCode, finding: output.findings[0].id }
    },
  },
  {
    id: 'replay-state-diff-and-redaction',
    category: 'replay',
    run(directory) {
      const path = bundle(directory, [
        fixture('replay-state-diff', 'error.json'),
      ])
      const binDirectory = join(directory, 'bin')
      const castPath = join(binDirectory, 'cast')
      const argsPath = join(directory, 'cast.args')
      spawnSync('mkdir', ['-p', binDirectory])
      writeFileSync(
        castPath,
        `#!/bin/sh\nprintf '%s\\n' "$@" > "$CAST_ARGS_FILE"\ncat <<'TRACE'\nTraces:\n  [12000] 0x0000000000000000000000000000000000001000::fill()\n    ├─ [4500] 0x4bF641590ab18E31B9F8789A3417A2620f860466::isValidSignatureWithSender()\n    │   └─ ← [Revert] custom error 0xe50c42ea\n    └─ ← [Revert] InvalidSignature()\nTRACE\nexit 1\n`,
      )
      chmodSync(castPath, 0o755)
      const server = startServer('rpc', directory)
      try {
        const rpcUrl = `http://127.0.0.1:${server.port}/private-token`
        const result = runCli(['replay', '--json', '--rpc-url', rpcUrl, path], {
          env: {
            PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
            CAST_ARGS_FILE: argsPath,
          },
        })
        const output = parseJson(result)
        const args = readFileSync(argsPath, 'utf8').split('\n')
        assert(
          result.exitCode === 0,
          'reproduced revert was not successful execution',
          result,
        )
        assert(
          args.includes('--override-state-diff'),
          'replay did not use state diff',
          args,
        )
        assert(
          !args.includes('--override-state'),
          'replay used full state replacement',
          args,
        )
        assert(
          JSON.stringify(output).includes('$ARCHIVE_RPC'),
          'replay omitted redacted RPC marker',
          output,
        )
        assert(
          !JSON.stringify(output).includes('/private-token'),
          'replay leaked RPC URL',
          output,
        )
        return { exitCode: result.exitCode, stateDiff: true, rpcRedacted: true }
      } finally {
        server.stop()
      }
    },
  },
  {
    id: 'status-unknown-preserved',
    category: 'status',
    run(directory) {
      const server = startServer('status', directory)
      try {
        const result = runCli([
          'status',
          '--json',
          '--intent-id',
          '123',
          '--endpoint-url',
          `http://127.0.0.1:${server.port}`,
        ])
        const output = parseJson(result)
        const observation = output.observations.find(
          (entry) => entry.id === 'status.raw-response',
        )
        assert(
          result.exitCode === 0,
          'unknown status should remain observable',
          result,
        )
        assert(
          observation?.data?.status === 'UNKNOWN',
          'unknown status was coerced',
          observation,
        )
        assert(
          observation?.data?.rawBody.includes('QUEUED_BY_NEW_BACKEND'),
          'raw status body was lost',
          observation,
        )
        return { exitCode: result.exitCode, status: observation.data.status }
      } finally {
        server.stop()
      }
    },
  },
  {
    id: 'toon-minimal-and-full-disclosure',
    category: 'agent-ergonomics',
    run(directory) {
      const path = bundle(directory, [
        fixture('refund-cap-overflow', 'session.json'),
        fixture('refund-cap-overflow', 'route.json'),
      ])
      const compact = runCli(['inspect', path])
      const full = runCli(['inspect', '--full', path])
      const compactOutput = parseToon(compact)
      const fullOutput = parseToon(full)
      assert(
        compact.exitCode === 10 && full.exitCode === 10,
        'output mode changed diagnostic exit code',
        { compact, full },
      )
      assert(
        compactOutput.summary.failed === 1,
        'compact output omitted failure aggregate',
        compactOutput,
      )
      assert(
        Array.isArray(compactOutput.failedChecks) &&
          compactOutput.failedChecks.length === 1,
        'compact output did not focus on failed checks',
        compactOutput,
      )
      assert(
        Array.isArray(fullOutput.checks) &&
          fullOutput.checks.length > compactOutput.failedChecks.length,
        'full output did not reveal complete checks',
        fullOutput,
      )
      assert(
        compact.stdout.length < full.stdout.length,
        'compact output was not smaller than full output',
        { compactBytes: compact.stdout.length, fullBytes: full.stdout.length },
      )
      return {
        compactBytes: compact.stdout.length,
        fullBytes: full.stdout.length,
        failed: compactOutput.summary.failed,
      }
    },
  },
]

function printHelp() {
  process.stdout.write(
    encode({
      description:
        'Run deterministic ens-rhinestone product and agent-ergonomics evals',
      usage: 'node evals/run-deterministic.mjs [--case <id>] [--full]',
      flags: [
        {
          name: '--case <id>',
          default: 'all',
          description: 'Run one named eval case',
        },
        {
          name: '--full',
          default: false,
          description: 'Include successful case details',
        },
        { name: '--help', default: false, description: 'Show this reference' },
      ],
      examples: ['npm run eval', 'npm run eval -- --case refund-cap-overflow --full'],
    }),
  )
}

function parseArgs(args) {
  let selected
  let full = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') return { help: true, full }
    if (argument === '--full') {
      full = true
      continue
    }
    if (argument === '--case') {
      selected = args[index + 1]
      index += 1
      if (!selected) fail('--case requires an eval id')
      continue
    }
    fail(`unknown flag ${argument}`, {
      validFlags: ['--case', '--full', '--help'],
    })
  }
  return { help: false, full, selected }
}

async function main() {
  if (!existsSync(BINARY)) {
    process.stdout.write(
      encode({
        error: 'built CLI is missing',
        help: 'Run `npm run build` before the eval runner.',
      }),
    )
    process.exitCode = 2
    return
  }

  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stdout.write(
      encode({
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
        help: 'Run `node evals/run-deterministic.mjs --help`.',
      }),
    )
    process.exitCode = 2
    return
  }
  if (options.help) {
    printHelp()
    return
  }

  const selectedCases = options.selected
    ? cases.filter((entry) => entry.id === options.selected)
    : cases
  if (selectedCases.length === 0) {
    process.stdout.write(
      encode({
        error: `unknown eval case ${options.selected}`,
        available: cases.map((entry) => entry.id),
      }),
    )
    process.exitCode = 2
    return
  }

  const results = []
  for (const entry of selectedCases) {
    const directory = mkdtempSync(
      join(tmpdir(), `ens-rhinestone-eval-${entry.id}-`),
    )
    const started = performance.now()
    try {
      const details = await entry.run(directory)
      results.push({
        id: entry.id,
        category: entry.category,
        status: 'pass',
        durationMs: Math.round(performance.now() - started),
        details,
      })
    } catch (error) {
      results.push({
        id: entry.id,
        category: entry.category,
        status: 'fail',
        durationMs: Math.round(performance.now() - started),
        details: {
          message: error instanceof Error ? error.message : String(error),
          ...(error?.details ? { evidence: error.details } : {}),
        },
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  const failed = results.filter((entry) => entry.status === 'fail')
  const output = {
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      durationMs: results.reduce((total, entry) => total + entry.durationMs, 0),
    },
    cases: results.map((entry) => ({
      id: entry.id,
      category: entry.category,
      status: entry.status,
      durationMs: entry.durationMs,
    })),
    ...(options.full
      ? {
          details: results.map((entry) => ({ id: entry.id, ...entry.details })),
        }
      : failed.length > 0
        ? {
            failures: failed.map((entry) => ({
              id: entry.id,
              ...entry.details,
            })),
          }
        : {}),
    ...(failed.length > 0
      ? {
          help: failed.map(
            (entry) =>
              `Run \`npm run eval -- --case ${entry.id} --full\` for focused evidence.`,
          ),
        }
      : {}),
  }
  process.stdout.write(encode(output))
  process.exitCode = failed.length > 0 ? 1 : 0
}

await main()
