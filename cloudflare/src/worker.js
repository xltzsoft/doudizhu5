import { D1Store, buildProfileResponse } from './d1-store.js';
import { getBearerToken, hashPassword, signToken, verifyPassword, verifyToken } from './auth.js';
import {
  jsonResponse,
  normalizeAccountName,
  randomId,
  validateAccountName
} from './shared.js';
import { GameHub } from './game-hub.js';
import socketClientSource from './socket-client.js';

export { GameHub };

const USER_TOKEN_SECONDS = 7 * 24 * 60 * 60;
const AVATAR_DATA_MAX_LENGTH = 220 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const store = new D1Store(env.DB);

    try {
      if (url.pathname === '/socket.io/socket.io.js') {
        return new Response(socketClientSource, {
          headers: {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store'
          }
        });
      }

      if (url.pathname === '/ws') return forwardToHub(request, env);
      if (url.pathname.startsWith('/api/')) return handleApi(request, env, store, url);

      if (env.ASSETS) {
        const assetResponse = await env.ASSETS.fetch(request);
        return withNoStore(assetResponse);
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      return jsonResponse({ error: error.message || '服务器错误' }, 500);
    }
  }
};

export async function handleApi(request, env, store, url = new URL(request.url)) {
  const method = request.method.toUpperCase();

  if (method === 'POST' && url.pathname === '/api/register') return register(request, env, store);
  if (method === 'POST' && url.pathname === '/api/login') return login(request, env, store);
  if (method === 'GET' && url.pathname === '/api/profile') return requireUser(request, env, store, user => jsonResponse(buildProfileResponse(user)));
  if (method === 'PATCH' && url.pathname === '/api/profile') return updateProfile(request, env, store);
  if (method === 'POST' && url.pathname === '/api/profile/avatar') return updateAvatar(request, env, store);
  if (method === 'GET' && url.pathname === '/api/leaderboard') return jsonResponse(await store.getLeaderboard());
  if (method === 'GET' && url.pathname === '/api/history') return jsonResponse(await store.getGameHistoryList());
  if (method === 'GET' && url.pathname === '/api/room-history') {
    return jsonResponse(await store.getRoomHistory(url.searchParams.get('roomId') || '', url.searchParams.get('roomName') || ''));
  }
  if (method === 'GET' && url.pathname === '/api/rooms') return proxyHubJson(env, '/rooms');

  if (method === 'POST' && url.pathname === '/api/admin/login') return adminLogin(request, env);
  if (method === 'GET' && url.pathname === '/api/admin/overview') return requireAdmin(request, env, async () => {
    const summary = await store.getAdminSummary();
    const rooms = await hubJson(env, '/rooms');
    return jsonResponse({
      userCount: Number(summary?.user_count || 0),
      totalScore: Number(summary?.total_score || 0),
      totalGamesPlayed: Number(summary?.total_games_played || 0),
      historyCount: Number(summary?.history_count || 0),
      onlineUsers: Number(rooms.onlineUsers || 0),
      roomCount: rooms.rooms?.length || 0,
      waitingRooms: (rooms.rooms || []).filter(room => room.status === 'waiting').length,
      playingRooms: (rooms.rooms || []).filter(room => room.status === 'playing').length,
      finishedRooms: (rooms.rooms || []).filter(room => room.status === 'finished').length,
      aiSettings: await getPublicAiSettings(store, env),
      liveRooms: rooms.rooms || []
    });
  });
  if (method === 'GET' && url.pathname === '/api/admin/ai-settings') {
    return requireAdmin(request, env, async () => jsonResponse(await getPublicAiSettings(store, env)));
  }
  if (method === 'PATCH' && url.pathname === '/api/admin/ai-settings') {
    return requireAdmin(request, env, async () => {
      const body = await readJson(request);
      await store.updateAiSettings({
        difficulty: body?.difficulty,
        llmEnabled: body?.llmEnabled,
        llmApiUrl: body?.llmApiUrl,
        llmModel: body?.llmModel
      });
      return jsonResponse(await getPublicAiSettings(store, env));
    });
  }

  if (method === 'GET' && url.pathname === '/api/admin/users') {
    return requireAdmin(request, env, async () => jsonResponse(await store.listUsers(url.searchParams.get('keyword') || '', url.searchParams.get('limit') || 200)));
  }

  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)(?:\/(recharge|reset))?$/);
  if (adminUserMatch) {
    return requireAdmin(request, env, async () => handleAdminUser(request, env, store, adminUserMatch));
  }

  if (method === 'POST' && url.pathname === '/api/admin/system/reset-all-users') {
    return requireAdmin(request, env, async () => {
      const body = await readJson(request);
      if (body.confirm !== 'RESET_ALL_USERS') return jsonResponse({ error: '请提供确认口令 RESET_ALL_USERS' }, 400);
      await store.resetAllUserStats();
      return jsonResponse({ success: true, summary: await store.getAdminSummary() });
    });
  }

  if (method === 'GET' && url.pathname === '/api/admin/games') {
    return requireAdmin(request, env, async () => jsonResponse(await store.listGameHistoryAdmin(url.searchParams.get('keyword') || '', url.searchParams.get('limit') || 200)));
  }

  const adminGameMatch = url.pathname.match(/^\/api\/admin\/games\/([^/]+)$/);
  if (adminGameMatch) {
    return requireAdmin(request, env, async () => handleAdminGame(request, store, adminGameMatch[1]));
  }

  if (method === 'POST' && url.pathname === '/api/admin/system/clear-history') {
    return requireAdmin(request, env, async () => {
      const body = await readJson(request);
      if (body.confirm !== 'CLEAR_HISTORY') return jsonResponse({ error: '请提供确认口令 CLEAR_HISTORY' }, 400);
      await store.clearGameHistory();
      return jsonResponse({ success: true, summary: await store.getAdminSummary() });
    });
  }

  const roomAction = url.pathname.match(/^\/api\/admin\/rooms\/([^/]+)\/(stop|remove-member|spectate)$/);
  if (roomAction) {
    return requireAdmin(request, env, async () => {
      const [, roomId, action] = roomAction;
      const body = method === 'GET' ? null : await readJson(request);
      return proxyHubJson(env, `/admin/rooms/${roomId}/${action}`, { method, body });
    });
  }

  const roomDelete = url.pathname.match(/^\/api\/admin\/rooms\/([^/]+)$/);
  if (roomDelete && method === 'DELETE') {
    return requireAdmin(request, env, () => proxyHubJson(env, `/admin/rooms/${roomDelete[1]}`, { method: 'DELETE' }));
  }

  return jsonResponse({ error: '接口不存在' }, 404);
}

