/**
 * AES-256-GCM encryption for custodial player private keys.
 * Storage format: iv:tag:ciphertext (hex). Never log plaintext keys.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { config } from '../config';

function encryptionKey(): Buffer {
  const secret = config.keyEncryptionSecret;
  if (!secret) throw new Error('KEY_ENCRYPTION_SECRET is required to encrypt player keys');
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, 'hex');
  return scryptSync(secret, 'glitch-near-key-v1', 32);
}

/** Encrypt a private key. Returns `iv:tag:ciphertext` (hex). */
export function encryptPrivateKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** Decrypt a stored `iv:tag:ciphertext` blob. */
export function decryptPrivateKey(blob: string): string {
  const parts = blob.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted key format');
  const [ivHex, tagHex, dataHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
