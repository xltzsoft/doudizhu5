const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { GameEngine } = require('./game/engine');
const { AIPlayer } = require('./game/ai');
const userDB = require('./db');

// ============ RATE LIMITER ============
const loginAttempts = new Map(); // IP -> [{timestamp}]
const LOGIN_RATE_LIMIT = { maxAttempts: 5, windowMs: 60000 };

function loginRateLimiter(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || [];
  const recent = attempts.filter(t => now - t < LOGIN_RATE_LIMIT.windowMs);

  if (recent.length >= LOGIN_RATE_LIMIT.maxAttempts) {
    const retryAfter = Math.ceil((recent[0] + LOGIN_RATE_LIMIT.windowMs - now) / 1000);
    return res.status(429).json({ error: `登录尝试过于频繁，请${retryAfter}秒后重试` });
  }

  recent.push(now);
  loginAttempts.set(ip, recent);

  // Cleanup old entries every 10 minutes
  if (Math.random() < 0.01) {
    for (const [key, times] of loginAttempts) {
      const valid = times.filter(t => now - t < LOGIN_RATE_LIMIT.windowMs);
      if (valid.length === 0) loginAttempts.delete(key);
      else loginAttempts.set(key, valid);
    }
  }

  next();
}

function loadEnvConfig() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvConfig();

// Hash admin password on startup if it's not already a bcrypt hash
const ADMIN_PASSWORD_RAW = process.env.ADMIN_PASSWORD || 'ChangeMe_2026';
let ADMIN_PASSWORD_HASH = ADMIN_PASSWORD_RAW;

(async () => {
  if (!ADMIN_PASSWORD_RAW.startsWith('$2a$') && !ADMIN_PASSWORD_RAW.startsWith('$2b$')) {
    ADMIN_PASSWORD_HASH = await bcrypt.hash(ADMIN_PASSWORD_RAW, 10);
    console.log('Admin password has been hashed on startup');
  }
})();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'doudizhu5_secret_key_2026';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_TOKEN_EXPIRY = process.env.ADMIN_TOKEN_EXPIRY || '12h';
const PORT = process.env.PORT || 3000;
const RUNTIME_CONFIG_PATH = path.join(__dirname, 'doudizhu5.config.json');
const AI_DIFFICULTIES = new Set(['easy', 'normal', 'hard']);
const AI_DIFFICULTY_LABELS = {
  easy: '休闲',
  normal: '标准',
  hard: '高级协作'
};
const AVATAR_DATA_MAX_LENGTH = 220 * 1024;
const ACCOUNT_NAME_PATTERN = /^[\w\u4e00-\u9fa5]+$/;
const ACCOUNT_NAME_MIN_LENGTH = 2;
const ACCOUNT_NAME_MAX_LENGTH = 20;
let runtimeConfig = loadRuntimeConfig();

// In-memory storage (rooms only - users are in SQLite)
const rooms = new Map(); // roomId -> Room
const playerSockets = new Map(); // username -> socket
const socketToUser = new Map(); // socketId -> username

function normalizeAiDifficulty(value) {
  return AI_DIFFICULTIES.has(value) ? value : 'normal';
}

function loadRuntimeConfig() {
  const defaults = {
    aiDifficulty: normalizeAiDifficulty(process.env.AI_DIFFICULTY || 'normal')
  };

  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) return defaults;

  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8'));
    return {
      ...defaults,
      aiDifficulty: normalizeAiDifficulty(parsed.aiDifficulty || parsed.ai?.difficulty)
    };
  } catch (error) {
    console.warn('Failed to load runtime config, using defaults:', error.message);
    return defaults;
  }
}

function saveRuntimeConfig() {
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(runtimeConfig, null, 2) + '\n');
}

function getAiSettings() {
  const difficulty = normalizeAiDifficulty(runtimeConfig.aiDifficulty);
  return {
    difficulty,
    label: AI_DIFFICULTY_LABELS[difficulty]
  };
}

function updateAiSettings(payload = {}) {
  runtimeConfig = {
    ...runtimeConfig,
    aiDifficulty: normalizeAiDifficulty(payload.difficulty)
  };
  saveRuntimeConfig();
  return getAiSettings();
}

function normalizeRoomSettings(settings = {}) {
  const baseScore = Number(settings.baseScore ?? settings.scoreMultiplier ?? 10);
  return {
    baseScore: Number.isFinite(baseScore) ? Math.max(1, Math.min(100000, Math.floor(baseScore))) : 10,
    doubleEnabled: Boolean(settings.doubleEnabled),
    allowOpenCards: Boolean(settings.allowOpenCards ?? settings.openCards)
  };
}

function describeRoomSettings(settings = {}, game = null) {
  const normalized = normalizeRoomSettings(settings);
  const effectiveMultiplier = game?.scoreMultiplier || 1;
  const revealedPlayers = Array.isArray(game?.revealedPlayers)
    ? game.revealedPlayers
    : (game?.revealedPlayers ? Array.from(game.revealedPlayers) : []);
  const doubleDecisions = game?.doubleDecisions || {};
  const doubledPlayers = Object.entries(doubleDecisions)
    .filter(([, doubled]) => Boolean(doubled))
    .map(([name]) => name);
  return {
    ...normalized,
    effectiveMultiplier,
    revealedPlayers,
    doubleDecisions,
    doubledPlayers,
    label: `${normalized.baseScore}分底 · ${effectiveMultiplier}倍${normalized.doubleEnabled ? ' · 可加倍' : ''}${normalized.allowOpenCards ? ' · 可明牌' : ''}`
  };
}

function getUserProfileMap(usernames) {
  try {
    return userDB.getUserProfiles(usernames);
  } catch (error) {
    console.warn('Failed to load user profiles:', error.message);
    return {};
  }
}

function getUserProfile(username, profileMap = null) {
  if (!username) return null;
  const profiles = profileMap || getUserProfileMap([username]);
  return profiles[username] || null;
}

function getDisplayName(username, profileMap = null) {
  const profile = getUserProfile(username, profileMap);
  return profile?.displayName || profile?.nickname || username;
}

function getRoomUsernames(room) {
  const names = [];
  for (const player of room.players || []) {
    if (!player) continue;
    if (!player.isAI) names.push(player.username);
    if (player.originalUsername) names.push(player.originalUsername);
  }
  for (const spectator of room.spectators || []) names.push(spectator.username);
  return names;
}

function withRoomProfiles(room, players) {
  const profileMap = getUserProfileMap(getRoomUsernames(room));
  return players.map(player => {
    if (!player) return null;
    const profileName = player.isAI ? player.originalUsername : player.username;
    const profile = getUserProfile(profileName, profileMap);
    return {
      ...player,
      nickname: profile?.nickname || null,
      displayName: player.isAI && profile
        ? `AI托管 ${profile.displayName}`
        : (profile?.displayName || player.username),
      originalDisplayName: player.originalUsername ? getDisplayName(player.originalUsername, profileMap) : null,
      avatarData: profile?.avatarData || null
    };
  });
}

function augmentGameState(room, state) {
  const profileMap = getUserProfileMap(getRoomUsernames(room));
  state.settings = describeRoomSettings(room.settings, room.game);
  const getGameDisplayName = (name) => {
    const seat = room.players.find(player => player && player.username === name);
    if (seat?.isAI && seat.originalUsername) {
      return `AI托管 ${getDisplayName(seat.originalUsername, profileMap)}`;
    }
    return getDisplayName(name, profileMap);
  };
  const getGameAvatarData = (name) => {
    const seat = room.players.find(player => player && player.username === name);
    const profileName = seat?.isAI ? seat.originalUsername : name;
    return getUserProfile(profileName, profileMap)?.avatarData || null;
  };
  state.players = (state.players || []).map(player => {
    const seat = room.players.find(roomPlayer => roomPlayer && roomPlayer.username === player.name);
    const profileName = seat?.isAI ? seat.originalUsername : player.name;
    const profile = getUserProfile(profileName, profileMap);
    return {
      ...player,
      nickname: profile?.nickname || null,
      displayName: getGameDisplayName(player.name),
      originalUsername: seat?.originalUsername || null,
      originalDisplayName: seat?.originalUsername ? getDisplayName(seat.originalUsername, profileMap) : null,
      avatarData: getGameAvatarData(player.name)
    };
  });
  state.playerDisplayNames = Object.fromEntries((state.players || []).map(player => [player.name, player.displayName || player.name]));
  if (state.landlord) state.landlordDisplayName = getGameDisplayName(state.landlord);
  if (state.hiddenLandlord) state.hiddenLandlordDisplayName = getGameDisplayName(state.hiddenLandlord);
  if (state.currentPlayer) state.currentPlayerDisplayName = getGameDisplayName(state.currentPlayer);
  if (state.winner) state.winnerDisplayName = getGameDisplayName(state.winner);
  return state;
}

function normalizeAccountName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateAccountName(value, label = '昵称') {
  if (!value) return `${label}不能为空`;
  if (value.length < ACCOUNT_NAME_MIN_LENGTH || value.length > ACCOUNT_NAME_MAX_LENGTH) {
    return `${label}长度需为2-20字符`;
  }
  if (!ACCOUNT_NAME_PATTERN.test(value)) {
    return `${label}只能包含字母、数字、下划线和中文`;
  }
  if (value === ADMIN_USERNAME) {
    return `${ADMIN_USERNAME} 为后台保留账号`;
  }
  return null;
}

function hasChangedNicknameThisMonth(timestamp, now = new Date()) {
  if (!timestamp) return false;
  const text = String(timestamp).trim();
  const changedAt = text.includes('T')
    ? new Date(text)
    : new Date(`${text.replace(' ', 'T')}Z`);
  if (Number.isNaN(changedAt.getTime())) return false;
  return changedAt.getUTCFullYear() === now.getUTCFullYear()
    && changedAt.getUTCMonth() === now.getUTCMonth();
}

