export interface PreflightError {
  readonly error: string
  readonly help: string
}

interface CommandShape {
  readonly valueFlags: ReadonlySet<string>
  readonly booleanFlags: ReadonlySet<string>
  readonly requiredFlags: ReadonlySet<string>
  readonly positional: { readonly min: number; readonly max?: number }
}

const GLOBAL_FLAGS = new Set([
  '--help',
  '-h',
  '--version',
  '-v',
  '-V',
  '--wizard',
  '--completions',
  '--log-level',
])
const GLOBAL_BOOLEAN_FLAGS = new Set(['--version', '-v', '-V', '--wizard'])
const GLOBAL_VALUE_FLAGS = new Set(['--completions', '--log-level'])

const SHAPES: Readonly<Record<string, CommandShape>> = {
  bundle: {
    valueFlags: new Set(['--out', '--profile']),
    booleanFlags: new Set(['--json', '--full']),
    requiredFlags: new Set(['--out']),
    positional: { min: 1 },
  },
  inspect: {
    valueFlags: new Set(),
    booleanFlags: new Set(['--json', '--full']),
    requiredFlags: new Set(),
    positional: { min: 1, max: 1 },
  },
  replay: {
    valueFlags: new Set(['--rpc-url']),
    booleanFlags: new Set(['--json', '--full']),
    requiredFlags: new Set(['--rpc-url']),
    positional: { min: 1, max: 1 },
  },
  status: {
    valueFlags: new Set([
      '--intent-id',
      '--bundle',
      '--endpoint-url',
      '--rpc-url',
    ]),
    booleanFlags: new Set(['--json', '--full']),
    requiredFlags: new Set(['--intent-id']),
    positional: { min: 0, max: 0 },
  },
}

function commandHelp(command: string): string {
  return `Run \`ens-rhinestone ${command} --help\` for valid flags and examples.`
}

export function validateCliArgs(
  args: readonly string[],
): PreflightError | undefined {
  if (
    args.length === 0 ||
    args.some((argument) => argument === '--help' || argument === '-h')
  ) {
    return undefined
  }
  const command = args[0]
  if (!command || GLOBAL_FLAGS.has(command)) return undefined
  const shape = SHAPES[command]
  if (!shape) {
    return {
      error: `unknown command ${command}`,
      help: 'Valid commands: bundle, inspect, replay, status.',
    }
  }

  const seen = new Set<string>()
  const positional: string[] = []
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index] ?? ''
    const equals = argument.indexOf('=')
    const flag = equals > 0 ? argument.slice(0, equals) : argument
    const inlineValue = equals > 0 ? argument.slice(equals + 1) : undefined
    if (GLOBAL_BOOLEAN_FLAGS.has(flag) || shape.booleanFlags.has(flag)) {
      if (inlineValue !== undefined) {
        return {
          error: `${flag} does not accept a value`,
          help: commandHelp(command),
        }
      }
      seen.add(flag)
      continue
    }
    if (GLOBAL_VALUE_FLAGS.has(flag) || shape.valueFlags.has(flag)) {
      const value = inlineValue ?? args[index + 1]
      if (!value || (inlineValue === undefined && value.startsWith('--'))) {
        return { error: `${flag} requires a value`, help: commandHelp(command) }
      }
      seen.add(flag)
      if (inlineValue === undefined) index += 1
      if (flag === '--profile' && !['safe', 'local-replay'].includes(value)) {
        return {
          error: `invalid --profile value ${value}`,
          help: 'Valid values: safe, local-replay.',
        }
      }
      continue
    }
    if (argument.startsWith('-')) {
      return {
        error: `unknown flag ${flag} for ${command}`,
        help: commandHelp(command),
      }
    }
    positional.push(argument)
  }

  for (const required of shape.requiredFlags) {
    if (!seen.has(required)) {
      return {
        error: `missing required flag ${required}`,
        help: commandHelp(command),
      }
    }
  }
  if (positional.length < shape.positional.min) {
    return {
      error: `missing required argument for ${command}`,
      help: commandHelp(command),
    }
  }
  if (
    shape.positional.max !== undefined &&
    positional.length > shape.positional.max
  ) {
    return {
      error: `too many arguments for ${command}`,
      help: commandHelp(command),
    }
  }
  return undefined
}