async function handleAdminUser(request, env, store, match) {
  const username = decodeURIComponent(match[1]);
  const action = match[2] || null;
  const method = request.method.toUpperCase();
  const existing = await store.findUser(username);
  if (!existing) return jsonResponse({ error: '用户不存在' }, 404);

  if (method === 'GET' && !action) return jsonResponse(await store.getAdminUserDetail(username));
  if (method === 'DELETE' && !action) {
    await store.deleteUser(username);
    return jsonResponse({ success: true });
  }
  if (method === 'POST' && action === 'reset') return jsonResponse(await store.resetUserStats(username));
  if (method === 'POST' && action === 'recharge') {
    const body = await readJson(request);
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0) return jsonResponse({ error: '充值金额必须是大于0的整数' }, 400);
    return jsonResponse(await store.adjustUserScore(username, amount));
  }
  if (method === 'PATCH' && !action) {
    const body = await readJson(request);
    const updates = {};
    for (const field of ['wins', 'losses', 'games_played']) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        const value = Number(body[field]);
        if (!Number.isInteger(value) || value < 0) return jsonResponse({ error: `${field} 必须是大于等于 0 的整数` }, 400);
        updates[field] = value;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'score')) {
      const value = Number(body.score);
      if (!Number.isInteger(value)) return jsonResponse({ error: 'score 必须是整数' }, 400);
      updates.score = value;
    }
    if (typeof body.password === 'string' && body.password.trim()) {
      if (body.password.trim().length < 4) return jsonResponse({ error: '新密码至少4位' }, 400);
      updates.password_hash = await hashPassword(body.password.trim());
    }
    if (typeof body.nickname === 'string') {
      const nickname = normalizeAccountName(body.nickname);
      if (nickname !== (existing.nickname || existing.username)) {
        if (await store.isNameTaken(nickname, username)) return jsonResponse({ error: '昵称已被使用' }, 400);
        updates.nickname = nickname;
        updates.nickname_updated_at = new Date().toISOString();
      }
    }
    const detail = await store.updateUserFields(username, updates);
    if (updates.nickname) await notifyProfileChanged(env, username);
    return jsonResponse(detail);
  }

  return jsonResponse({ error: '接口不存在' }, 404);
}

