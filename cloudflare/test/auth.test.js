import { describe, expect, it } from 'vitest';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../src/auth.js';

describe('auth helpers', () => {
  it('hashes and verifies passwords without bcrypt', async () => {
    const hash = await hashPassword('secret123');
    expect(hash).toMatch(/^pbkdf2\$/);
    expect(await verifyPassword('secret123', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('signs and verifies HMAC tokens', async () => {
    const token = await signToken({ username: 'alice' }, 'test-secret', 60);
    const payload = await verifyToken(token, 'test-secret');
    expect(payload.username).toBe('alice');
    await expect(verifyToken(token, 'other-secret')).rejects.toThrow('Invalid token');
  });
});
