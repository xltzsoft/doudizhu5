const encoder = new TextEncoder();
const decoder = new TextDecoder();
const COOKIE_NAME = 'owdns_session';
const DEFAULT_MAX_AGE = 12 * 60 * 60;

export async function createSessionToken(secret, maxAgeSeconds = DEFAULT_MAX_AGE) {
  if (!secret) throw new Error('缺少会话签名密钥');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now,
    exp: now + Number(maxAgeSeconds || DEFAULT_MAX_AGE),
    nonce: randomId(18)
  };
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await sign(secret, body);
  return `${body}.${signature}`;
}

export async function verifySessionToken(secret, token) {
  if (!secret || !token) return false;
  const [body, signature] = String(token).split('.');
  if (!body || !signature) return false;
  const expected = await sign(secret, body);
  if (!timingSafeEqual(signature, expected)) return false;

  try {
    const payload = JSON.parse(decoder.decode(base64UrlToBytes(body)));
    return Number(payload.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function getSessionToken(request) {
  const cookie = request.headers.get('cookie') || '';
  const pair = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`));
  return pair ? decodeURIComponent(pair.slice(COOKIE_NAME.length + 1)) : '';
}

export function sessionCookie(token, maxAgeSeconds = DEFAULT_MAX_AGE) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${Number(maxAgeSeconds || DEFAULT_MAX_AGE)}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function sign(secret, body) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return base64Url(new Uint8Array(signature));
}

function randomId(length) {
  const bytes = new Uint8Array(Math.ceil(length * 0.75) + 2);
  crypto.getRandomValues(bytes);
  return base64Url(bytes).slice(0, length);
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
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
