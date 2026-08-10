export const ACCOUNT_NAME_PATTERN = /^[\w\u4e00-\u9fa5]+$/u;
export const AI_DIFFICULTIES = new Set(['easy', 'normal', 'hard']);
export const DEFAULT_LLM_API_URL = 'http://sub.stzo.cn:11666/v1';
export const DEFAULT_LLM_MODEL = 'K2.6-Inst';

const AI_DIFFICULTY_LABELS = {
  easy: '休闲',
  normal: '标准',
  hard: '高级协作'
};

export function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    }
  });
}

export function normalizeAccountName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function validateAccountName(value, label = '昵称', adminUsername = 'admin') {
  if (!value) return `${label}不能为空`;
  if (value.length < 2 || value.length > 20) return `${label}长度需为2-20字符`;
  if (!ACCOUNT_NAME_PATTERN.test(value)) return `${label}只能包含字母、数字、下划线和中文`;
  if (value === adminUsername) return `${adminUsername} 为后台保留账号`;
  return null;
}

export function normalizeAiDifficulty(value) {
  return AI_DIFFICULTIES.has(value) ? value : 'normal';
}

export function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
}

export function normalizeLlmApiUrl(value) {
  const input = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_LLM_API_URL;
  const withoutTrailingSlash = input.replace(/\/+$/g, '');
  const baseUrl = withoutTrailingSlash.replace(/\/chat\/completions$/i, '');

  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_LLM_API_URL;
    return url.toString().replace(/\/+$/g, '');
  } catch {
    return DEFAULT_LLM_API_URL;
  }
}

export function normalizeLlmModel(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : DEFAULT_LLM_MODEL;
}

export function normalizeAiSettings(settings = {}) {
  const difficulty = normalizeAiDifficulty(settings.difficulty);
  return {
    difficulty,
    label: AI_DIFFICULTY_LABELS[difficulty],
    llmEnabled: normalizeBoolean(settings.llmEnabled),
    llmApiUrl: normalizeLlmApiUrl(settings.llmApiUrl),
    llmModel: normalizeLlmModel(settings.llmModel)
  };
}

export function normalizeRoomSettings(settings = {}) {
  const baseScore = Number(settings.baseScore ?? settings.scoreMultiplier ?? 10);
  return {
    baseScore: Number.isFinite(baseScore) ? Math.max(1, Math.min(100000, Math.floor(baseScore))) : 10,
    doubleEnabled: Boolean(settings.doubleEnabled),
    allowOpenCards: Boolean(settings.allowOpenCards ?? settings.openCards)
  };
}

export function makeSocketMessage(event, data = null, ackId = null) {
  return JSON.stringify({ event, data, ackId });
}

export function parseSocketMessage(input) {
  let parsed;
  try {
    parsed = typeof input === 'string' ? JSON.parse(input) : input;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed.event !== 'string') return null;
  return {
    event: parsed.event,
    data: parsed.data ?? null,
    ackId: typeof parsed.ackId === 'string' ? parsed.ackId : null
  };
}

export function randomId(length = 12) {
  const bytes = new Uint8Array(Math.ceil(length * 0.75) + 2);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/[+/=]/g, '')
    .slice(0, length);
}

export function hasChangedNicknameThisMonth(timestamp, now = new Date()) {
  if (!timestamp) return false;
  const changedAt = new Date(String(timestamp).includes('T') ? timestamp : `${String(timestamp).replace(' ', 'T')}Z`);
  if (Number.isNaN(changedAt.getTime())) return false;
  return changedAt.getUTCFullYear() === now.getUTCFullYear()
    && changedAt.getUTCMonth() === now.getUTCMonth();
}