async function handleAdminGame(request, store, gameId) {
  const method = request.method.toUpperCase();
  const existing = await store.getGameHistoryDetail(gameId);
  if (!existing) return jsonResponse({ error: '对局不存在' }, 404);

  if (method === 'GET') return jsonResponse(existing);
  if (method === 'DELETE') {
    await store.deleteGameHistory(gameId);
    return jsonResponse({ success: true });
  }
  if (method === 'PATCH') {
    const body = await readJson(request);
    const updates = {};
    for (const field of ['room_name', 'landlord', 'hidden_landlord', 'winner', 'winner_team', 'marked_card', 'players', 'scores', 'turn_history', 'initial_hands']) {
      if (Object.prototype.hasOwnProperty.call(body, field)) updates[field] = body[field];
    }
    return jsonResponse(await store.updateGameHistory(gameId, updates));
  }

  return jsonResponse({ error: '接口不存在' }, 404);
}

async function register(request, env, store) {
  const body = await readJson(request);
  const username = normalizeAccountName(body?.username);
  const nickname = normalizeAccountName(body?.nickname) || username;
  const password = typeof body?.password === 'string' ? body.password : '';

  const usernameError = validateAccountName(username, '用户名', env.ADMIN_USERNAME || 'admin');
  if (usernameError) return jsonResponse({ error: usernameError }, 400);
  const nicknameError = validateAccountName(nickname, '昵称', env.ADMIN_USERNAME || 'admin');
  if (nicknameError) return jsonResponse({ error: nicknameError }, 400);
  if (password.length < 4) return jsonResponse({ error: '密码至少4位' }, 400);
  if (await store.findUserByName(username)) return jsonResponse({ error: '用户名已被使用' }, 400);
  if (await store.findUserByName(nickname)) return jsonResponse({ error: '昵称已被使用' }, 400);

  const passwordHash = await hashPassword(password);
  const user = await store.createUser(randomId(16), username, passwordHash, nickname);
  const token = await signToken({ username, id: user.id }, env.JWT_SECRET, USER_TOKEN_SECONDS);
  return jsonResponse({ token, ...buildProfileResponse(user) });
}

async function login(request, env, store) {
  const body = await readJson(request);
  const username = normalizeAccountName(body?.username);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password) return jsonResponse({ error: '用户名和密码不能为空' }, 400);
  if (username === (env.ADMIN_USERNAME || 'admin')) return jsonResponse({ error: '请使用管理员登录入口' }, 403);

  const user = await store.findUser(username);
  if (!user) return jsonResponse({ error: '用户不存在' }, 400);
  if (!await verifyPassword(password, user.password_hash)) return jsonResponse({ error: '密码错误' }, 400);
  await store.updateLastLogin(username);
  const refreshed = await store.findUser(username);
  const token = await signToken({ username, id: user.id }, env.JWT_SECRET, USER_TOKEN_SECONDS);
  return jsonResponse({ token, ...buildProfileResponse(refreshed) });
}

