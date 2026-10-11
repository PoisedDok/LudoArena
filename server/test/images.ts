import { randomBytes } from 'crypto'

/** A tiny but real PNG header + random payload: unique per call so duplicate-screenshot checks do not collide. */
export function pngBytes(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)])
}

export function jpegBytes(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)])
}

export function webpBytes(): Buffer {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), randomBytes(32)])
}