function buildProfileResponse(user) {
  return {
    username: user.username,
    nickname: user.nickname || user.username,
    displayName: user.nickname || user.username,
    id: user.id,
    avatarData: user.avatar_data || null,
    nicknameUpdatedAt: user.nickname_updated_at || null,
    canChangeNicknameThisMonth: !hasChangedNicknameThisMonth(user.nickname_updated_at)
  };
}

function refreshUserPresence(username) {
  const playerPresence = findPlayerRoomByUsername(username) || findRejoinableRoomByUsername(username);
  const spectatorPresence = findSpectatorRoomByUsername(username);
  const roomIds = new Set();
  if (playerPresence?.roomId) roomIds.add(playerPresence.roomId);
  if (spectatorPresence?.roomId) roomIds.add(spectatorPresence.roomId);

  for (const roomId of roomIds) {
    broadcastRoomState(roomId);
    broadcastGameState(roomId);
  }
  broadcastRoomList();
}

function validateAvatarData(avatarData) {
  if (!avatarData) return null;
  if (typeof avatarData !== 'string') return '头像数据格式无效';
  if (avatarData.length > AVATAR_DATA_MAX_LENGTH) return '头像图片太大，请压缩后再上传';
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarData)) {
    return '仅支持 PNG、JPG 或 WebP 头像';
  }
  return null;
}

app.use(express.json({ limit: '512kb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
}));

function getBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

function authenticateAdminRequest(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: '未登录管理员' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: '没有管理员权限' });
    }
    req.admin = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: '管理员登录已失效' });
  }
}

function authenticateUserRequest(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: '未登录' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.username || decoded.role === 'admin') {
      return res.status(403).json({ error: '没有玩家权限' });
    }
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已失效' });
  }
}

function buildLiveRoomSummary(room) {
  const profileMap = getUserProfileMap(getRoomUsernames(room));
  return {
    id: room.id,
    name: room.name,
    owner: room.owner,
    ownerDisplayName: getDisplayName(room.owner, profileMap),
    status: room.status,
    settings: describeRoomSettings(room.settings, room.game),
    humanPlayers: room.players.filter(p => p && !p.isAI).map(p => p.username),
    humanPlayerDetails: room.players.filter(p => p && !p.isAI).map(p => ({
      username: p.username,
      displayName: getDisplayName(p.username, profileMap)
    })),
    aiPlayers: room.players.filter(p => p && p.isAI).map(p => p.username),
    playerDetails: room.players.map(player => player ? {
      username: player.username,
      displayName: player.isAI && player.originalUsername
        ? `AI托管 ${getDisplayName(player.originalUsername, profileMap)}`
        : getDisplayName(player.username, profileMap),
      ready: player.ready,
      isAI: player.isAI,
      seatIndex: player.seatIndex,
      originalUsername: player.originalUsername || null,
      originalDisplayName: player.originalUsername ? getDisplayName(player.originalUsername, profileMap) : null,
      rejoinable: Boolean(player.rejoinable)
    } : null),
    spectators: (room.spectators || []).map(spectator => ({
      username: spectator.username,
      displayName: getDisplayName(spectator.username, profileMap)
    })),
    spectatorCount: (room.spectators || []).length,
    pendingSpectateRequests: (room.spectateRequests || []).length
  };
}

function getHumanPlayers(room) {
  return room.players.filter(player => player && !player.isAI);
}

function getReadyHumanCount(room) {
  return getHumanPlayers(room).filter(player => player.ready).length;
}

function canRoomStart(room) {
  const humanPlayers = getHumanPlayers(room);
  return room.status === 'waiting'
    && humanPlayers.length > 0
    && humanPlayers.every(player => player.ready);
}

function cancelDisconnectTimer(room, username) {
  if (room.disconnectTimers && room.disconnectTimers[username]) {
    clearTimeout(room.disconnectTimers[username]);
    delete room.disconnectTimers[username];
  }
}

function cancelPendingAiTakeover(room, username, reason = '玩家已重新连接') {
  const pending = room?.pendingAiTakeovers?.[username];
  if (!pending) return;

  delete room.pendingAiTakeovers[username];
  const reviewerSocket = playerSockets.get(pending.reviewer);
  if (reviewerSocket) {
    reviewerSocket.emit('aiTakeoverRequestCancelled', {
      roomId: pending.roomId,
      requestId: pending.requestId,
      username,
      reason
    });
  }
}

function clearRoomTimers(room) {
  if (room.disconnectTimers) {
    for (const timer of Object.values(room.disconnectTimers)) {
      clearTimeout(timer);
    }
    room.disconnectTimers = {};
  }
  room.pendingAiTakeovers = {};
}

function findPlayerRoomByUsername(username) {
  for (const [roomId, room] of rooms) {
    if (room.players.some(player => player && player.username === username)) {
      return { roomId, room };
    }
  }
  return null;
}

function findRejoinableRoomByUsername(username) {
  for (const [roomId, room] of rooms) {
    const seat = room.players.find(player =>
      player
      && player.isAI
      && player.rejoinable
      && player.originalUsername === username
      && room.status === 'playing'
      && room.game
    );
    if (seat) return { roomId, room, seat };
  }
  return null;
}

function findSpectatorRoomByUsername(username) {
  for (const [roomId, room] of rooms) {
    if ((room.spectators || []).some(spectator => spectator.username === username)) {
      return { roomId, room };
    }
  }
  return null;
}

function buildTakeoverAiName(room, username, seatIndex) {
  const base = `AI_${String(username || `Seat${seatIndex + 1}`).replace(/[^\w\u4e00-\u9fa5]/g, '_')}`.slice(0, 24) || `AI_${seatIndex + 1}`;
  let candidate = base;
  let suffix = 1;

  while (room.players.some((player, index) => index !== seatIndex && player && player.username === candidate)) {
    candidate = `${base}_${suffix++}`;
  }

  return candidate;
}

function transferRoomOwner(room, previousOwner) {
  if (room.owner !== previousOwner) return;

  const nextHuman = room.players.find(player => player && !player.isAI);
  if (nextHuman) {
    room.owner = nextHuman.username;
    return;
  }

  const nextSeat = room.players.find(Boolean);
  room.owner = nextSeat ? nextSeat.username : null;
}

function getRoomRecipients(room, options = {}) {
  const recipients = new Set();

  for (const player of room.players) {
    if (player && !player.isAI) {
      recipients.add(player.username);
    }
  }

  if (options.includeSpectators !== false) {
    for (const spectator of room.spectators || []) {
      recipients.add(spectator.username);
    }
  }

  if (options.includeSpectateRequests) {
    for (const request of room.spectateRequests || []) {
      recipients.add(request.username);
    }
  }

  return recipients;
}

function emitOwnerStartPromptIfNeeded(room, roomId) {
  if (!room) return;

  if (!canRoomStart(room)) {
    room.startPromptShown = false;
    return;
  }

  if (room.startPromptShown) return;

  const ownerSocket = playerSockets.get(room.owner);
  if (!ownerSocket) return;

  room.startPromptShown = true;
  ownerSocket.emit('ownerStartPrompt', {
    roomId,
    roomName: room.name,
    humanPlayerCount: getHumanPlayers(room).length,
    readyHumanCount: getReadyHumanCount(room),
    aiFillCount: room.players.filter(player => player === null).length,
    players: withRoomProfiles(room, room.players.map(player => player ? {
      username: player.username,
      ready: player.ready,
      isAI: player.isAI,
      originalUsername: player.originalUsername || null
    } : null))
  });
}

function notifyRoomRecipients(room, eventName, payload, options = {}) {
  const recipients = getRoomRecipients(room, options);
  for (const username of recipients) {
    const socket = playerSockets.get(username);
    if (socket) {
      socket.emit(eventName, payload);
      if (options.leaveRoomId) {
        socket.leave(options.leaveRoomId);
      }
    }
  }
}

function removeSpectator(room, username, roomId, options = {}) {
  const beforeSpectators = room.spectators?.length || 0;
  const beforeRequests = room.spectateRequests?.length || 0;

  room.spectators = (room.spectators || []).filter(spectator => spectator.username !== username);
  room.spectateRequests = (room.spectateRequests || []).filter(request => request.username !== username);

  const changed = beforeSpectators !== room.spectators.length || beforeRequests !== room.spectateRequests.length;
  if (!changed) return false;

  const targetSocket = options.socket || playerSockets.get(username);
  if (targetSocket && options.leaveSocketRoom !== false) {
    targetSocket.leave(roomId);
  }

  if (options.notify) {
    const socket = targetSocket || playerSockets.get(username);
    if (socket) {
      socket.emit('roomParticipationEnded', {
        roomId,
        mode: 'spectator',
        message: options.message || '你已退出观战'
      });
    }
  }

  if (options.broadcast !== false) {
    broadcastRoomState(roomId);
    broadcastRoomList();
  }

  return true;
}

function closeRoom(roomId, options = {}) {
  const room = rooms.get(roomId);
  if (!room) return false;

  clearRoomTimers(room);
  room.startPromptShown = false;

  if (options.notify !== false) {
    notifyRoomRecipients(room, 'roomClosed', {
      roomId,
      message: options.message || '房间已关闭'
    }, {
      includeSpectators: true,
      includeSpectateRequests: true,
      leaveRoomId: roomId
    });
  }

  rooms.delete(roomId);
  broadcastRoomList();
  return true;
}