async function updateProfile(request, env, store) {
  return requireUser(request, env, store, async user => {
    const body = await readJson(request);
    const nickname = normalizeAccountName(body?.nickname);
    const nicknameError = validateAccountName(nickname, '昵称', env.ADMIN_USERNAME || 'admin');
    if (nicknameError) return jsonResponse({ error: nicknameError }, 400);
    if (nickname === (user.nickname || user.username)) return jsonResponse(buildProfileResponse(user));
    if (!buildProfileResponse(user).canChangeNicknameThisMonth) {
      return jsonResponse({ error: '昵称每个自然月只能修改1次' }, 400);
    }
    if (await store.isNameTaken(nickname, user.username)) return jsonResponse({ error: '昵称已被使用' }, 400);
    const updated = await store.updateNickname(user.username, nickname, new Date().toISOString());
    await notifyProfileChanged(env, user.username);
    return jsonResponse(buildProfileResponse(updated));
  });
}

async function updateAvatar(request, env, store) {
  return requireUser(request, env, store, async user => {
    const body = await readJson(request);
    const avatarData = body?.avatarData || null;
    const error = validateAvatarData(avatarData);
    if (error) return jsonResponse({ error }, 400);
    const updated = await store.updateAvatar(user.username, avatarData);
    await notifyProfileChanged(env, user.username);
    return jsonResponse(buildProfileResponse(updated));
  });
}

async function notifyProfileChanged(env, username) {
  try {
    await hubJson(env, '/profile-changed', { method: 'POST', body: { username } });
  } catch {
    // 房间资料推送失败不影响资料更新本身
  }
}

async function adminLogin(request, env) {
  const body = await readJson(request);
  const username = normalizeAccountName(body?.username);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (username !== (env.ADMIN_USERNAME || 'admin') || password !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: '管理员账号或密码错误' }, 400);
  }
  const expires = Number(env.ADMIN_TOKEN_EXPIRY_SECONDS || 43200);
  const token = await signToken({ role: 'admin', username }, env.JWT_SECRET, expires);
  return jsonResponse({ token, username });
}

async function getPublicAiSettings(store, env) {
  return {
    ...await store.getAiSettings(),
    llmApiKeyConfigured: Boolean(env.LLM_API_KEY)
  };
}

async function requireUser(request, env, store, handler) {
  const token = getBearerToken(request);
  if (!token) return jsonResponse({ error: '未登录' }, 401);
  try {
    const decoded = await verifyToken(token, env.JWT_SECRET);
    if (!decoded.username || decoded.role === 'admin') return jsonResponse({ error: '没有玩家权限' }, 403);
    const user = await store.findUser(decoded.username);
    if (!user) return jsonResponse({ error: '用户不存在' }, 404);
    return handler(user, decoded);
  } catch {
    return jsonResponse({ error: '登录已失效' }, 401);
  }
}

async function requireAdmin(request, env, handler) {
  const token = getBearerToken(request);
  if (!token) return jsonResponse({ error: '未登录管理员' }, 401);
  try {
    const decoded = await verifyToken(token, env.JWT_SECRET);
    if (decoded.role !== 'admin') return jsonResponse({ error: '没有管理员权限' }, 403);
    return handler(decoded);
  } catch {
    return jsonResponse({ error: '管理员登录已失效' }, 401);
  }
}

function forwardToHub(request, env) {
  const id = env.GAME_HUB.idFromName('global');
  return env.GAME_HUB.get(id).fetch(request);
}

async function hubJson(env, path, options = {}) {
  const id = env.GAME_HUB.idFromName('global');
  const stub = env.GAME_HUB.get(id);
  const response = await stub.fetch(new Request(`https://game-hub.local${path}`, {
    method: options.method || 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined,
    headers: options.body ? { 'content-type': 'application/json' } : {}
  }));
  return response.json();
}

async function proxyHubJson(env, path, options = {}) {
  const data = await hubJson(env, path, options);
  return jsonResponse(data, data?.error ? 400 : 200);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function validateAvatarData(avatarData) {
  if (!avatarData) return null;
  if (typeof avatarData !== 'string') return '头像数据格式无效';
  if (avatarData.length > AVATAR_DATA_MAX_LENGTH) return '头像图片太大，请压缩后再上传';
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarData)) return '仅支持 PNG、JPG 或 WebP 头像';
  return null;
}

function withNoStore(response) {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
