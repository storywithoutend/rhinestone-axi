import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect } from 'effect'
import { Command } from 'effect/cli'
import { cli } from './cli.js'
import { VERSION } from './version.js'

export function main(): void {
  Command.run(cli, { version: VERSION }).pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        process.exitCode = 20
      }),
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  )
}