function resetRoomAfterInterruptedGame(room, roomId, options = {}) {
  clearRoomTimers(room);
  room.status = 'waiting';
  room.game = null;
  room.startPromptShown = false;

  for (let i = 0; i < room.players.length; i++) {
    const player = room.players[i];
    if (!player) continue;

    if (player.isAI) {
      room.players[i] = null;
      continue;
    }

    room.players[i] = {
      ...player,
      ready: false,
      isAI: false,
      seatIndex: player.seatIndex ?? i
    };
    delete room.players[i].originalUsername;
    delete room.players[i].rejoinable;
  }

  if (room.spectators && room.spectators.length > 0) {
    const spectatorMessage = options.spectatorMessage || options.message || '对局已停止';
    for (const spectator of room.spectators) {
      const socket = playerSockets.get(spectator.username);
      if (socket) {
        socket.emit('gameStopped', {
          roomId,
          spectator: true,
          message: spectatorMessage
        });
        socket.leave(roomId);
      }
    }
  }

  room.spectators = [];
  room.spectateRequests = [];

  if (!room.players.some(player => player && !player.isAI && player.username === room.owner)) {
    const nextHuman = getHumanPlayers(room)[0];
    room.owner = nextHuman ? nextHuman.username : null;
  }

  if (getHumanPlayers(room).length === 0) {
    closeRoom(roomId, {
      message: options.closeMessage || options.message || '房间已关闭'
    });
    return;
  }

  if (options.notifyPlayers !== false) {
    notifyRoomRecipients(room, 'gameStopped', {
      roomId,
      spectator: false,
      message: options.message || '对局已被停止'
    }, {
      includeSpectators: false
    });
  }

  broadcastRoomState(roomId);
  broadcastRoomList();
}

function resumeRoomFlow(room, roomId) {
  if (!room?.game || room.game.gameOver) return;

  if (room.game.phase === 'selectingMarked') {
    const landlordPlayer = room.players.find(player => player && player.username === room.game.landlord);
    if (landlordPlayer?.isAI) {
      setTimeout(() => {
        autoSelectMarkedCards(room, roomId);
      }, 300);
    }
    return;
  }

  if (room.game.phase === 'doubling') {
    autoResolveAiDoubleChoices(room, roomId);
    return;
  }

  if (room.game.phase === 'playing') {
    scheduleAITurn(room, roomId);
  }
}

function chooseAiTakeoverReviewer(room, username) {
  return room.players.find(player =>
    player
    && !player.isAI
    && player.username !== username
    && playerSockets.has(player.username)
  );
}

function requestAiTakeoverConfirmation(room, roomId, username) {
  if (!room?.game || room.status !== 'playing') return false;
  if (playerSockets.has(username)) return false;
  if (!room.players.some(player => player && !player.isAI && player.username === username)) return false;

  if (!room.pendingAiTakeovers) room.pendingAiTakeovers = {};
  if (room.pendingAiTakeovers[username]) return true;

  const reviewer = chooseAiTakeoverReviewer(room, username);
  if (!reviewer) return false;

  const requestId = uuidv4().substring(0, 12);
  room.pendingAiTakeovers[username] = {
    roomId,
    requestId,
    username,
    reviewer: reviewer.username,
    createdAt: Date.now()
  };

  const reviewerSocket = playerSockets.get(reviewer.username);
  reviewerSocket.emit('aiTakeoverRequest', {
    roomId,
    requestId,
    username,
    displayName: getDisplayName(username),
    roomName: room.name,
    message: `${getDisplayName(username)} 已断线，是否确认由 AI 暂时接管该座位？取消则继续等待玩家重连。`
  });
  return true;
}

function requestDisconnectedTakeoverConfirmations(room, roomId) {
  if (!room?.game || room.status !== 'playing') return;
  for (const player of room.players) {
    if (!player || player.isAI) continue;
    if (playerSockets.has(player.username)) continue;
    if (room.disconnectTimers?.[player.username]) continue;
    requestAiTakeoverConfirmation(room, roomId, player.username);
  }
}

function reclaimAiSeat(room, roomId, seat, username, socket) {
  if (!room?.game || !seat?.isAI || seat.originalUsername !== username) return false;

  const aiName = seat.username;
  if (!room.game.replacePlayerName(aiName, username)) return false;

  seat.username = username;
  seat.ready = true;
  seat.isAI = false;
  delete seat.originalUsername;
  delete seat.rejoinable;
  cancelDisconnectTimer(room, username);
  cancelPendingAiTakeover(room, username);

  const ownerSeat = room.players.find(player => player && player.username === room.owner);
  if (!ownerSeat || ownerSeat.isAI || room.owner === aiName) {
    room.owner = username;
  }

  socket.join(roomId);
  io.to(roomId).emit('chatMessage', { username: '系统', message: `${getDisplayName(username)} 已接回自己的座位` });
  broadcastRoomState(roomId);
  broadcastGameState(roomId);
  broadcastRoomList();
  resumeRoomFlow(room, roomId);
  requestDisconnectedTakeoverConfirmations(room, roomId);
  return true;
}

function replacePlayerWithAi(room, username, roomId, options = {}) {
  const seatIndex = room.players.findIndex(player => player && player.username === username);
  if (seatIndex === -1 || !room.game) return false;

  const player = room.players[seatIndex];
  if (!player || player.isAI) return false;

  const aiName = buildTakeoverAiName(room, username, seatIndex);
  const renamed = room.game.replacePlayerName(username, aiName);
  if (!renamed) return false;

  cancelDisconnectTimer(room, username);
  cancelPendingAiTakeover(room, username, '该座位已由 AI 接管');

  room.players[seatIndex] = {
    ...player,
    username: aiName,
    ready: true,
    isAI: true,
    originalUsername: username,
    rejoinable: Boolean(options.rejoinable),
    seatIndex: player.seatIndex ?? seatIndex
  };

  transferRoomOwner(room, username);

  if (options.announce !== false) {
    io.to(roomId).emit('chatMessage', {
      username: '系统',
      message: options.message || `${getDisplayName(username)} 已离开，AI 接管该座位`
    });
  }

  const hasRejoinableSeat = room.players.some(player =>
    player && player.isAI && player.rejoinable && player.originalUsername
  );
  if (getHumanPlayers(room).length === 0 && !hasRejoinableSeat) {
    closeRoom(roomId, {
      message: options.closeMessage || '所有真人已离开，房间已关闭'
    });
    return true;
  }

  broadcastRoomState(roomId);
  broadcastRoomList();
  resumeRoomFlow(room, roomId);
  return true;
}

function removeWaitingPlayer(room, username, roomId) {
  const seatIndex = room.players.findIndex(player => player && player.username === username);
  if (seatIndex === -1) return false;

  cancelDisconnectTimer(room, username);
  room.players[seatIndex] = null;
  transferRoomOwner(room, username);
  room.startPromptShown = false;

  if (getHumanPlayers(room).length === 0) {
    closeRoom(roomId, {
      message: '房间已关闭'
    });
    return true;
  }

  broadcastRoomState(roomId);
  broadcastRoomList();
  return true;
}

function releaseUserPresence(socket, username, targetRoomId = null) {
  const spectatorPresence = findSpectatorRoomByUsername(username);
  if (spectatorPresence && spectatorPresence.roomId !== targetRoomId) {
    removeSpectator(spectatorPresence.room, username, spectatorPresence.roomId, {
      socket,
      leaveSocketRoom: true
    });
  }

  const playerPresence = findPlayerRoomByUsername(username);
  if (!playerPresence || playerPresence.roomId === targetRoomId) {
    return;
  }

  const { roomId, room } = playerPresence;
  socket.leave(roomId);

  if (room.status === 'playing' && room.game) {
    replacePlayerWithAi(room, username, roomId, {
      rejoinable: false,
      message: `${getDisplayName(username)} 已切换到其他房间，AI 接管该座位`
    });
    return;
  }

  removeWaitingPlayer(room, username, roomId);
}

// ============ AUTH API ============
app.post('/api/register', async (req, res) => {
  const username = normalizeAccountName(req.body?.username);
  const nickname = normalizeAccountName(req.body?.nickname) || username;
  const { password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: '参数类型错误' });
  const usernameError = validateAccountName(username, '用户名');
  if (usernameError) return res.status(400).json({ error: usernameError });
  const nicknameError = validateAccountName(nickname, '昵称');
  if (nicknameError) return res.status(400).json({ error: nicknameError });
  if (password.length < 4) return res.status(400).json({ error: '密码至少4位' });
  
  if (userDB.findUserByName(username)) return res.status(400).json({ error: '用户名已被使用' });
  if (userDB.findUserByName(nickname)) return res.status(400).json({ error: '昵称已被使用' });

  const passwordHash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  try {
    userDB.createUser(id, username, passwordHash, nickname);
  } catch (e) {
    return res.status(400).json({ error: '注册失败' });
  }
  const token = jwt.sign({ username, id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username, nickname, displayName: nickname, id, avatarData: null, nicknameUpdatedAt: null, canChangeNicknameThisMonth: true });
});

app.post('/api/login', loginRateLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username === ADMIN_USERNAME) return res.status(403).json({ error: '请使用管理员登录入口' });
  const user = userDB.findUser(username);
  if (!user) return res.status(400).json({ error: '用户不存在' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(400).json({ error: '密码错误' });

  userDB.updateLastLogin(username);
  const token = jwt.sign({ username, id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, ...buildProfileResponse(userDB.findUser(username)) });
});

app.get('/api/profile', authenticateUserRequest, (req, res) => {
  const user = userDB.findUser(req.user.username);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(buildProfileResponse(user));
});

