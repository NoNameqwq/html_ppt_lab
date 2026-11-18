import { Buffer } from 'buffer';
export function randomBytes(length) { return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(length))); }
