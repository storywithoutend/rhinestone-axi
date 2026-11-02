import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import type { BundleEntry, DiagnosticBundleManifest } from './model.js'

export interface BundleArtifact {
  readonly entry: BundleEntry
  readonly value: unknown
}

export interface LoadedDiagnosticBundle {
  readonly manifest: DiagnosticBundleManifest
  readonly artifacts: readonly BundleArtifact[]
  readonly files: Readonly<Record<string, Uint8Array>>
}

function parseJson(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(strFromU8(bytes)) as unknown
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function parseManifest(value: unknown): DiagnosticBundleManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('manifest.json must contain an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 'ens-rhinestone-bundle-v1') {
    throw new Error(
      `Unsupported bundle schema ${String(record.schemaVersion ?? 'missing')}`,
    )
  }
  if (!Array.isArray(record.entries)) {
    throw new Error('manifest.json entries must be an array')
  }
  return value as DiagnosticBundleManifest
}

export async function readDiagnosticBundle(
  path: string,
): Promise<LoadedDiagnosticBundle> {
  const files = unzipSync(new Uint8Array(await readFile(path)))
  const manifestBytes = files['manifest.json']
  if (!manifestBytes) throw new Error('Bundle has no manifest.json')
  const manifest = parseManifest(parseJson(manifestBytes, 'manifest.json'))
  const artifacts = manifest.entries.map((entry) => {
    const bytes = files[entry.archivePath]
    if (!bytes) throw new Error(`Bundle has no ${entry.archivePath}`)
    return {
      entry,
      value:
        entry.kind === 'log'
          ? strFromU8(bytes)
          : parseJson(bytes, entry.archivePath),
    }
  })
  return { manifest, artifacts, files }
}