app.patch('/api/profile', authenticateUserRequest, (req, res) => {
  const user = userDB.findUser(req.user.username);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const nickname = normalizeAccountName(req.body?.nickname);
  const nicknameError = validateAccountName(nickname, '昵称');
  if (nicknameError) return res.status(400).json({ error: nicknameError });
  if (nickname === (user.nickname || user.username)) return res.json(buildProfileResponse(user));
  if (hasChangedNicknameThisMonth(user.nickname_updated_at)) {
    return res.status(400).json({ error: '昵称每个自然月只能修改1次' });
  }
  if (userDB.isNameTaken(nickname, user.username)) {
    return res.status(400).json({ error: '昵称已被使用' });
  }

  const updated = userDB.updateNickname(user.username, nickname, new Date().toISOString());
  refreshUserPresence(user.username);
  res.json(buildProfileResponse(updated));
});

app.post('/api/profile/avatar', authenticateUserRequest, (req, res) => {
  const avatarData = req.body?.avatarData || null;
  const error = validateAvatarData(avatarData);
  if (error) return res.status(400).json({ error });

  const user = userDB.updateAvatar(req.user.username, avatarData);
  res.json(buildProfileResponse(user));
});

// ============ ADMIN API ============
app.post('/api/admin/login', loginRateLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '管理员账号和密码不能为空' });
  }
  if (username !== ADMIN_USERNAME) {
    return res.status(400).json({ error: '管理员账号或密码错误' });
  }

  const valid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!valid) {
    return res.status(400).json({ error: '管理员账号或密码错误' });
  }

  const token = jwt.sign({ role: 'admin', username: ADMIN_USERNAME }, JWT_SECRET, { expiresIn: ADMIN_TOKEN_EXPIRY });
  res.json({ token, username: ADMIN_USERNAME });
});

app.get('/api/admin/overview', authenticateAdminRequest, (req, res) => {
  const summary = userDB.getAdminSummary() || {};
  const liveRooms = Array.from(rooms.values()).map(buildLiveRoomSummary);
  res.json({
    userCount: Number(summary.user_count || 0),
    totalScore: Number(summary.total_score || 0),
    totalGamesPlayed: Number(summary.total_games_played || 0),
    historyCount: Number(summary.history_count || 0),
    onlineUsers: playerSockets.size,
    roomCount: liveRooms.length,
    waitingRooms: liveRooms.filter(room => room.status === 'waiting').length,
    playingRooms: liveRooms.filter(room => room.status === 'playing').length,
    finishedRooms: liveRooms.filter(room => room.status === 'finished').length,
    aiSettings: getAiSettings(),
    liveRooms
  });
});

app.get('/api/admin/ai-settings', authenticateAdminRequest, (req, res) => {
  res.json(getAiSettings());
});

app.patch('/api/admin/ai-settings', authenticateAdminRequest, (req, res) => {
  const difficulty = req.body?.difficulty;
  if (!AI_DIFFICULTIES.has(difficulty)) {
    return res.status(400).json({ error: 'AI难度只能是 easy、normal 或 hard' });
  }

  res.json(updateAiSettings({ difficulty }));
});

app.get('/api/admin/rooms/:roomId/spectate', authenticateAdminRequest, (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: '房间不存在' });
  }

  let gameState = null;
  if (room.game) {
    gameState = augmentGameState(room, room.game.getStateForSpectator());
    gameState.cardCounter = room.game.getCardCounter();
  }

  res.json({
    room: buildLiveRoomSummary(room),
    roomState: buildRoomState(room),
    gameState
  });
});

app.post('/api/admin/rooms/:roomId/stop', authenticateAdminRequest, (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: '房间不存在' });
  }

  if (!room.game || (room.status !== 'playing' && room.status !== 'finished')) {
    return res.status(400).json({ error: '当前房间没有可停止的对局' });
  }

  resetRoomAfterInterruptedGame(room, roomId, {
    message: '对局已被管理员停止',
    spectatorMessage: '当前对局已被管理员停止，观战已结束',
    closeMessage: '对局已被管理员停止，房间已关闭'
  });

  res.json({
    success: true,
    closed: !rooms.has(roomId),
    room: rooms.has(roomId) ? buildLiveRoomSummary(rooms.get(roomId)) : null
  });
});

app.delete('/api/admin/rooms/:roomId', authenticateAdminRequest, (req, res) => {
  const roomId = req.params.roomId;
  if (!rooms.has(roomId)) {
    return res.status(404).json({ error: '房间不存在' });
  }

  closeRoom(roomId, {
    message: '房间已被管理员删除'
  });

  res.json({ success: true });
});

app.post('/api/admin/rooms/:roomId/remove-member', authenticateAdminRequest, (req, res) => {
  const roomId = req.params.roomId;
  const target = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!target) {
    return res.status(400).json({ error: '请输入要移出的用户名' });
  }

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: '房间不存在' });
  }

  if ((room.spectators || []).some(spectator => spectator.username === target)) {
    removeSpectator(room, target, roomId, {
      notify: true,
      message: '你已被管理员移出观战'
    });
    return res.json({
      success: true,
      mode: 'spectator',
      closed: !rooms.has(roomId),
      room: rooms.has(roomId) ? buildLiveRoomSummary(rooms.get(roomId)) : null
    });
  }

  const player = room.players.find(seat => seat && seat.username === target);
  if (!player) {
    return res.status(404).json({ error: '房间内没有该成员' });
  }

  const targetSocket = playerSockets.get(target);
  if (targetSocket) {
    targetSocket.emit('roomParticipationEnded', {
      roomId,
      mode: 'player',
      message: room.status === 'playing'
        ? '你已被管理员移出对局，AI 将接管你的座位'
        : '你已被管理员移出房间'
    });
    targetSocket.leave(roomId);
  }

  if (room.status === 'playing' && room.game) {
    replacePlayerWithAi(room, target, roomId, {
      rejoinable: false,
      message: `${target} 已被管理员移出对局，AI 已接管座位`,
      closeMessage: '房间内已没有真人玩家，房间已关闭'
    });
  } else {
    removeWaitingPlayer(room, target, roomId);
  }

  res.json({
    success: true,
    mode: 'player',
    closed: !rooms.has(roomId),
    room: rooms.has(roomId) ? buildLiveRoomSummary(rooms.get(roomId)) : null
  });
});

app.get('/api/admin/users', authenticateAdminRequest, (req, res) => {
  const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : '';
  const limit = Number(req.query.limit) || 200;
  res.json(userDB.listUsers(keyword, limit));
});

app.get('/api/admin/users/:username', authenticateAdminRequest, (req, res) => {
  const detail = userDB.getAdminUserDetail(req.params.username);
  if (!detail) return res.status(404).json({ error: '用户不存在' });
  res.json(detail);
});

app.patch('/api/admin/users/:username', authenticateAdminRequest, async (req, res) => {
  const username = req.params.username;
  const existing = userDB.findUser(username);
  if (!existing) return res.status(404).json({ error: '用户不存在' });

  const updates = {};
  const numericFields = ['wins', 'losses', 'games_played', 'score'];
  for (const field of numericFields) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      const value = Number(req.body[field]);
      if (!Number.isInteger(value) || value < 0) {
        return res.status(400).json({ error: `${field} 必须是大于等于 0 的整数` });
      }
      updates[field] = value;
    }
  }

  if (typeof req.body?.password === 'string' && req.body.password.trim()) {
    if (req.body.password.trim().length < 4) {
      return res.status(400).json({ error: '新密码至少4位' });
    }
    updates.password_hash = await bcrypt.hash(req.body.password.trim(), 10);
  }

  if (typeof req.body?.nickname === 'string') {
    const nickname = normalizeAccountName(req.body.nickname);
    const nicknameError = validateAccountName(nickname, '昵称');
    if (nicknameError) return res.status(400).json({ error: nicknameError });
    if (nickname !== (existing.nickname || existing.username)) {
      if (userDB.isNameTaken(nickname, username)) {
        return res.status(400).json({ error: '昵称已被使用' });
      }
      updates.nickname = nickname;
      updates.nickname_updated_at = new Date().toISOString();
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: '没有可更新的字段' });
  }

  const detail = userDB.updateUserFields(username, updates);
  refreshUserPresence(username);
  res.json(detail);
});

app.post('/api/admin/users/:username/recharge', authenticateAdminRequest, (req, res) => {
  const username = req.params.username;
  const existing = userDB.findUser(username);
  if (!existing) return res.status(404).json({ error: '用户不存在' });

  const amount = Number(req.body?.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: '充值金额必须是大于0的整数' });
  }

  const detail = userDB.adjustUserScore(username, amount);
  res.json(detail);
});

app.post('/api/admin/users/:username/reset', authenticateAdminRequest, (req, res) => {
  const username = req.params.username;
  const existing = userDB.findUser(username);
  if (!existing) return res.status(404).json({ error: '用户不存在' });
  const detail = userDB.resetUserStats(username);
  res.json(detail);
});

app.delete('/api/admin/users/:username', authenticateAdminRequest, (req, res) => {
  const username = req.params.username;
  const existing = userDB.findUser(username);
  if (!existing) return res.status(404).json({ error: '用户不存在' });

  const activeRoom = Array.from(rooms.values()).find(room => room.players.some(p => p && p.username === username));
  if (activeRoom) {
    return res.status(400).json({ error: '该用户当前正在房间中，无法删除' });
  }

  userDB.deleteUser(username);
  res.json({ success: true });
});

app.post('/api/admin/system/reset-all-users', authenticateAdminRequest, (req, res) => {
  if (req.body?.confirm !== 'RESET_ALL_USERS') {
    return res.status(400).json({ error: '请提供确认口令 RESET_ALL_USERS' });
  }
  userDB.resetAllUserStats();
  res.json({ success: true, summary: userDB.getAdminSummary() });
});

app.get('/api/admin/games', authenticateAdminRequest, (req, res) => {
  const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : '';
  const limit = Number(req.query.limit) || 200;
  res.json(userDB.listGameHistoryAdmin(keyword, limit));
});

