import { createHash } from 'node:crypto'

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function valueBytes(value: string): Uint8Array {
  if (/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    return Uint8Array.from(Buffer.from(value.slice(2), 'hex'))
  }
  return Uint8Array.from(Buffer.from(value))
}
