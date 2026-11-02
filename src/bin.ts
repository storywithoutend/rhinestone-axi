#!/usr/bin/env node

import { VERSION } from './version.js'

const args = process.argv.slice(2)
const isVersionProbe =
  args.length === 1 && ['-v', '-V', '--version'].includes(args[0] ?? '')

if (isVersionProbe) {
  process.stdout.write(`${VERSION}\n`)
} else {
  const preflightModule = './preflight.js'
  const { validateCliArgs } = await import(preflightModule)
  const error = validateCliArgs(args)
  if (error) {
    process.stdout.write(
      `error: ${JSON.stringify(error.error)}\nhelp: ${JSON.stringify(error.help)}`,
    )
    process.exitCode = 20
  } else {
    const mainModule = './main.cjs'
    const { main } = await import(mainModule)
    main()
  }
}