app.get('/api/admin/games/:id', authenticateAdminRequest, (req, res) => {
  const detail = userDB.getGameHistoryDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: '对局不存在' });
  res.json(detail);
});

app.patch('/api/admin/games/:id', authenticateAdminRequest, (req, res) => {
  const gameId = req.params.id;
  const existing = userDB.getGameHistoryDetail(gameId);
  if (!existing) return res.status(404).json({ error: '对局不存在' });

  const updates = {};
  const body = req.body || {};
  const stringFields = ['room_name', 'landlord', 'hidden_landlord', 'winner', 'marked_card'];

  for (const field of stringFields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      if (body[field] !== '' && typeof body[field] !== 'string') {
        return res.status(400).json({ error: `${field} 必须是字符串` });
      }
      updates[field] = body[field] || '';
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'winner_team')) {
    if (body.winner_team !== 'landlord' && body.winner_team !== 'farmer' && body.winner_team !== '') {
      return res.status(400).json({ error: 'winner_team 只能是 landlord、farmer 或空字符串' });
    }
    updates.winner_team = body.winner_team;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'players')) {
    if (!Array.isArray(body.players)) {
      return res.status(400).json({ error: 'players 必须是数组' });
    }
    updates.players = body.players;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'scores')) {
    if (!body.scores || typeof body.scores !== 'object' || Array.isArray(body.scores)) {
      return res.status(400).json({ error: 'scores 必须是对象' });
    }
    updates.scores = body.scores;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'turn_history')) {
    if (!Array.isArray(body.turn_history)) {
      return res.status(400).json({ error: 'turn_history 必须是数组' });
    }
    updates.turn_history = body.turn_history;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'initial_hands')) {
    if (body.initial_hands !== null && (!body.initial_hands || typeof body.initial_hands !== 'object' || Array.isArray(body.initial_hands))) {
      return res.status(400).json({ error: 'initial_hands 必须是对象或 null' });
    }
    updates.initial_hands = body.initial_hands;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: '没有可更新的字段' });
  }

  const detail = userDB.updateGameHistory(gameId, updates);
  res.json(detail);
});

app.delete('/api/admin/games/:id', authenticateAdminRequest, (req, res) => {
  const existing = userDB.getGameHistoryDetail(req.params.id);
  if (!existing) return res.status(404).json({ error: '对局不存在' });
  userDB.deleteGameHistory(req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/system/clear-history', authenticateAdminRequest, (req, res) => {
  if (req.body?.confirm !== 'CLEAR_HISTORY') {
    return res.status(400).json({ error: '请提供确认口令 CLEAR_HISTORY' });
  }
  userDB.clearGameHistory();
  res.json({ success: true, summary: userDB.getAdminSummary() });
});

// ============ STATS API ============
app.get('/api/leaderboard', (req, res) => {
  res.json(userDB.getLeaderboard());
});

app.get('/api/stats/:username', (req, res) => {
  const stats = userDB.getUserStats(req.params.username);
  if (!stats) return res.status(404).json({ error: '用户不存在' });
  res.json(stats);
});

// ============ GAME HISTORY API ============
app.get('/api/history', (req, res) => {
  res.json(userDB.getGameHistoryList());
});

app.get('/api/history/:id', (req, res) => {
  const detail = userDB.getGameHistoryDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: '对局不存在' });
  res.json(detail);
});

// ============ ROOM API ============
app.get('/api/rooms', (req, res) => {
  const list = [];
  for (const [id, room] of rooms) {
    const profileMap = getUserProfileMap(getRoomUsernames(room));
    list.push({
      id,
      name: room.name,
      owner: room.owner,
      ownerDisplayName: getDisplayName(room.owner, profileMap),
      playerCount: room.players.filter(p => p && !p.isAI).length,
      maxPlayers: 5,
      status: room.status,
      settings: describeRoomSettings(room.settings, room.game),
      spectatorCount: (room.spectators || []).length,
      rejoinablePlayers: room.players
        .filter(p => p && p.isAI && p.rejoinable && p.originalUsername)
        .map(p => p.originalUsername)
    });
  }
  res.json(list);
});

