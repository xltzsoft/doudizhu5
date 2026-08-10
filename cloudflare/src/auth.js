import { randomId } from './shared.js';

const encoder = new TextEncoder();

export async function hashPassword(password, salt = randomId(18), iterations = 20000) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations },
    key,
    256
  );
  return `pbkdf2$${iterations}$${salt}$${base64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, storedHash) {
  const [scheme, iterText, salt, expected] = String(storedHash || '').split('$');
  if (scheme !== 'pbkdf2' || !iterText || !salt || !expected) return false;
  const candidate = await hashPassword(password, salt, Number(iterText));
  return timingSafeEqual(candidate, storedHash);
}

export async function signToken(payload, secret, expiresInSeconds = 604800) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + Number(expiresInSeconds || 604800),
    jti: randomId(12)
  };
  const encodedHeader = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const encodedPayload = base64UrlJson(body);
  const signature = await hmac(`${encodedHeader}.${encodedPayload}`, secret);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export async function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  const [header, payload, signature] = parts;
  const expected = await hmac(`${header}.${payload}`, secret);
  if (!timingSafeEqual(signature, expected)) throw new Error('Invalid token');
  const body = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  if (body.exp && body.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return body;
}

export function getBearerToken(request) {
  const authHeader = request.headers.get('authorization') || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

async function hmac(text, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  return base64Url(new Uint8Array(signature));
}

function base64UrlJson(value) {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function timingSafeEqual(a, b) {
  const left = encoder.encode(String(a));
  const right = encoder.encode(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