// ============ SOCKET.IO ============
function authenticateSocket(socket, next) {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('未登录'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (e) {
    next(new Error('认证失败'));
  }
}

io.use(authenticateSocket);

io.on('connection', (socket) => {
  const username = socket.user.username;
  playerSockets.set(username, socket);
  socketToUser.set(socket.id, username);
  console.log(`${username} connected`);

  // Auto-rejoin room if player was in one
  try {
    const playerPresence = findPlayerRoomByUsername(username);
    if (playerPresence) {
      const { roomId, room } = playerPresence;
      socket.join(roomId);
      cancelDisconnectTimer(room, username);
      cancelPendingAiTakeover(room, username);
      broadcastRoomState(roomId);
      if (room.game && room.status === 'playing') {
        emitPlayerGameState(socket, room, roomId, username);
        requestDisconnectedTakeoverConfirmations(room, roomId);
      } else if (room.game && room.status === 'finished' && room.finalResult) {
        socket.emit('gameOver', room.finalResult);
      }
    } else {
      const rejoinablePresence = findRejoinableRoomByUsername(username);
      if (rejoinablePresence) {
        reclaimAiSeat(rejoinablePresence.room, rejoinablePresence.roomId, rejoinablePresence.seat, username, socket);
      }
    }
  } catch (e) {
    console.error('Auto-rejoin error:', e.message);
  }

  // Create room
  socket.on('createRoom', (data, callback) => {
    if (typeof callback !== 'function') return;
    try {
      releaseUserPresence(socket, username);

      const roomName = (typeof data?.name === 'string' && data.name.trim())
        ? data.name.trim().substring(0, 30)
        : `${getDisplayName(username)}的房间`;
      const roomId = uuidv4().substring(0, 8);
      const roomSettings = normalizeRoomSettings(data?.settings || {});
      const room = {
        id: roomId,
        name: roomName,
        owner: username,
        players: [
          { username, ready: false, isAI: false, seatIndex: 0 },
          null, null, null, null
        ],
        status: 'waiting',
        game: null,
        spectators: [],
        spectateRequests: [],
        disconnectTimers: {},
        pendingAiTakeovers: {},
        startPromptShown: false,
        settings: roomSettings
      };
      rooms.set(roomId, room);
      socket.join(roomId);
      callback({ success: true, roomId });
      broadcastRoomList();
      broadcastRoomState(roomId);
    } catch (e) {
      console.error('createRoom error:', e);
      callback({ success: false, error: '创建房间失败' });
    }
  });

  // Join room
  socket.on('joinRoom', (data, callback) => {
    if (typeof callback !== 'function') return;
    if (typeof data?.roomId !== 'string') return callback({ success: false, error: '房间ID无效' });
    const room = rooms.get(data.roomId);
    if (!room) return callback({ success: false, error: '房间不存在' });

    releaseUserPresence(socket, username, data.roomId);

    const existingSeat = room.players.find(player => player && player.username === username);
    if (existingSeat) {
      socket.join(data.roomId);
      callback({ success: true, roomId: data.roomId, status: room.status });
      broadcastRoomState(data.roomId);
      if (room.game && room.status === 'playing') {
        emitPlayerGameState(socket, room, data.roomId, username);
        requestDisconnectedTakeoverConfirmations(room, data.roomId);
      } else if (room.game && room.status === 'finished' && room.finalResult) {
        socket.emit('gameOver', room.finalResult);
      }
      return;
    }

    const reclaimableSeat = room.players.find(player =>
      player
      && player.isAI
      && player.originalUsername === username
      && player.rejoinable
      && room.game
    );
    if (reclaimableSeat && reclaimAiSeat(room, data.roomId, reclaimableSeat, username, socket)) {
      callback({ success: true, roomId: data.roomId, status: room.status, rejoined: true, message: '已回到对局' });
      return;
    }

    if (room.status !== 'waiting') return callback({ success: false, error: '房间已开局' });

    const emptySlot = room.players.findIndex(player => player === null);
    if (emptySlot === -1) return callback({ success: false, error: '房间已满' });

    room.players[emptySlot] = { username, ready: false, isAI: false, seatIndex: emptySlot };
    room.startPromptShown = false;
    socket.join(data.roomId);
    callback({ success: true, roomId: data.roomId });
    broadcastRoomState(data.roomId);
    broadcastRoomList();
  });

  socket.on('updateRoomSettings', (data, callback) => {
    if (typeof data?.roomId !== 'string') {
      if (typeof callback === 'function') callback({ success: false, error: '房间ID无效' });
      return;
    }

    const room = rooms.get(data.roomId);
    if (!room) {
      if (typeof callback === 'function') callback({ success: false, error: '房间不存在' });
      return;
    }
    if (room.owner !== username || room.status !== 'waiting') {
      if (typeof callback === 'function') callback({ success: false, error: '只有房主可在开局前修改设置' });
      return;
    }

    room.settings = normalizeRoomSettings(data.settings || {});
    room.startPromptShown = false;
    broadcastRoomState(data.roomId);
    broadcastRoomList();
    if (typeof callback === 'function') callback({ success: true, settings: describeRoomSettings(room.settings) });
  });

  // Leave room
  socket.on('leaveRoom', (data, callback) => {
    if (typeof data?.roomId !== 'string') {
      if (typeof callback === 'function') {
        callback({ success: false, error: '房间ID无效' });
      }
      return;
    }

    const room = rooms.get(data.roomId);
    if (!room) {
      if (typeof callback === 'function') {
        callback({ success: true });
      }
      return;
    }

    if ((room.spectators || []).some(spectator => spectator.username === username)) {
      removeSpectator(room, username, data.roomId, {
        socket,
        leaveSocketRoom: true
      });
      if (typeof callback === 'function') {
        callback({ success: true, mode: 'spectator' });
      }
      return;
    }

    const player = room.players.find(seat => seat && seat.username === username);
    if (!player) {
      if (typeof callback === 'function') {
        callback({ success: true });
      }
      return;
    }

    socket.leave(data.roomId);

    if (room.status === 'playing' && room.game) {
      const success = replacePlayerWithAi(room, username, data.roomId, {
        rejoinable: true,
        message: `${getDisplayName(username)} 已退出对局，AI 将接管座位`
      });
      if (typeof callback === 'function') {
        callback({ success, mode: 'playing' });
      }
      return;
    }

    removeWaitingPlayer(room, username, data.roomId);
    if (typeof callback === 'function') {
      callback({ success: true, mode: room.status === 'finished' ? 'finished' : 'waiting' });
    }
  });

  // Kick player (only in waiting state)
  socket.on('kickPlayer', (data) => {
    if (typeof data?.roomId !== 'string' || typeof data?.target !== 'string') return;
    const room = rooms.get(data.roomId);
    if (!room || room.owner !== username || room.status !== 'waiting') return;
    if (data.target === username) return;

    const targetSeat = room.players.find(player => player && player.username === data.target);
    if (!targetSeat) return;

    const targetSocket = playerSockets.get(data.target);
    if (targetSocket) {
      targetSocket.emit('roomParticipationEnded', {
        roomId: data.roomId,
        mode: 'player',
        message: '你已被房主移出房间'
      });
      targetSocket.leave(data.roomId);
    }

    removeWaitingPlayer(room, data.target, data.roomId);
  });

  // Ready
  socket.on('ready', (data) => {
    const room = rooms.get(data.roomId);
    if (!room || room.status !== 'waiting') return;
    const player = room.players.find(seat => seat && seat.username === username);
    if (!player) return;
    player.ready = !player.ready;
    room.startPromptShown = false;
    broadcastRoomState(data.roomId);
    emitOwnerStartPromptIfNeeded(room, data.roomId);
  });

  // Manual start (owner only)
  socket.on('startGame', (data, callback) => {
    const room = rooms.get(data.roomId);
    if (!room || room.owner !== username || room.status !== 'waiting') {
      if (typeof callback === 'function') {
        callback({ success: false, error: '只有房主可以开始游戏' });
      }
      return;
    }

    if (!canRoomStart(room)) {
      if (typeof callback === 'function') {
        callback({ success: false, error: '请等待所有真人玩家准备完成' });
      }
      return;
    }

    room.startPromptShown = false;
    startGame(room, data.roomId);
    if (typeof callback === 'function') {
      callback({ success: true });
    }
  });

  // Play cards
  socket.on('playCards', (data) => {
    if (!data?.roomId || !Array.isArray(data?.cards)) return;
    const room = rooms.get(data.roomId);
    if (!room || !room.game) return;
    const result = room.game.playCards(username, data.cards);
    if (result.success) {
      broadcastGameState(data.roomId);
      if (result.gameOver) {
        handleGameOver(room, data.roomId, result);
      } else {
        scheduleAITurn(room, data.roomId);
      }
    } else {
      socket.emit('playError', { error: result.error });
    }
  });

  // Select marked cards (landlord picks 2 same-suit-same-rank cards)
  socket.on('selectMarkedCards', (data) => {
    if (!data?.roomId || !Array.isArray(data?.cards)) return;
    const room = rooms.get(data.roomId);
    if (!room || !room.game) return;
    if (room.game.landlord !== username) {
      socket.emit('playError', { error: '只有地主可以选择明牌' });
      return;
    }
    const result = room.game.selectMarkedCards(data.cards);
    if (result.success) {
      broadcastGameState(data.roomId);
      resumeRoomFlow(room, data.roomId);
    } else {
      socket.emit('playError', { error: result.error });
    }
  });

  // Pass
  socket.on('pass', (data) => {
    if (!data?.roomId) return;
    const room = rooms.get(data.roomId);
    if (!room || !room.game) return;
    // Verify player is in room
    if (!room.players.some(p => p && p.username === username)) return;
    const result = room.game.pass(username);
    if (result.success) {
      broadcastGameState(data.roomId);
      if (result.newRound) {
        // New round, current player can play anything
      }
      scheduleAITurn(room, data.roomId);
    } else {
      socket.emit('playError', { error: result.error });
    }
  });

  // Chat
  socket.on('chat', (data) => {
    if (typeof data?.message !== 'string' || !data?.roomId) return;
    const room = rooms.get(data.roomId);
    if (!room) return;
    const msg = data.message.substring(0, 200); // Limit length
    io.to(data.roomId).emit('chatMessage', { username, displayName: getDisplayName(username), message: msg });
  });

  // Hint
  socket.on('getHint', (data, callback) => {
    if (typeof callback !== 'function') return;
    if (!data?.roomId) return callback({ hints: [] });
    const room = rooms.get(data.roomId);
    if (!room || !room.game) return callback({ hints: [] });
    if (room.game.getCurrentPlayer() !== username) return callback({ hints: [] });
    const hints = room.game.getHints(username, { difficulty: getAiSettings().difficulty });
    callback({ hints });
  });

  socket.on('chooseDouble', (data, callback) => {
    if (typeof data?.roomId !== 'string') {
      if (typeof callback === 'function') callback({ success: false, error: '房间ID无效' });
      return;
    }

    const room = rooms.get(data.roomId);
    if (!room || !room.game || room.status !== 'playing') {
      if (typeof callback === 'function') callback({ success: false, error: '当前不能选择加倍' });
      return;
    }
    if (!normalizeRoomSettings(room.settings).doubleEnabled) {
      if (typeof callback === 'function') callback({ success: false, error: '房主未开启加倍' });
      return;
    }
    if (!room.players.some(player => player && player.username === username)) {
      if (typeof callback === 'function') callback({ success: false, error: '只有本局玩家可以选择加倍' });
      return;
    }

    const result = room.game.chooseDouble(username, Boolean(data.doubled));
    if (!result.success) {
      if (typeof callback === 'function') callback(result);
      return;
    }

    broadcastGameState(data.roomId);
    broadcastRoomState(data.roomId);
    broadcastRoomList();
    resumeRoomFlow(room, data.roomId);
    if (typeof callback === 'function') callback(result);
  });

  socket.on('revealHand', (data, callback) => {
    if (typeof data?.roomId !== 'string') {
      if (typeof callback === 'function') callback({ success: false, error: '房间ID无效' });
      return;
    }

    const room = rooms.get(data.roomId);
    if (!room || !room.game || room.status !== 'playing') {
      if (typeof callback === 'function') callback({ success: false, error: '当前不能明牌' });
      return;
    }
    if (!normalizeRoomSettings(room.settings).allowOpenCards) {
      if (typeof callback === 'function') callback({ success: false, error: '房主未开启主动明牌' });
      return;
    }
    if (!room.players.some(player => player && player.username === username)) {
      if (typeof callback === 'function') callback({ success: false, error: '只有本局玩家可以明牌' });
      return;
    }

    const result = room.game.revealHand(username);
    if (!result.success) {
      if (typeof callback === 'function') callback(result);
      return;
    }

    io.to(data.roomId).emit('chatMessage', {
      username: '系统',
      message: result.multiplierApplied
        ? `${getDisplayName(username)} 选择明牌，明牌倍数为5倍，当前总倍数 ${result.scoreMultiplier} 倍`
        : `${getDisplayName(username)} 选择明牌，手牌已公开；因本局已有出牌记录，本次明牌不再加倍`
    });
    broadcastGameState(data.roomId);
    broadcastRoomState(data.roomId);
    broadcastRoomList();
    if (typeof callback === 'function') callback(result);
  });

  socket.on('respondAiTakeover', (data, callback) => {
    if (typeof data?.roomId !== 'string' || typeof data?.requestId !== 'string') {
      if (typeof callback === 'function') callback({ success: false, error: '请求无效' });
      return;
    }

    const room = rooms.get(data.roomId);
    const pendingEntries = Object.entries(room?.pendingAiTakeovers || {});
    const entry = pendingEntries.find(([, item]) => item.requestId === data.requestId);
    if (!room || !entry) {
      if (typeof callback === 'function') callback({ success: false, error: '请求已失效' });
      return;
    }

    const [targetUsername, pending] = entry;
    if (pending.reviewer !== username) {
      if (typeof callback === 'function') callback({ success: false, error: '只有收到弹窗的玩家可以处理该请求' });
      return;
    }

    delete room.pendingAiTakeovers[targetUsername];

    if (!data.accept) {
      io.to(data.roomId).emit('chatMessage', {
        username: '系统',
        message: `${getDisplayName(username)} 选择继续等待 ${getDisplayName(targetUsername)} 重连`
      });
      if (typeof callback === 'function') callback({ success: true, accepted: false });
      return;
    }

    if (playerSockets.has(targetUsername)) {
      if (typeof callback === 'function') callback({ success: true, accepted: false, message: '玩家已重新连接' });
      return;
    }

    const success = replacePlayerWithAi(room, targetUsername, data.roomId, {
      rejoinable: true,
      message: `${getDisplayName(targetUsername)} 断线后经 ${getDisplayName(username)} 确认，AI 已接管座位`,
      closeMessage: '房间内已没有真人玩家，房间已关闭'
    });

    if (typeof callback === 'function') {
      callback(success ? { success: true, accepted: true } : { success: false, error: 'AI 接管失败' });
    }
  });

  socket.on('settleGame', (data, callback) => {
    if (typeof data?.roomId !== 'string') {
      if (typeof callback === 'function') callback({ success: false, error: '房间ID无效' });
      return;
    }

    const room = rooms.get(data.roomId);
    if (!room) {
      if (typeof callback === 'function') callback({ success: true, closed: true });
      return;
    }
    if (room.status !== 'finished') {
      if (typeof callback === 'function') callback({ success: false, error: '当前没有待结算的对局' });
      return;
    }

    const isPlayer = room.players.some(player => player && !player.isAI && player.username === username);
    if (!isPlayer) {
      if (typeof callback === 'function') callback({ success: false, error: '只有房间玩家可以结算对局' });
      return;
    }

    const success = settleFinishedRoom(room, data.roomId);
    if (typeof callback === 'function') callback({ success, closed: !rooms.has(data.roomId) });
  });

  // ============ SPECTATOR SYSTEM ============
  // Request to spectate
  socket.on('requestSpectate', (data, callback) => {
    if (typeof callback !== 'function') return;
    if (typeof data?.roomId !== 'string') return callback({ success: false, error: '房间ID无效' });
    const room = rooms.get(data.roomId);
    if (!room) return callback({ success: false, error: '房间不存在' });

    if (room.players.some(player => player && player.username === username)) {
      return callback({ success: false, error: '你已经在当前房间中，无需申请观战' });
    }

    const reclaimableSeat = room.players.find(player =>
      player && player.isAI && player.rejoinable && player.originalUsername === username
    );
    if (reclaimableSeat && reclaimAiSeat(room, data.roomId, reclaimableSeat, username, socket)) {
      return callback({ success: true, rejoined: true, message: '已回到对局' });
    }

    releaseUserPresence(socket, username, data.roomId);

    if ((room.spectators || []).some(spectator => spectator.username === username)) {
      return callback({ success: false, error: '你已经在观战中' });
    }

    if ((room.spectateRequests || []).some(request => request.username === username)) {
      return callback({ success: false, error: '你已经提交过观战申请' });
    }

    room.spectateRequests.push({ username });

    const ownerSocket = playerSockets.get(room.owner);
    if (ownerSocket) {
      ownerSocket.emit('spectateRequest', {
        roomId: data.roomId,
        requester: username,
        requesterDisplayName: getDisplayName(username)
      });
    }

    broadcastRoomState(data.roomId);
    broadcastRoomList();
    callback({ success: true, message: '观战申请已提交，等待房主确认' });
  });

  // Approve spectate request (owner only)
  socket.on('approveSpectate', (data) => {
    if (typeof data?.roomId !== 'string' || typeof data?.requester !== 'string') return;
    const room = rooms.get(data.roomId);
    if (!room || room.owner !== username) return;

    const reqIdx = room.spectateRequests.findIndex(request => request.username === data.requester);
    if (reqIdx === -1) return;

    room.spectateRequests.splice(reqIdx, 1);
    if (!(room.spectators || []).some(spectator => spectator.username === data.requester)) {
      room.spectators.push({ username: data.requester });
    }

    const requesterSocket = playerSockets.get(data.requester);
    if (requesterSocket) {
      releaseUserPresence(requesterSocket, data.requester, data.roomId);
      requesterSocket.join(data.roomId);
      requesterSocket.emit('spectateApproved', { roomId: data.roomId, roomName: room.name });

      if (room.game && room.status === 'playing') {
        const spectatorState = augmentGameState(room, room.game.getStateForSpectator());
        spectatorState.roomId = data.roomId;
        spectatorState.roundId = room.roundId;
        spectatorState.cardCounter = room.game.getCardCounter();
        requesterSocket.emit('spectatorGameState', spectatorState);
      }
    }

    broadcastRoomState(data.roomId);
    broadcastRoomList();
  });

  // Deny spectate request (owner only)
  socket.on('denySpectate', (data) => {
    if (typeof data?.roomId !== 'string' || typeof data?.requester !== 'string') return;
    const room = rooms.get(data.roomId);
    if (!room || room.owner !== username) return;

    const reqIdx = room.spectateRequests.findIndex(request => request.username === data.requester);
    if (reqIdx === -1) return;
    room.spectateRequests.splice(reqIdx, 1);

    const requesterSocket = playerSockets.get(data.requester);
    if (requesterSocket) {
      requesterSocket.emit('spectateDenied', { roomId: data.roomId });
    }

    broadcastRoomState(data.roomId);
    broadcastRoomList();
  });

  // Leave spectating
  socket.on('leaveSpectate', (data, callback) => {
    if (typeof data?.roomId !== 'string') {
      if (typeof callback === 'function') {
        callback({ success: false, error: '房间ID无效' });
      }
      return;
    }

    const room = rooms.get(data.roomId);
    if (!room) {
      if (typeof callback === 'function') {
        callback({ success: true });
      }
      return;
    }

    removeSpectator(room, username, data.roomId, {
      socket,
      leaveSocketRoom: true
    });

    if (typeof callback === 'function') {
      callback({ success: true });
    }
  });

  // Get card counter (spectators only)
  socket.on('getCardCounter', (data, callback) => {
    if (typeof callback !== 'function') return;
    if (typeof data?.roomId !== 'string') return callback({ counter: null });
    const room = rooms.get(data.roomId);
    if (!room || !room.game) return callback({ counter: null });
    if (!(room.spectators || []).some(spectator => spectator.username === username)) return callback({ counter: null });
    callback({ counter: room.game.getCardCounter() });
  });

  socket.on('disconnect', () => {
    playerSockets.delete(username);
    socketToUser.delete(socket.id);

    const spectatorPresence = findSpectatorRoomByUsername(username);
    if (spectatorPresence) {
      removeSpectator(spectatorPresence.room, username, spectatorPresence.roomId, {
        leaveSocketRoom: false
      });
    }

    const playerPresence = findPlayerRoomByUsername(username);
    if (!playerPresence) {
      return;
    }

    const { roomId, room } = playerPresence;
    if (room.status === 'finished' && room.game) {
      return;
    }

    if (room.status === 'waiting' || !room.game) {
      removeWaitingPlayer(room, username, roomId);
      return;
    }

    if (room.status === 'playing') {
      const timer = setTimeout(() => {
        if (room.disconnectTimers) {
          delete room.disconnectTimers[username];
        }
        const seat = room.players.find(player => player && player.username === username);
        if (seat && !seat.isAI && !playerSockets.has(username)) {
          const requested = requestAiTakeoverConfirmation(room, roomId, username);
          if (requested) {
            io.to(roomId).emit('chatMessage', {
              username: '系统',
              message: `${getDisplayName(username)} 已断线，正在等待在线玩家确认是否由 AI 接管`
            });
          }
        }
      }, 30000);

      if (!room.disconnectTimers) room.disconnectTimers = {};
      cancelDisconnectTimer(room, username);
      room.disconnectTimers[username] = timer;
    }
  });

  // Reconnect to room
  socket.on('reconnect', (data, callback) => {
    if (typeof callback !== 'function') return;
    const room = rooms.get(data.roomId);
    if (!room) return callback({ success: false });

    let player = room.players.find(seat => seat && seat.username === username);
    if (!player) {
      player = room.players.find(seat => seat && seat.isAI && seat.originalUsername === username && seat.rejoinable);
    }
    if (!player) return callback({ success: false });

    cancelDisconnectTimer(room, username);
    cancelPendingAiTakeover(room, username);

    if (player.isAI) {
      const success = reclaimAiSeat(room, data.roomId, player, username, socket);
      return callback({ success });
    }

    socket.join(data.roomId);
    callback({ success: true });
    if (room.game && room.status === 'playing') {
      emitPlayerGameState(socket, room, data.roomId, username);
      requestDisconnectedTakeoverConfirmations(room, data.roomId);
    }
    broadcastRoomState(data.roomId);
  });
});

function startGame(room, roomId) {
  room.startPromptShown = false;
  room.roundId = uuidv4().substring(0, 8);

  for (let i = 0; i < 5; i++) {
    if (!room.players[i]) {
      room.players[i] = {
        username: `AI_${i + 1}`,
        ready: true,
        isAI: true,
        seatIndex: i
      };
      continue;
    }

    room.players[i].ready = true;
    delete room.players[i].originalUsername;
    delete room.players[i].rejoinable;
  }

  room.status = 'playing';
  room.settings = normalizeRoomSettings(room.settings);
  room.finalResult = null;
  const playerNames = room.players.map(player => player.username);
  room.game = new GameEngine(playerNames, {
    baseScore: room.settings.baseScore,
    doubleEnabled: room.settings.doubleEnabled
  });
  room.game.deal();
  broadcastRoomState(roomId);
  broadcastGameState(roomId);
  broadcastRoomList();
  resumeRoomFlow(room, roomId);
}

function scheduleAITurn(room, roomId) {
  if (!room.game || room.game.gameOver) return;
  if (room.game.phase !== 'playing') return;
  const currentPlayer = room.game.getCurrentPlayer();
  const playerInfo = room.players.find(p => p && p.username === currentPlayer);
  if (playerInfo && playerInfo.isAI) {
    setTimeout(async () => {
      await doAITurn(room, roomId);
    }, 1000 + Math.random() * 1000);
  }
}

function autoSelectMarkedCards(room, roomId) {
  if (!room.game || room.game.phase !== 'selectingMarked') return;
  const options = room.game.getMarkedCardOptions();
  if (options.length === 0) {
    // No valid pairs, skip (shouldn't happen with 3 decks, but fallback: start playing without hidden landlord)
    room.game.startDoublingIfNeeded();
    broadcastGameState(roomId);
    resumeRoomFlow(room, roomId);
    return;
  }
  // AI picks random option
  const choice = options[Math.floor(Math.random() * options.length)];
  // Find 2 cards with that id in landlord's hand
  const hand = room.game.hands[room.game.landlord];
  const matching = hand.filter(c => c.id === choice.id);
  const result = room.game.selectMarkedCards([matching[0].uid, matching[1].uid]);
  if (result.success) {
    broadcastGameState(roomId);
    resumeRoomFlow(room, roomId);
  }
}

function autoResolveAiDoubleChoices(room, roomId) {
  if (!room.game || room.game.phase !== 'doubling') return;

  let changed = false;
  for (const player of room.players) {
    if (!player?.isAI) continue;
    if (Object.prototype.hasOwnProperty.call(room.game.doubleDecisions, player.username)) continue;
    const shouldDouble = shouldAiDouble(room, player.username);
    const result = room.game.chooseDouble(player.username, shouldDouble);
    changed = changed || result.success;
  }

  if (changed) {
    broadcastGameState(roomId);
    broadcastRoomState(roomId);
    broadcastRoomList();
  }

  if (room.game.phase === 'playing') {
    scheduleAITurn(room, roomId);
  }
}

function shouldAiDouble(room, aiName) {
  const difficulty = getAiSettings().difficulty;
  const hand = room.game?.hands?.[aiName] || [];
  if (difficulty === 'easy') return false;
  const strongCards = hand.filter(card => card.value >= 15).length;
  const bombCount = Object.values(room.game._groupByValue(hand)).filter(cards => cards.length >= 4).length;
  const threshold = difficulty === 'hard' ? 2 : 4;
  return strongCards + bombCount * 2 >= threshold;
}

async function doAITurn(room, roomId) {
  if (!room.game || room.game.gameOver) return;
  const currentPlayer = room.game.getCurrentPlayer();
  const playerInfo = room.players.find(p => p && p.username === currentPlayer);
  if (!playerInfo || !playerInfo.isAI) return;

  const aiSettings = getAiSettings();
  const state = room.game.getStateForPlayer(currentPlayer);
  state.aiDifficulty = aiSettings.difficulty;
  state.hints = room.game.getHints(currentPlayer, { difficulty: aiSettings.difficulty });
  const ai = new AIPlayer(aiSettings);

  try {
    const decision = await ai.decide(state);
    // Re-check after async: game may have ended or room changed
    if (!room.game || room.game.gameOver) return;
    if (room.game.getCurrentPlayer() !== currentPlayer) return;

    let result;
    if (decision.action === 'pass') {
      result = room.game.pass(currentPlayer);
    } else {
      result = room.game.playCards(currentPlayer, decision.cards);
      // If AI play fails, try pass
      if (!result.success) {
        result = room.game.pass(currentPlayer);
      }
    }

    if (result.success) {
      broadcastGameState(roomId);
      if (result.gameOver) {
        handleGameOver(room, roomId, result);
      } else {
        scheduleAITurn(room, roomId);
      }
    }
  } catch (e) {
    console.error('AI error:', e);
    // Re-check after async
    if (!room.game || room.game.gameOver) return;
    if (room.game.getCurrentPlayer() !== currentPlayer) return;
    // AI fallback: try to play smallest card or pass
    const fallbackResult = room.game.pass(currentPlayer);
    if (fallbackResult.success) {
      broadcastGameState(roomId);
      scheduleAITurn(room, roomId);
    }
  }
}

function buildGameOverPayload(room, roomId, result) {
  const spectatorState = room.game ? augmentGameState(room, room.game.getStateForSpectator()) : null;
  return {
    roomId,
    roundId: room.roundId,
    winner: result.winner,
    winnerTeam: result.winnerTeam,
    scores: result.scores,
    settings: describeRoomSettings(room.settings, room.game),
    lastPlay: spectatorState?.lastPlay || null,
    players: spectatorState?.players || [],
    finalHands: spectatorState?.allHands || {}
  };
}

function settleFinishedRoom(room, roomId) {
  if (!room || room.status !== 'finished') return false;

  clearRoomTimers(room);
  room.status = 'waiting';
  room.game = null;
  room.finalResult = null;
  room.startPromptShown = false;

  for (let i = 0; i < room.players.length; i++) {
    const player = room.players[i];
    if (!player) continue;

    if (player.isAI) {
      room.players[i] = null;
      continue;
    }

    room.players[i].ready = false;
    delete room.players[i].originalUsername;
    delete room.players[i].rejoinable;
  }

  if (room.spectators) {
    for (const spectator of room.spectators) {
      const spectatorSocket = playerSockets.get(spectator.username);
      if (spectatorSocket) {
        spectatorSocket.emit('spectateEnded', { roomId, roomName: room.name, message: '对局已结算' });
        spectatorSocket.leave(roomId);
      }
    }
    room.spectators = [];
  }

  room.spectateRequests = [];

  if (!room.players.some(player => player && !player.isAI && player.username === room.owner)) {
    const nextHuman = getHumanPlayers(room)[0];
    room.owner = nextHuman ? nextHuman.username : null;
  }

  if (getHumanPlayers(room).length === 0) {
    closeRoom(roomId, { message: '房间内已没有真人玩家' });
    return true;
  }

  broadcastRoomState(roomId);
  broadcastRoomList();
  return true;
}

function handleGameOver(room, roomId, result) {
  room.status = 'finished';
  room.startPromptShown = false;
  clearRoomTimers(room);

  const gameOverPayload = buildGameOverPayload(room, roomId, result);
  room.finalResult = gameOverPayload;

  for (const player of room.players) {
    if (!player || player.isAI) continue;
    const socket = playerSockets.get(player.username);
    if (socket) socket.emit('gameOver', gameOverPayload);
  }

  for (const spectator of room.spectators || []) {
    const socket = playerSockets.get(spectator.username);
    if (socket) socket.emit('spectatorGameOver', gameOverPayload);
  }

  try {
    const gameId = uuidv4().substring(0, 12);
    const players = room.players.map(player => player ? player.username : null);
    userDB.saveGameHistory(
      gameId,
      room.name,
      players,
      room.game.landlord,
      room.game.hiddenLandlord,
      result.winner,
      result.winnerTeam,
      result.scores,
      room.game.turnHistory,
      room.game.markedCard?.id || '',
      room.game.initialHandsSnapshot || null
    );
  } catch (e) {
    console.error('Failed to save game history:', e);
  }

  if (result.scores) {
    for (const [playerName, score] of Object.entries(result.scores)) {
      const playerInfo = room.players.find(player => player && player.username === playerName);
      if (playerInfo && playerInfo.isAI) continue;
      try {
        const won = score > 0 ? 1 : 0;
        const lost = score <= 0 ? 1 : 0;
        userDB.updateStats(playerName, won, lost, score);
      } catch (e) {
        console.error('Failed to update stats for', playerName, e);
      }
    }
  }

  broadcastRoomList();
}

function buildRoomState(room) {
  const players = room.players.map(p => p ? {
    username: p.username,
    ready: p.ready,
    isAI: p.isAI,
    seatIndex: p.seatIndex,
    originalUsername: p.originalUsername || null,
    rejoinable: Boolean(p.rejoinable)
  } : null);

  return {
    id: room.id,
    name: room.name,
    owner: room.owner,
    ownerDisplayName: getDisplayName(room.owner, getUserProfileMap(getRoomUsernames(room))),
    players: withRoomProfiles(room, players),
    status: room.status,
    settings: describeRoomSettings(room.settings, room.game),
    startable: canRoomStart(room),
    humanPlayerCount: getHumanPlayers(room).length,
    readyHumanCount: getReadyHumanCount(room),
    emptySeatCount: room.players.filter(player => player === null).length,
    spectators: withRoomProfiles(room, (room.spectators || []).map(s => ({ username: s.username, isAI: false }))),
    spectateRequests: withRoomProfiles(room, (room.spectateRequests || []).map(r => ({ username: r.username, isAI: false })))
  };
}

function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = buildRoomState(room);
  const recipients = getRoomRecipients(room);

  for (const recipient of recipients) {
    const socket = playerSockets.get(recipient);
    if (socket) socket.emit('roomState', payload);
  }

  emitOwnerStartPromptIfNeeded(room, roomId);
}

function emitPlayerGameState(socket, room, roomId, username) {
  if (!socket || !room?.game) return;
  const state = augmentGameState(room, room.game.getStateForPlayer(username));
  state.roomId = roomId;
  state.roundId = room.roundId;
  socket.emit('gameState', state);
}

function broadcastGameState(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.game) return;
  
  for (const p of room.players) {
    if (!p || p.isAI) continue;
    const socket = playerSockets.get(p.username);
    if (socket) {
      emitPlayerGameState(socket, room, roomId, p.username);
    }
  }

  // Send spectator state
  if (room.spectators && room.spectators.length > 0) {
    const spectatorState = augmentGameState(room, room.game.getStateForSpectator());
    spectatorState.roomId = roomId;
    spectatorState.roundId = room.roundId;
    spectatorState.cardCounter = room.game.getCardCounter();
    for (const s of room.spectators) {
      const socket = playerSockets.get(s.username);
      if (socket) {
        socket.emit('spectatorGameState', spectatorState);
      }
    }
  }
}

function broadcastRoomList() {
  const list = [];
  for (const [id, room] of rooms) {
    const profileMap = getUserProfileMap(getRoomUsernames(room));
    list.push({
      id,
      name: room.name,
      owner: room.owner,
      ownerDisplayName: getDisplayName(room.owner, profileMap),
      playerCount: room.players.filter(p => p && !p.isAI).length,
      maxPlayers: 5,
      status: room.status,
      settings: describeRoomSettings(room.settings, room.game),
      spectatorCount: (room.spectators || []).length
    });
  }
  io.emit('roomList', list);
}

(async () => {
  await userDB.init();
  server.listen(PORT, () => {
    console.log(`斗地主服务器运行在 http://localhost:${PORT}`);
  });
})();
