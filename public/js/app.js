/* ============================================
   五人斗地主 - 前端逻辑
   ============================================ */

let socket = null;
let currentUser = null;
let currentRoom = null;
let selectedCards = new Set();
let gameState = null;
let hintList = [];
let hintIndex = -1;
let isSpectating = false;
let spectatingRoomId = null;
let pendingSpectateRequest = null;
let pendingAiTakeoverRequest = null;
let lastGameOverMode = 'player';
let pendingSettlementRoomId = null;
const ADMIN_USERNAME = 'admin';
const HAND_MODE_STORAGE_KEY = 'doudizhu_hand_mode';
const CUSTOM_HAND_ZONES_KEY = 'doudizhu_custom_hand_zones';
const USER_AVATAR_STORAGE_KEY = 'doudizhu_avatar';
const USER_NICKNAME_STORAGE_KEY = 'doudizhu_nickname';
const ROOM_CONTEXT_STORAGE_KEY = 'doudizhu_room_context';
let handDisplayMode = localStorage.getItem(HAND_MODE_STORAGE_KEY) || 'flat';
let customHandZones = loadCustomHandZones();
let lastConnectionToastAt = 0;
let restoreInFlight = false;
let pendingInviteRoomId = null;

// ============ SCREENS ============
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  // Chat UI: only show on game screen
  if (screenId === 'gameScreen') {
    showChatUI();
  } else {
    hideChatUI();
  }
}

function getRoomPlayerNames(state) {
  return (state?.players || []).filter(Boolean).map(p => p.username);
}

function getEntityUsername(entity) {
  if (!entity) return '';
  return typeof entity === 'string' ? entity : (entity.username || entity.name || '');
}

// 服务器（Cloudflare 版）通过 roomProfiles 事件一次性推送房间内玩家的昵称和头像，
// 客户端缓存后用于渲染，避免每次状态广播都携带大体积头像数据。
const remoteProfileCache = {}; // username -> { displayName, avatarData }

function mergeRemoteProfiles(profiles) {
  for (const [username, profile] of Object.entries(profiles || {})) {
    if (!username || !profile) continue;
    remoteProfileCache[username] = {
      displayName: profile.displayName || username,
      avatarData: profile.avatarData || null
    };
  }
}

function getCachedProfile(username) {
  return username ? remoteProfileCache[username] || null : null;
}

function rerenderProfileDependentViews(roomId) {
  if (currentRoom && (!roomId || currentRoom.id === roomId)) {
    renderRoomState(currentRoom);
  }
  if (gameState && (!roomId || gameState.roomId === roomId)) {
    if (isSpectating || gameState.isSpectator) renderSpectatorState(gameState);
    else renderGameState(gameState);
  }
}

function getDisplayName(entity, fallback = '') {
  if (!entity) return fallback;
  if (typeof entity === 'string') {
    return getCachedProfile(entity)?.displayName || gameState?.playerDisplayNames?.[entity] || entity;
  }
  if (entity.isAI && entity.originalUsername) {
    const original = getCachedProfile(entity.originalUsername)?.displayName || entity.originalDisplayName || entity.originalUsername;
    return `AI托管 ${original}`;
  }
  const cached = getCachedProfile(getEntityUsername(entity))?.displayName;
  return cached || entity.displayName || entity.nickname || entity.name || entity.username || fallback;
}

function getGameDisplayName(username, state = gameState) {
  return state?.playerDisplayNames?.[username] || username;
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(String(value).includes('T') ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function notifyRoomMemberChanges(prevState, nextState) {
  if (!prevState || !nextState || prevState.id !== nextState.id) return;
  const prevNames = new Set(getRoomPlayerNames(prevState));
  const nextNames = new Set(getRoomPlayerNames(nextState));

  for (const name of nextNames) {
    if (!prevNames.has(name) && name !== currentUser?.username) {
      const player = (nextState.players || []).find(p => p && p.username === name);
      showToast(`${getDisplayName(player, name)} 加入了房间`);
    }
  }
  for (const name of prevNames) {
    if (!nextNames.has(name) && name !== currentUser?.username) {
      const player = (prevState.players || []).find(p => p && p.username === name);
      showToast(`${getDisplayName(player, name)} 离开了房间`);
    }
  }
}

function getInviteRoomIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return (params.get('room') || params.get('invite') || '').trim();
}

function clearInviteParamsFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('room') && !url.searchParams.has('invite')) return;
  url.searchParams.delete('room');
  url.searchParams.delete('invite');
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

function rememberRoomContext(roomId, mode = 'player') {
  if (!roomId) return;
  localStorage.setItem(ROOM_CONTEXT_STORAGE_KEY, JSON.stringify({
    roomId,
    mode,
    updatedAt: Date.now()
  }));
}

function clearRoomContext() {
  localStorage.removeItem(ROOM_CONTEXT_STORAGE_KEY);
}

function getRememberedRoomContext() {
  try {
    const raw = localStorage.getItem(ROOM_CONTEXT_STORAGE_KEY);
    if (!raw) return null;
    const context = JSON.parse(raw);
    if (!context?.roomId) return null;
    if (Date.now() - Number(context.updatedAt || 0) > 24 * 60 * 60 * 1000) {
      clearRoomContext();
      return null;
    }
    return context;
  } catch (error) {
    clearRoomContext();
    return null;
  }
}

function getRoomInviteUrl(roomId) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', roomId);
  return url.toString();
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

async function copyRoomInviteLink(roomId = currentRoom?.id) {
  if (!roomId) return showToast('当前没有可邀请的房间');
  try {
    await copyTextToClipboard(getRoomInviteUrl(roomId));
    showToast('邀请链接已复制，好友打开后可直接加入');
  } catch (error) {
    showToast('复制失败，请手动复制房间号');
  }
}

function showConnectionToast(message, force = false) {
  const now = Date.now();
  if (!force && now - lastConnectionToastAt < 1800) return;
  lastConnectionToastAt = now;
  showToast(message);
}

// ============ AUTH ============
function showRegister() {
  document.getElementById('loginForm').classList.add('hidden');
  document.getElementById('registerForm').classList.remove('hidden');
  document.getElementById('authError').classList.add('hidden');
}

function showLogin() {
  document.getElementById('registerForm').classList.add('hidden');
  document.getElementById('loginForm').classList.remove('hidden');
  document.getElementById('authError').classList.add('hidden');
}

function showAuthError(msg) {
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function isAdminUsername(username) {
  return username === ADMIN_USERNAME;
}

function redirectToAdminDashboard(token, username) {
  if (socket) socket.disconnect();
  currentUser = null;
  currentRoom = null;
  clearRoomContext();
  localStorage.removeItem('doudizhu_token');
  localStorage.removeItem('doudizhu_user');
  localStorage.setItem('doudizhu_admin_token', token);
  localStorage.setItem('doudizhu_admin_user', username);
  window.location.replace('/admin.html');
}

async function register() {
  const username = document.getElementById('regUsername').value.trim();
  const nickname = document.getElementById('regNickname').value.trim() || username;
  const password = document.getElementById('regPassword').value;
  if (!username || !password) return showAuthError('请填写所有字段');
  if (isAdminUsername(username)) return showAuthError('admin 为后台保留账号，不能注册为普通玩家');

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, nickname, password })
    });
    const data = await res.json();
    if (!res.ok) return showAuthError(data.error);
    onLoginSuccess(data);
  } catch (e) {
    showAuthError('网络错误');
  }
}

async function login() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!username || !password) return showAuthError('请填写所有字段');

  if (isAdminUsername(username)) {
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) return showAuthError(data.error);
      redirectToAdminDashboard(data.token, data.username);
      return;
    } catch (e) {
      showAuthError('网络错误');
      return;
    }
  }

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) return showAuthError(data.error);
    onLoginSuccess(data);
  } catch (e) {
    showAuthError('网络错误');
  }
}

function onLoginSuccess(data) {
  currentUser = {
    username: data.username,
    nickname: data.nickname || data.displayName || data.username,
    displayName: data.displayName || data.nickname || data.username,
    nicknameUpdatedAt: data.nicknameUpdatedAt || null,
    canChangeNicknameThisMonth: data.canChangeNicknameThisMonth !== false,
    token: data.token,
    id: data.id,
    avatarData: data.avatarData || null
  };
  localStorage.setItem('doudizhu_token', data.token);
  localStorage.setItem('doudizhu_user', data.username);
  localStorage.setItem(USER_NICKNAME_STORAGE_KEY, currentUser.nickname || data.username);
  if (data.avatarData) {
    localStorage.setItem(USER_AVATAR_STORAGE_KEY, data.avatarData);
  } else {
    localStorage.removeItem(USER_AVATAR_STORAGE_KEY);
  }
  connectSocket();
  showScreen('lobbyScreen');
  updateUserBadge();
  refreshRooms();
  loadUserStats();
  loadProfile();
  handleInviteFromUrl();
}

function logout() {
  if (socket) socket.disconnect();
  currentUser = null;
  currentRoom = null;
  pendingAiTakeoverRequest = null;
  pendingInviteRoomId = null;
  clearRoomContext();
  localStorage.removeItem('doudizhu_token');
  localStorage.removeItem('doudizhu_user');
  localStorage.removeItem(USER_NICKNAME_STORAGE_KEY);
  localStorage.removeItem(USER_AVATAR_STORAGE_KEY);
  showScreen('authScreen');
}

function isAuthFailureMessage(message) {
  return /认证失败|未登录|登录已失效|jwt expired|invalid token/i.test(String(message || ''));
}

function handleAuthExpired(message = '登录状态已失效，请重新登录') {
  if (socket) {
    const activeSocket = socket;
    socket = null;
    activeSocket.disconnect();
  }

  hideStartPrompt();
  hideGameOver();
  resetSpectatorUI();
  clearSelectionState();
  currentUser = null;
  currentRoom = null;
  gameState = null;
  isSpectating = false;
  spectatingRoomId = null;
  pendingAiTakeoverRequest = null;
  pendingInviteRoomId = null;
  clearRoomContext();
  localStorage.removeItem('doudizhu_token');
  localStorage.removeItem('doudizhu_user');
  localStorage.removeItem(USER_AVATAR_STORAGE_KEY);
  showScreen('authScreen');
  showAuthError(message);
}

// ============ LOBBY ============
async function refreshRooms() {
  try {
    const res = await fetch('/api/rooms');
    const rooms = await res.json();
    renderRoomList(rooms);
  } catch (e) {
    console.error('Failed to refresh rooms');
  }
}

function renderRoomList(rooms) {
  const container = document.getElementById('roomList');
  if (rooms.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🃏</div>
      <p>暂无房间，创建一个开始游戏吧！</p>
    </div>`;
    return;
  }

  container.innerHTML = rooms.map(room => {
    const statusText = room.status === 'waiting' ? '等待中' : room.status === 'finished' ? '待结算' : '游戏中';
    const statusClass = room.status === 'playing' ? 'playing' : '';
    const canJoin = room.status === 'waiting' && room.playerCount < 5;
    const canRejoin = room.status === 'playing'
      && currentUser
      && Array.isArray(room.rejoinablePlayers)
      && room.rejoinablePlayers.includes(currentUser.username);
    return `
    <div class="room-item ${statusClass}">
      <div class="room-item-info">
        <div class="room-item-title">
          <h3>${escapeHtml(room.name)}</h3>
          <span class="room-id-tag">#${room.id}</span>
        </div>
        <p>房主: ${escapeHtml(room.ownerDisplayName || room.owner)} · ${escapeHtml(room.settings?.label || '1倍')}</p>
      </div>
      <div class="room-item-meta">
        <span class="player-count-badge">${room.playerCount}<span class="count-sep">/</span>5</span>
        ${room.spectatorCount ? `<span class="spectator-count">👁 ${room.spectatorCount}</span>` : ''}
        <span class="status-tag ${statusClass}">${statusText}</span>
      </div>
      <div class="room-item-actions">
        ${canJoin ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();joinRoom('${room.id}')">加入房间</button>` : ''}
        ${canRejoin ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();joinRoom('${room.id}')">回到对局</button>` : ''}
        ${room.status === 'playing' && !canRejoin ? `<button class="btn btn-spectate btn-sm" onclick="event.stopPropagation();requestSpectate('${room.id}')">观战</button>` : ''}
        ${room.status === 'waiting' && room.playerCount >= 5 ? `<span class="room-full-tag">已满</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function showCreateRoom() {
  document.getElementById('createRoomModal').classList.remove('hidden');
  document.getElementById('roomName').value = '';
  document.getElementById('roomBaseScore').value = '10';
  document.getElementById('roomDoubleEnabled').checked = false;
  document.getElementById('roomOpenCards').checked = false;
  document.getElementById('roomName').focus();
}

function hideCreateRoom() {
  document.getElementById('createRoomModal').classList.add('hidden');
}

function createRoom() {
  const name = document.getElementById('roomName').value.trim() || `${getDisplayName(currentUser, currentUser.username)}的房间`;
  const settings = {
    baseScore: Number(document.getElementById('roomBaseScore').value) || 10,
    doubleEnabled: document.getElementById('roomDoubleEnabled').checked,
    allowOpenCards: document.getElementById('roomOpenCards').checked
  };
  if (!socket || !socket.connected) {
    showToast('尚未连接到服务器，正在重连...');
    if (socket) socket.connect();
    return;
  }
  socket.emit('createRoom', { name, settings }, (res) => {
    if (res.success) {
      if (res.roomId) {
        rememberRoomContext(res.roomId, 'player');
        copyRoomInviteLink(res.roomId);
      }
      hideCreateRoom();
      showScreen('roomScreen');
    } else {
      showToast(res.error || '创建房间失败');
    }
  });
}

function joinRoom(roomId) {
  if (!roomId) return;
  if (!socket || !socket.connected) {
    rememberRoomContext(roomId, 'player');
    showConnectionToast('尚未连接到服务器，正在重连...');
    if (socket) socket.connect();
    return;
  }
  socket.emit('joinRoom', { roomId }, (res) => {
    if (res.success) {
      rememberRoomContext(res.roomId || roomId, 'player');
      if (res.rejoined && res.message) {
        showToast(res.message);
      }
      // If game is already playing, gameState event will switch to game screen
      // Otherwise show room screen
      if (res.status !== 'playing') {
        showScreen('roomScreen');
      }
    } else {
      showToast(res.error);
      if (/不存在|已关闭|已删除/.test(String(res.error || ''))) clearRoomContext();
    }
  });
}

function toggleReady() {
  if (currentRoom) {
    socket.emit('ready', { roomId: currentRoom.id });
  }
}

function kickPlayer(username) {
  const player = (currentRoom?.players || []).find(item => item && item.username === username);
  if (currentRoom && confirm(`确定踢出 ${getDisplayName(player, username)} 吗？`)) {
    socket.emit('kickPlayer', { roomId: currentRoom.id, target: username });
  }
}

// ============ GAME ============
let isPlayingCards = false;

function playSelected() {
  if (isPlayingCards) return;
  if (selectedCards.size === 0) return showToast('请先选择要出的牌');
  if (!currentRoom) return;

  isPlayingCards = true;
  // Send uid array to server
  const cards = sortSelectedUidsForPlay(Array.from(selectedCards));
  socket.emit('playCards', { roomId: currentRoom.id, cards }, (res) => {
    if (res?.success === false) {
      isPlayingCards = false;
      showToast(res.error || '出牌失败，请重试');
    }
  });
  // Don't clear selectedCards yet - wait for server gameState response
}

function getHint() {
  if (!currentRoom || !gameState?.isMyTurn) return;

  if (hintList.length > 0) {
    // Cycle through hints
    hintIndex = (hintIndex + 1) % hintList.length;
    applyHint(hintList[hintIndex]);
    return;
  }

  socket.emit('getHint', { roomId: currentRoom.id }, (res) => {
    if (res.hints && res.hints.length > 0) {
      hintList = res.hints;
      hintIndex = 0;
      applyHint(hintList[0]);
    } else {
      showToast('\u6ca1\u6709\u53ef\u51fa\u7684\u724c');
    }
  });
}

function showGameOver(data) {
  if (data?.roomId && currentRoom?.id && data.roomId !== currentRoom.id) return;
  if (data?.roundId && gameState?.roundId && data.roundId !== gameState.roundId) return;

  pendingSettlementRoomId = data?.roomId || currentRoom?.id || null;
  if (currentRoom && pendingSettlementRoomId === currentRoom.id) {
    currentRoom = { ...currentRoom, status: 'finished' };
  }
  showScreen('gameScreen');

  const overlay = document.getElementById('gameOverlay');
  overlay.classList.remove('hidden');

  const title = document.getElementById('gameOverTitle');
  const spectatorView = Boolean(data.spectator || gameState?.isSpectator || isSpectating);
  lastGameOverMode = spectatorView ? 'spectator' : 'player';
  if (spectatorView) {
    title.textContent = '对局结束';
    title.style.color = 'var(--brand)';
  } else {
    const myTeam = gameState?.myTeam;
    if (!myTeam) {
      title.textContent = '对局结束';
      title.style.color = 'var(--brand)';
    } else {
      const won = data.winnerTeam === myTeam;
      title.textContent = won ? '胜利' : '失败';
      title.style.color = won ? 'var(--green)' : 'var(--red)';
    }
  }

  const settleBtn = document.getElementById('gameOverSettleBtn');
  if (settleBtn) {
    settleBtn.textContent = spectatorView ? '返回大厅' : '结算并返回房间';
  }

  const metaEl = document.getElementById('gameOverMeta');
  if (metaEl) {
    const multiplierText = data.settings?.label ? `本局：${escapeHtml(data.settings.label)}` : '';
    const lastPlayText = data.lastPlay?.player ? `最后出牌：${escapeHtml(data.playerDisplayNames?.[data.lastPlay.player] || data.lastPlay.displayName || data.lastPlay.player)}` : '';
    metaEl.innerHTML = [multiplierText, lastPlayText].filter(Boolean).map(text => `<span>${text}</span>`).join('');
  }

  renderGameOverFinalHands(data);

  const scoresEl = document.getElementById('gameOverScores');
  scoresEl.innerHTML = Object.entries(data.scores).map(([name, score]) => {
    const scoreClass = score > 0 ? 'score-positive' : 'score-negative';
    const displayName = data.playerDisplayNames?.[name] || name;
    return `<div class="score-item">
      <span>${escapeHtml(displayName)}${name === data.winner ? ' ★' : ''}</span>
      <span class="${scoreClass}">${score > 0 ? '+' : ''}${score}</span>
    </div>`;
  }).join('');
}

function renderGameOverFinalHands(data) {
  const container = document.getElementById('gameOverFinalHands');
  if (!container) return;

  const finalHands = data.finalHands || {};
  const players = data.players || Object.keys(finalHands).map(name => ({ name }));
  if (players.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="final-hands-title">剩余手牌</div>
    ${players.map(player => {
      const hand = sortCardsForDisplay(finalHands[player.name] || []);
      const role = player.isLandlord ? '地主' : (player.isHiddenLandlord ? '小地主' : '');
      const displayName = getDisplayName(player, player.name);
      const cardsHtml = hand.map(cardObj => renderMiniCard(typeof cardObj === 'string' ? cardObj : cardObj.id)).join('');
      return `<div class="final-hand-row ${player.name === data.winner ? 'winner' : ''}">
        <div class="final-hand-head">
          <span>${renderAvatar(player.originalUsername || player.name, player.avatarData, { small: true })}</span>
          <strong>${escapeHtml(displayName)}</strong>
          ${role ? `<em>${role}</em>` : ''}
          <span>${hand.length}张</span>
        </div>
        <div class="final-hand-cards">${cardsHtml || '<span class="final-empty">已出完</span>'}</div>
      </div>`;
    }).join('')}
  `;
}

function hideGameOver() {
  const overlay = document.getElementById('gameOverlay');
  if (overlay) overlay.classList.add('hidden');
}

function closeGameOver() {
  if (lastGameOverMode === 'spectator') {
    hideGameOver();
    pendingSettlementRoomId = null;
    resetSpectatorUI();
    showScreen('lobbyScreen');
    refreshRooms();
    return;
  }

  const roomId = pendingSettlementRoomId || currentRoom?.id;
  if (roomId && socket?.connected) {
    socket.emit('settleGame', { roomId }, (res) => {
      hideGameOver();
      pendingSettlementRoomId = null;
      gameState = null;
      clearSelectionState();
      if (res?.closed) {
        currentRoom = null;
        showScreen('lobbyScreen');
        refreshRooms();
        return;
      }
      if (res?.success === false && res.error) {
        showToast(res.error);
      }
      showScreen(currentRoom ? 'roomScreen' : 'lobbyScreen');
      refreshRooms();
    });
    return;
  }

  hideGameOver();
  pendingSettlementRoomId = null;
  showScreen(currentRoom ? 'roomScreen' : 'lobbyScreen');
  refreshRooms();
}

function handleInviteFromUrl() {
  const roomId = getInviteRoomIdFromUrl();
  if (!roomId) return false;
  pendingInviteRoomId = roomId;
  clearInviteParamsFromUrl();
  rememberRoomContext(roomId, 'player');
  if (!currentUser) return true;
  if (!socket || !socket.connected) {
    showConnectionToast('已识别邀请链接，连接恢复后自动加入房间');
    return true;
  }
  joinRoom(roomId);
  pendingInviteRoomId = null;
  return true;
}

// ============ JOIN BY ID ============
function joinRoomById() {
  const input = document.getElementById('joinRoomIdInput');
  const roomId = input.value.trim();
  if (!roomId) return showToast('请输入房间ID');
  joinRoom(roomId);
  input.value = '';
}

// ============ LEADERBOARD ============
async function showLeaderboard() {
  document.getElementById('leaderboardModal').classList.remove('hidden');
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    const content = document.getElementById('leaderboardContent');
    if (data.length === 0) {
      content.innerHTML = '<p class="empty-state">暂无数据</p>';
      return;
    }
    content.innerHTML = `
      <table class="leaderboard-table">
        <thead><tr><th>#</th><th>玩家</th><th>积分</th><th>胜</th><th>负</th><th>场次</th><th>胜率</th></tr></thead>
        <tbody>${data.map((u, i) => {
          const winRate = u.games_played > 0 ? Math.round(u.wins / u.games_played * 100) : 0;
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
          return `<tr class="${u.username === currentUser?.username ? 'is-me' : ''}">
            <td>${medal}</td>
            <td><span class="display-name">${escapeHtml(u.displayName || u.nickname || u.username)}</span><small>@${escapeHtml(u.username)}</small></td>
            <td class="${u.score >= 0 ? 'score-positive' : 'score-negative'}">${u.score}</td>
            <td>${u.wins}</td><td>${u.losses}</td><td>${u.games_played}</td>
            <td>${winRate}%</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  } catch (e) {
    document.getElementById('leaderboardContent').innerHTML = '<p>加载失败</p>';
  }
}

function hideLeaderboard() {
  document.getElementById('leaderboardModal').classList.add('hidden');
}

// ============ THEME ============
function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('force-dark');
  document.documentElement.classList.toggle('force-light', !isDark);
  localStorage.setItem('doudizhu_theme', isDark ? 'dark' : 'light');
}

// ============ GAME HISTORY ============
async function showHistory() {
  document.getElementById('historyModal').classList.remove('hidden');
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    const content = document.getElementById('historyContent');
    if (data.length === 0) {
      content.innerHTML = '<p class="empty-state">暂无对局记录</p>';
      return;
    }
    content.innerHTML = `
      <table class="leaderboard-table">
        <thead><tr><th>时间</th><th>房间</th><th>地主</th><th>获胜方</th><th>积分</th><th>操作</th></tr></thead>
        <tbody>${data.map(g => {
          const scores = Object.entries(g.scores).map(([n, s]) => 
            `<span class="${s > 0 ? 'score-positive' : 'score-negative'}">${escapeHtml(n)}:${s > 0 ? '+' : ''}${s}</span>`
          ).join(' ');
          const time = g.created_at ? new Date(g.created_at + 'Z').toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
          return `<tr>
            <td>${time}</td>
            <td>${escapeHtml(g.room_name || '')}</td>
            <td>${escapeHtml(g.landlord || '')}</td>
            <td>${g.winner_team === 'landlord' ? '地主' : '农民'}</td>
            <td style="font-size:12px">${scores}</td>
            <td><button class="btn btn-ghost btn-sm" onclick="showReplay('${g.id}')">回放</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  } catch (e) {
    document.getElementById('historyContent').innerHTML = '<p>加载失败</p>';
  }
}

function hideHistory() {
  document.getElementById('historyModal').classList.add('hidden');
}

let replayData = null;
let replayIndex = 0;
let replayRounds = [];

function cloneReplayHands(hands) {
  const cloned = {};
  for (const [name, cards] of Object.entries(hands || {})) {
    cloned[name] = [...cards];
  }
  return cloned;
}

function removeReplayCards(hand, cards) {
  const nextHand = [...(hand || [])];
  for (const cardId of cards || []) {
    const idx = nextHand.indexOf(cardId);
    if (idx !== -1) nextHand.splice(idx, 1);
  }
  return nextHand;
}

function buildReplayRounds(data) {
  if (!data?.initial_hands) return [];

  const players = (data.players || []).filter(Boolean);
  const hands = {};
  for (const name of players) {
    hands[name] = [...(data.initial_hands[name] || [])];
  }

  const rounds = [{
    index: 0,
    label: '开局',
    turns: [],
    hands: cloneReplayHands(hands),
    lastTurnByPlayer: {}
  }];

  let currentTurns = [];
  let passCount = 0;
  const history = data.turn_history || [];

  for (let i = 0; i < history.length; i++) {
    const turn = history[i];
    const normalizedTurn = {
      ...turn,
      cards: [...(turn.cards || [])]
    };
    currentTurns.push(normalizedTurn);

    if (turn.action === 'play') {
      hands[turn.player] = removeReplayCards(hands[turn.player], turn.cards);
      passCount = 0;
    } else if (turn.action === 'pass') {
      passCount += 1;
    }

    const isLastTurn = i === history.length - 1;
    if (passCount >= 4 || isLastTurn) {
      const lastTurnByPlayer = {};
      for (const roundTurn of currentTurns) {
        lastTurnByPlayer[roundTurn.player] = roundTurn;
      }
      rounds.push({
        index: rounds.length,
        label: `第${rounds.length}轮`,
        turns: currentTurns,
        hands: cloneReplayHands(hands),
        lastTurnByPlayer,
        endedByPassReset: passCount >= 4
      });
      currentTurns = [];
      passCount = 0;
    }
  }

  return rounds;
}

function getReplayMaxIndex() {
  if (replayRounds.length > 0) return replayRounds.length - 1;
  return replayData?.turn_history?.length || 0;
}

function syncReplayControls(total) {
  const stepEl = document.getElementById('replayStep');
  const rangeEl = document.getElementById('replayRange');
  const jumpInput = document.getElementById('replayJumpInput');
  const prevBtn = document.getElementById('replayPrevBtn');
  const nextBtn = document.getElementById('replayNextBtn');
  const firstBtn = document.getElementById('replayFirstBtn');
  const lastBtn = document.getElementById('replayLastBtn');

  stepEl.textContent = `${replayIndex}/${total}`;
  rangeEl.max = String(total);
  rangeEl.value = String(replayIndex);
  jumpInput.max = String(total);
  jumpInput.value = String(replayIndex);

  const atStart = replayIndex <= 0;
  const atEnd = replayIndex >= total;
  prevBtn.disabled = atStart;
  firstBtn.disabled = atStart;
  nextBtn.disabled = atEnd;
  lastBtn.disabled = atEnd;
}

function renderReplayCards(cards) {
  return (cards || []).map(cardId => {
    const { suit, rank, color, isJoker, isBig } = parseCard(cardId);
    const jokerClass = isJoker ? (isBig ? 'joker-big' : 'joker-small') : '';
    return `<div class="spectator-card ${color} ${jokerClass}">
      <span class="card-rank">${rank}</span>
      <span class="card-suit">${suit}</span>
    </div>`;
  }).join('');
}

function renderReplayTurn(turn) {
  if (turn.action === 'pass') {
    return `<div class="replay-turn"><span class="replay-player">${escapeHtml(turn.player)}</span><span style="color:var(--text-tertiary)">不出</span></div>`;
  }
  const cardsHtml = (turn.cards || []).map(c => {
    const { suit, rank, color } = parseCard(c);
    return `<span class="card-mini ${color}">${suit}${rank}</span>`;
  }).join(' ');
  return `<div class="replay-turn"><span class="replay-player">${escapeHtml(turn.player)}</span>${cardsHtml}<span style="font-size:11px;color:var(--text-quaternary)">${turn.type || ''}</span></div>`;
}

function renderReplayHands(round) {
  return `<div class="replay-hands-grid">${(replayData.players || []).filter(Boolean).map(name => {
    const playerCards = round.hands[name] || [];
    const lastTurn = round.lastTurnByPlayer?.[name];
    let lastPlayHtml = '<span class="spectator-pass">本轮未出</span>';
    if (lastTurn) {
      lastPlayHtml = lastTurn.action === 'pass'
        ? '<span class="spectator-pass">不出</span>'
        : (lastTurn.cards || []).map(c => {
            const { suit, rank, color } = parseCard(c);
            return `<span class="card-mini ${color}">${suit}${rank}</span>`;
          }).join(' ');
    }
    const roleIcon = name === replayData.landlord ? ' 地主' : (name === replayData.hidden_landlord ? ' 暗地主' : '');
    const roleClass = name === replayData.landlord ? 'is-landlord' : (name === replayData.hidden_landlord ? 'is-hidden-landlord' : '');
    return `<div class="spectator-player replay-player-panel ${roleClass}">
      <div class="spectator-player-header">
        <span class="spectator-player-name">${escapeHtml(name)}${roleIcon}</span>
        <span class="spectator-card-count">${playerCards.length}张</span>
      </div>
      <div class="spectator-last-play">${lastPlayHtml}</div>
      <div class="spectator-hand">${renderReplayCards(playerCards)}</div>
    </div>`;
  }).join('')}</div>`;
}

function renderLegacyReplayStep() {
  const history = replayData.turn_history || [];
  const total = history.length;
  replayIndex = Math.max(0, Math.min(replayIndex, total));
  syncReplayControls(total);

  const content = document.getElementById('replayContent');
  const visibleTurns = history.slice(0, replayIndex);
  let html = `<div class="replay-summary-card">
    <div style="margin-bottom:8px;font-size:13px;color:var(--text-secondary)">
      <span>大地主: ${escapeHtml(replayData.landlord)}</span>
      ${replayData.hidden_landlord ? ` | <span>小地主: ${escapeHtml(replayData.hidden_landlord)}</span>` : ''}
      | <span>明牌: ${replayData.marked_card || '?'}</span>
    </div>
    <div class="replay-empty">该旧回放记录未保存开局手牌，暂不支持全牌面回放，以下为逐手记录。</div>
  </div>`;
  html += '<div class="replay-turns">';
  if (visibleTurns.length === 0) {
    html += '<div class="replay-empty">游戏开始 - 点击“下一轮”查看记录</div>';
  } else {
    html += visibleTurns.slice(-20).map(renderReplayTurn).join('');
  }
  html += '</div>';
  if (replayIndex >= total) {
    html += '<div class="replay-final-scores"><strong>最终得分</strong> ';
    html += Object.entries(replayData.scores || {}).map(([n, s]) =>
      `<span class="${s > 0 ? 'score-positive' : 'score-negative'}">${escapeHtml(n)}: ${s > 0 ? '+' : ''}${s}</span>`
    ).join(' &nbsp;');
    html += '</div>';
  }
  content.innerHTML = html;
}

async function showReplay(gameId) {
  try {
    const res = await fetch(`/api/history/${gameId}`);
    replayData = await res.json();
    replayRounds = buildReplayRounds(replayData);
    replayIndex = 0;
    document.getElementById('replayModal').classList.remove('hidden');
    renderReplayStep();
  } catch (e) {
    showToast('加载回放失败');
  }
}

function hideReplay() {
  document.getElementById('replayModal').classList.add('hidden');
  replayData = null;
  replayRounds = [];
}

function replayPrev() {
  if (replayIndex > 0) { replayIndex--; renderReplayStep(); }
}

function replayNext() {
  if (replayData && replayIndex < getReplayMaxIndex()) { replayIndex++; renderReplayStep(); }
}

function replayFirst() {
  replayIndex = 0;
  renderReplayStep();
}

function replayLast() {
  replayIndex = getReplayMaxIndex();
  renderReplayStep();
}

function replayJump(value) {
  const target = Math.max(0, Math.min(getReplayMaxIndex(), Number(value) || 0));
  replayIndex = target;
  renderReplayStep();
}

function jumpReplay() {
  replayJump(document.getElementById('replayJumpInput').value);
}

function renderReplayStep() {
  if (!replayData) return;
  const content = document.getElementById('replayContent');
  if (!replayData.initial_hands || replayRounds.length === 0) {
    renderLegacyReplayStep();
    return;
  }

  const total = replayRounds.length - 1;
  replayIndex = Math.max(0, Math.min(replayIndex, total));
  syncReplayControls(total);

  const round = replayRounds[replayIndex];
  let html = `<div class="replay-summary-card">
    <div class="replay-summary-line">
      <span>大地主: ${escapeHtml(replayData.landlord)}</span>
      ${replayData.hidden_landlord ? ` | <span>小地主: ${escapeHtml(replayData.hidden_landlord)}</span>` : ''}
      | <span>明牌: ${replayData.marked_card || '?'}</span>
      | <span>胜方: ${replayData.winner_team === 'landlord' ? '地主' : '农民'} (${escapeHtml(replayData.winner)})</span>
    </div>
    <div class="replay-summary-line">
      <strong>${round.label}</strong>
      <span class="replay-round-tip">${replayIndex === 0 ? '开局状态' : `本次点击展示整轮动作（共 ${round.turns.length} 条）`}</span>
    </div>
  </div>`;

  if (replayIndex === 0) {
    html += '<div class="replay-empty">开局状态：展示所有玩家起始手牌。</div>';
  } else {
    html += `<div class="replay-turns">${round.turns.map(renderReplayTurn).join('')}</div>`;
  }

  html += renderReplayHands(round);

  if (replayIndex >= total) {
    html += '<div class="replay-final-scores"><strong>最终得分</strong> ';
    html += Object.entries(replayData.scores || {}).map(([n, s]) => 
      `<span class="${s > 0 ? 'score-positive' : 'score-negative'}">${escapeHtml(n)}: ${s > 0 ? '+' : ''}${s}</span>`
    ).join(' &nbsp;');
    html += '</div>';
  }

  content.innerHTML = html;
}

// ============ USER STATS ============
async function loadUserStats() {
  if (!currentUser) return;
  try {
    const res = await fetch(`/api/stats/${encodeURIComponent(currentUser.username)}`);
    if (res.ok) {
      const stats = await res.json();
      document.getElementById('userStats').textContent = 
        `${stats.score}分 · ${stats.wins}胜 ${stats.losses}负`;
    }
  } catch (e) {}
}

// ============ SPECTATOR ============
function requestSpectate(roomId) {
  if (!roomId) return;
  if (!socket || !socket.connected) {
    rememberRoomContext(roomId, 'spectator');
    showConnectionToast('尚未连接到服务器，正在重连...');
    if (socket) socket.connect();
    return;
  }
  socket.emit('requestSpectate', { roomId }, (res) => {
    if (res.success) {
      rememberRoomContext(roomId, res.rejoined ? 'player' : 'spectator');
      if (res.rejoined) {
        showToast(res.message || '已回到对局');
        return;
      }
      showToast(res.message);
    } else {
      showToast(res.error);
      if (/不存在|已关闭|已删除/.test(String(res.error || ''))) clearRoomContext();
    }
  });
}

function approveSpectate() {
  if (pendingSpectateRequest && currentRoom) {
    socket.emit('approveSpectate', {
      roomId: pendingSpectateRequest.roomId,
      requester: pendingSpectateRequest.requester
    });
  }
  document.getElementById('spectateRequestModal').classList.add('hidden');
  pendingSpectateRequest = null;
}

function denySpectate() {
  if (pendingSpectateRequest && currentRoom) {
    socket.emit('denySpectate', {
      roomId: pendingSpectateRequest.roomId,
      requester: pendingSpectateRequest.requester
    });
  }
  document.getElementById('spectateRequestModal').classList.add('hidden');
  pendingSpectateRequest = null;
}

function renderSpectatorState(state) {
  // Show spectator UI
  document.getElementById('spectatorBadge').classList.remove('hidden');
  document.getElementById('myHandArea').classList.add('hidden');
  document.getElementById('spectatorControls').classList.remove('hidden');
  document.getElementById('cardCounterPanel').classList.remove('hidden');
  document.getElementById('otherPlayersArea').classList.add('hidden');
  document.getElementById('spectatorAllPlayers').classList.remove('hidden');

  // Marked card
  const markedEl = document.getElementById('markedCardDisplay');
  if (state.markedCard) {
    const { suit, rank, color } = parseCard(state.markedCard);
    markedEl.className = `card-mini ${color}`;
    markedEl.textContent = `${suit}${rank}`;
  } else {
    markedEl.className = 'card-mini';
    markedEl.textContent = '-';
  }

  // Landlord label
  const landlordLabel = document.getElementById('landlordLabel');
  let landlordText = `大地主 ${state.landlordDisplayName || getGameDisplayName(state.landlord, state)}`;
  if (state.hiddenLandlord) {
    landlordText += ` | 小地主 ${state.hiddenLandlordDisplayName || getGameDisplayName(state.hiddenLandlord, state)}`;
  }
  landlordLabel.textContent = landlordText;
  const multiplierBadge = document.getElementById('gameMultiplierBadge');
  if (multiplierBadge) multiplierBadge.textContent = state.settings?.label || '';

  // Turn indicator
  document.getElementById('turnIndicator').textContent = state.phase === 'doubling'
    ? `等待玩家选择加倍（${Object.keys(state.doubleDecisions || {}).length}/5）`
    : `等待 ${state.currentPlayerDisplayName || getGameDisplayName(state.currentPlayer, state)} 出牌`;

  // Render all 5 players with their hands visible
  const container = document.getElementById('spectatorAllPlayers');
  container.innerHTML = state.players.map((p, i) => {
    const isCurrent = p.name === state.currentPlayer;
    const roleIcon = p.isLandlord ? ' 地主' : (p.isHiddenLandlord ? ' 暗地主' : '');
    const displayName = getDisplayName(p, p.name);
    const handCards = sortCardsForDisplay(state.allHands[p.name] || []);

    // Last play from history
    const lastTurn = [...(state.turnHistory || [])].reverse().find(t => t.player === p.name);
    let lastPlayHtml = '';
    if (lastTurn) {
      if (lastTurn.action === 'pass') {
        lastPlayHtml = '<span class="spectator-pass">不出</span>';
      } else {
        lastPlayHtml = sortCardsForDisplay(lastTurn.cards).map(c => renderMiniCard(c)).join(' ');
      }
    }

    const cardsHtml = handCards.map(cardObj => {
      const cardId = typeof cardObj === 'string' ? cardObj : cardObj.id;
      const { suit, rank, color, isJoker, isBig } = parseCard(cardId);
      const jokerClass = isJoker ? (isBig ? 'joker-big' : 'joker-small') : '';
      return `<div class="spectator-card ${color} ${jokerClass}">
        <span class="card-rank">${rank}</span>
        <span class="card-suit">${suit}</span>
      </div>`;
    }).join('');

    return `
      <div class="spectator-player ${isCurrent ? 'current-turn' : ''} ${p.isLandlord ? 'is-landlord' : ''} ${p.isHiddenLandlord ? 'is-hidden-landlord' : ''}">
        <div class="spectator-player-header">
          ${renderAvatar(p.originalUsername || p.name, p.avatarData, { small: true })}
          <span class="spectator-player-name">${escapeHtml(displayName)}${roleIcon}</span>
          <span class="spectator-card-count">${p.cardCount}张</span>
          ${isCurrent ? '<span class="spectator-turn-badge">出牌中</span>' : ''}
        </div>
        <div class="spectator-last-play">${lastPlayHtml}</div>
        <div class="spectator-hand">${cardsHtml}</div>
      </div>`;
  }).join('');

  // Last play in center
  const lastPlayDisplay = document.getElementById('lastPlayDisplay');
  if (state.lastPlay) {
    lastPlayDisplay.innerHTML = sortCardsForDisplay(state.lastPlay.cards).map(c => {
      const { suit, rank, color } = parseCard(c);
      return `<div class="display-card ${color}">
        <span class="card-rank">${rank}</span>
        <span class="card-suit">${suit}</span>
      </div>`;
    }).join('');
  } else {
    lastPlayDisplay.innerHTML = '<span style="color:var(--text-quaternary);font-size:14px">新一轮开始</span>';
  }

  // Card counter
  if (state.cardCounter) {
    renderCardCounter(state.cardCounter);
  }
}

function renderCardCounter(counter) {
  const grid = document.getElementById('cardCounterGrid');
  const rankOrder = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '小王', '大王'];

  grid.innerHTML = rankOrder.map(rank => {
    const info = counter[rank];
    if (!info) return '';
    const pct = info.left / info.total;
    const colorClass = info.left === 0 ? 'counter-empty' : (pct <= 0.33 ? 'counter-low' : '');
    return `<div class="counter-item ${colorClass}">
      <span class="counter-rank">${rank}</span>
      <span class="counter-value">${info.left}/${info.total}</span>
    </div>`;
  }).join('');
}

// ============ UTILS ============
const CARD_VALUE_MAP = {
  '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, '2': 15,
  'X': 16, 'D': 17
};
const SUIT_ORDER_MAP = { '♠': 0, '♥': 1, '♣': 2, '♦': 3, '': 4 };

function parseCard(cardId) {
  if (!cardId) return { suit: '', rank: '?', color: 'black', isJoker: false };

  if (cardId === 'X') {
    return { suit: '🃏', rank: '小王', color: 'black', isJoker: true, isBig: false };
  }
  if (cardId === 'D') {
    return { suit: '🃏', rank: '大王', color: 'red', isJoker: true, isBig: true };
  }

  const suit = cardId[0];
  const rank = cardId.substring(1);
  const isRed = suit === '♥' || suit === '♦';
  return {
    suit,
    rank,
    color: isRed ? 'red' : 'black',
    isJoker: false,
    isBig: false
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function hashString(input) {
  let hash = 0;
  const text = String(input || '');
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function renderPixelAvatar(username, options = {}) {
  const hash = hashString(username);
  const hue = hash % 360;
  const cells = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const active = ((hash >> ((x + y * 3) % 24)) & 1) === 1 || (x === 0 && y === 0);
      cells[y * 5 + x] = active;
      cells[y * 5 + (4 - x)] = active;
    }
  }
  const className = options.small ? 'pixel-avatar small' : 'pixel-avatar';
  return `<span class="${className}" style="--avatar-hue:${hue}">
    ${cells.map(active => `<i class="${active ? 'on' : ''}"></i>`).join('')}
  </span>`;
}

function renderAvatar(username, avatarData, options = {}) {
  const resolvedAvatarData = avatarData || getCachedProfile(username)?.avatarData || null;
  if (resolvedAvatarData) {
    const className = options.small ? 'avatar-img small' : 'avatar-img';
    return `<img class="${className}" src="${resolvedAvatarData}" alt="${escapeHtml(username || '头像')}">`;
  }
  if (options.ai) {
    return '<span class="ai-avatar">AI</span>';
  }
  return renderPixelAvatar(username, options);
}

function updateUserBadge() {
  const badge = document.getElementById('userBadge');
  if (!badge || !currentUser) return;
  const displayName = getDisplayName(currentUser, currentUser.username);
  badge.innerHTML = `${renderAvatar(currentUser.username, currentUser.avatarData, { small: true })}<span class="badge-name">${escapeHtml(displayName)}</span><small>@${escapeHtml(currentUser.username)}</small>`;
}

async function loadProfile() {
  if (!currentUser?.token) return;
  try {
    const res = await fetch('/api/profile', {
      headers: { Authorization: `Bearer ${currentUser.token}` }
    });
    if (res.status === 401 || res.status === 403) {
      handleAuthExpired('登录状态已失效，请重新登录');
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    currentUser = {
      ...currentUser,
      nickname: data.nickname || data.displayName || data.username,
      displayName: data.displayName || data.nickname || data.username,
      nicknameUpdatedAt: data.nicknameUpdatedAt || null,
      canChangeNicknameThisMonth: data.canChangeNicknameThisMonth !== false,
      avatarData: data.avatarData || null
    };
    localStorage.setItem(USER_NICKNAME_STORAGE_KEY, currentUser.nickname || currentUser.username);
    if (data.avatarData) localStorage.setItem(USER_AVATAR_STORAGE_KEY, data.avatarData);
    else localStorage.removeItem(USER_AVATAR_STORAGE_KEY);
    updateUserBadge();
    renderProfilePreview();
  } catch (error) {
    console.warn('load profile failed', error);
  }
}

function showProfileSettings() {
  renderProfilePreview();
  document.getElementById('profileModal').classList.remove('hidden');
}

function hideProfileSettings() {
  document.getElementById('profileModal').classList.add('hidden');
}

function renderProfilePreview() {
  const preview = document.getElementById('profileAvatarPreview');
  if (!preview || !currentUser) return;
  const displayName = getDisplayName(currentUser, currentUser.username);
  preview.innerHTML = renderAvatar(currentUser.username, currentUser.avatarData);
  const usernameInput = document.getElementById('profileUsername');
  const nicknameInput = document.getElementById('profileNickname');
  const tip = document.getElementById('nicknameChangeTip');
  if (usernameInput) usernameInput.value = currentUser.username || '';
  if (nicknameInput) {
    nicknameInput.value = currentUser.nickname || currentUser.displayName || currentUser.username || '';
    nicknameInput.disabled = currentUser.canChangeNicknameThisMonth === false;
  }
  if (tip) {
    tip.textContent = currentUser.canChangeNicknameThisMonth === false
      ? `本月已修改过昵称，上次修改：${formatDateTime(currentUser.nicknameUpdatedAt)}`
      : '昵称每个自然月只能修改 1 次，2-20 个字符。';
  }
}

async function saveNickname() {
  if (!currentUser?.token) return;
  const input = document.getElementById('profileNickname');
  const nickname = input?.value.trim();
  if (!nickname) return showToast('昵称不能为空');
  try {
    const res = await fetch('/api/profile', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ nickname })
    });
    const data = await res.json();
    if (res.status === 401 || res.status === 403) {
      handleAuthExpired('登录状态已失效，请重新登录');
      return;
    }
    if (!res.ok) return showToast(data.error || '昵称保存失败');
    currentUser = {
      ...currentUser,
      nickname: data.nickname || data.displayName || data.username,
      displayName: data.displayName || data.nickname || data.username,
      nicknameUpdatedAt: data.nicknameUpdatedAt || null,
      canChangeNicknameThisMonth: data.canChangeNicknameThisMonth !== false,
      avatarData: data.avatarData || currentUser.avatarData || null
    };
    localStorage.setItem(USER_NICKNAME_STORAGE_KEY, currentUser.nickname || currentUser.username);
    updateUserBadge();
    renderProfilePreview();
    showToast('昵称已保存');
  } catch (error) {
    showToast('昵称保存失败');
  }
}

async function saveAvatarData(avatarData) {
  const res = await fetch('/api/profile/avatar', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${currentUser.token}`
    },
    body: JSON.stringify({ avatarData })
  });
  const data = await res.json();
  if (res.status === 401 || res.status === 403) {
    handleAuthExpired('登录状态已失效，请重新登录');
    throw new Error('登录状态已失效，请重新登录');
  }
  if (!res.ok) throw new Error(data.error || '头像保存失败');
  currentUser = {
    ...currentUser,
    nickname: data.nickname || currentUser.nickname || data.username,
    displayName: data.displayName || data.nickname || currentUser.displayName || data.username,
    nicknameUpdatedAt: data.nicknameUpdatedAt || currentUser.nicknameUpdatedAt || null,
    canChangeNicknameThisMonth: data.canChangeNicknameThisMonth !== false,
    avatarData: data.avatarData || null
  };
  if (data.avatarData) localStorage.setItem(USER_AVATAR_STORAGE_KEY, data.avatarData);
  else localStorage.removeItem(USER_AVATAR_STORAGE_KEY);
  updateUserBadge();
  renderProfilePreview();
}

async function handleAvatarUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      throw new Error('仅支持 PNG、JPG 或 WebP 图片');
    }
    if (!window.AvatarCompression?.compressAvatarFile) {
      throw new Error('当前浏览器不支持头像压缩');
    }
    showToast('正在压缩头像...');
    const avatarData = await window.AvatarCompression.compressAvatarFile(file);
    await saveAvatarData(avatarData);
    showToast('头像已保存');
  } catch (error) {
    showToast(error.message || '头像上传失败');
  } finally {
    event.target.value = '';
  }
}

async function resetAvatar() {
  try {
    await saveAvatarData(null);
    showToast('已恢复默认头像');
  } catch (error) {
    showToast(error.message || '头像保存失败');
  }
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ============ KEYBOARD SHORTCUTS ============
document.addEventListener('keydown', (e) => {
  // Enter to login/register
  if (document.getElementById('authScreen').classList.contains('active')) {
    if (e.key === 'Enter') {
      if (!document.getElementById('loginForm').classList.contains('hidden')) {
        login();
      } else {
        register();
      }
    }
  }

  // Enter to create room in modal
  if (e.key === 'Enter' && !document.getElementById('createRoomModal').classList.contains('hidden')) {
    createRoom();
  }

  // Space to play cards
  if (document.getElementById('gameScreen').classList.contains('active')) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (gameState?.isMyTurn && selectedCards.size > 0) {
        playSelected();
      }
    }
    if (e.key === 'p' || e.key === 'P') {
      if (gameState?.isMyTurn && !gameState?.mustPlay) {
        passCards();
      }
    }
    if (e.key === 'h' || e.key === 'H') {
      if (gameState?.isMyTurn) {
        getHint();
      }
    }
  }
});

let pendingStartPrompt = null;
let cardDragState = null;
let suppressCardClick = false;
let suppressCardClickTimer = null;
const CARD_DRAG_DISTANCE_THRESHOLD = 6;
const CARD_CLICK_SUPPRESS_MS = 180;

function resetSpectatorUI() {
  isSpectating = false;
  spectatingRoomId = null;
  gameState = null;
  document.getElementById('spectatorBadge').classList.add('hidden');
  document.getElementById('myHandArea').classList.remove('hidden');
  document.getElementById('spectatorControls').classList.add('hidden');
  document.getElementById('cardCounterPanel').classList.add('hidden');
  document.getElementById('otherPlayersArea').classList.remove('hidden');
  document.getElementById('spectatorAllPlayers').classList.add('hidden');
  const leaveBtn = document.getElementById('gameLeaveBtn');
  if (leaveBtn) leaveBtn.classList.remove('hidden');
  const revealBtn = document.getElementById('revealHandBtn');
  if (revealBtn) revealBtn.classList.add('hidden');
}

function resetPlayerGameUI() {
  isSpectating = false;
  spectatingRoomId = null;
  document.getElementById('spectatorBadge').classList.add('hidden');
  document.getElementById('myHandArea').classList.remove('hidden');
  document.getElementById('spectatorControls').classList.add('hidden');
  document.getElementById('cardCounterPanel').classList.add('hidden');
  document.getElementById('otherPlayersArea').classList.remove('hidden');
  document.getElementById('spectatorAllPlayers').classList.add('hidden');
  const leaveBtn = document.getElementById('gameLeaveBtn');
  if (leaveBtn) leaveBtn.classList.remove('hidden');
  const markedSelectionArea = document.getElementById('markedSelectionArea');
  if (markedSelectionArea) markedSelectionArea.classList.add('hidden');
  const doubleSelectionArea = document.getElementById('doubleSelectionArea');
  if (doubleSelectionArea) doubleSelectionArea.classList.add('hidden');
  const gameActions = document.getElementById('gameActions');
  if (gameActions) {
    gameActions.classList.remove('hidden');
    gameActions.style.display = '';
  }
  const revealBtn = document.getElementById('revealHandBtn');
  if (revealBtn) revealBtn.classList.add('hidden');
}

function clearSelectionState() {
  selectedCards.clear();
  hintList = [];
  hintIndex = -1;
  isPlayingCards = false;
  cardDragState = null;
  suppressCardClick = false;
  if (suppressCardClickTimer) {
    clearTimeout(suppressCardClickTimer);
    suppressCardClickTimer = null;
  }
  document.querySelectorAll('.game-card.selected, .game-card.hint').forEach(card => {
    card.classList.remove('selected', 'hint');
  });
  updateClearSelectionButton();
}

function hideStartPrompt() {
  pendingStartPrompt = null;
  const modal = document.getElementById('startConfirmModal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function buildStartPromptPayload(source) {
  const state = source || currentRoom;
  if (!state) return null;

  const players = (state.players || []).filter(Boolean).map(player => ({
    username: player.username,
    displayName: getDisplayName(player, player.username),
    ready: Boolean(player.ready),
    isAI: Boolean(player.isAI)
  }));
  const humanPlayerCount = typeof state.humanPlayerCount === 'number'
    ? state.humanPlayerCount
    : players.filter(player => !player.isAI).length;
  const readyHumanCount = typeof state.readyHumanCount === 'number'
    ? state.readyHumanCount
    : players.filter(player => !player.isAI && player.ready).length;
  const aiFillCount = typeof state.aiFillCount === 'number'
    ? state.aiFillCount
    : (typeof state.emptySeatCount === 'number' ? state.emptySeatCount : Math.max(0, 5 - humanPlayerCount));

  return {
    roomId: state.roomId || state.id,
    roomName: state.roomName || state.name,
    humanPlayerCount,
    readyHumanCount,
    aiFillCount,
    players,
    settings: state.settings
  };
}

function showStartPrompt(source) {
  const payload = buildStartPromptPayload(source);
  if (!payload) return;

  pendingStartPrompt = payload;
  const modal = document.getElementById('startConfirmModal');
  const text = document.getElementById('startConfirmText');
  const players = document.getElementById('startConfirmPlayers');
  if (!modal || !text || !players) return;

  const settingsText = payload.settings?.label ? `本局 ${payload.settings.label}。` : '';
  text.textContent = `${settingsText}当前有 ${payload.humanPlayerCount} 位真人玩家，${payload.aiFillCount} 个空位将由 AI 补位。确认现在开始对局吗？`;
  players.innerHTML = payload.players.map(player => `
    <div class="start-confirm-player ${player.ready ? 'ready' : ''} ${player.isAI ? 'ai' : ''}">
      <span>${escapeHtml(player.displayName || player.username)}</span>
      <span>${player.isAI ? 'AI' : (player.ready ? '已准备' : '未准备')}</span>
    </div>
  `).join('');
  modal.classList.remove('hidden');
}

function cancelStartPrompt() {
  hideStartPrompt();
}

function confirmStartGame() {
  if (!currentRoom || !pendingStartPrompt) return;

  socket.emit('startGame', { roomId: currentRoom.id }, (res) => {
    if (res?.success) {
      hideStartPrompt();
      return;
    }
    showToast(res?.error || '开始失败');
  });
}

function updateSelectionHint() {
  const hint = document.getElementById('cardSelectionHint');
  if (!hint) return;

  if (isSpectating) {
    hint.textContent = '';
    updateClearSelectionButton();
    return;
  }

  if (gameState?.phase === 'selectingMarked') {
    hint.textContent = selectedCards.size > 0
      ? `已选择 ${selectedCards.size}/2 张明牌，可继续滑动调整`
      : '支持点击或滑动批量选择两张明牌';
    updateClearSelectionButton();
    return;
  }

  if (gameState?.phase === 'doubling') {
    hint.textContent = '发牌完成，请先选择是否加倍';
    updateClearSelectionButton();
    return;
  }

  hint.textContent = selectedCards.size > 0
    ? `已选择 ${selectedCards.size} 张牌，可继续滑动补选或取消选择`
    : '支持点击或滑动连续选择/取消选择手牌';
  updateClearSelectionButton();
}

function updateClearSelectionButton() {
  const btn = document.getElementById('clearSelectionBtn');
  if (!btn) return;
  const canShow = selectedCards.size > 0 && !isSpectating && gameState && gameState.phase !== 'doubling';
  btn.classList.toggle('hidden', !canShow);
  btn.textContent = selectedCards.size > 0 ? `取消选择(${selectedCards.size})` : '取消选择';
}

function clearSelectedCards() {
  clearSelectionState();
  updateSelectionHint();
}

function canInteractWithHand() {
  if (!currentRoom || !gameState || isSpectating) return false;
  if (gameState.phase === 'selectingMarked') {
    return gameState.myName === gameState.landlord;
  }
  return Boolean(gameState.isMyTurn);
}

function setCardSelection(cardUid, shouldSelect) {
  if (shouldSelect) {
    selectedCards.add(cardUid);
  } else {
    selectedCards.delete(cardUid);
  }

  const card = document.querySelector(`.game-card[data-uid="${CSS.escape(cardUid)}"]`);
  if (card) {
    card.classList.toggle('selected', shouldSelect);
    card.classList.remove('hint');
  }
  updateSelectionHint();
}

function toggleCardSelection(el, cardUid) {
  if (!canInteractWithHand()) return;
  setCardSelection(cardUid, !selectedCards.has(cardUid));
  if (el) {
    el.classList.toggle('selected', selectedCards.has(cardUid));
  }
}

function initializeCardSelectionGestures() {
  const container = document.getElementById('myHand');
  if (!container || container.dataset.selectionBound === 'true') return;

  container.dataset.selectionBound = 'true';

  container.addEventListener('click', (event) => {
    const card = event.target.closest('.game-card');
    if (!card) return;
    if (suppressCardClick) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!canInteractWithHand()) return;
    toggleCardSelection(card, card.dataset.uid);
  });

  container.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.game-card')) event.preventDefault();
  });

  container.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.game-card');
    if (handDisplayMode !== 'custom' || !card) return;
    event.dataTransfer.setData('text/plain', card.dataset.uid);
    event.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });

  container.addEventListener('dragend', (event) => {
    event.target.closest('.game-card')?.classList.remove('dragging');
  });

  container.addEventListener('dragover', (event) => {
    const zone = event.target.closest('.hand-zone');
    if (handDisplayMode !== 'custom' || !zone) return;
    event.preventDefault();
    zone.classList.add('drag-over');
  });

  container.addEventListener('dragleave', (event) => {
    event.target.closest('.hand-zone')?.classList.remove('drag-over');
  });

  container.addEventListener('drop', (event) => {
    const zone = event.target.closest('.hand-zone');
    if (handDisplayMode !== 'custom' || !zone) return;
    event.preventDefault();
    zone.classList.remove('drag-over');
    const uid = event.dataTransfer.getData('text/plain');
    const zoneNumber = Number(zone.dataset.zone);
    if (!uid || !zoneNumber) return;
    customHandZones[uid] = zoneNumber;
    saveCustomHandZones();
    renderMyHand(gameState?.myHand || []);
  });

  container.addEventListener('pointerdown', (event) => {
    const card = event.target.closest('.game-card');
    if (!card || !canInteractWithHand()) return;
    if (handDisplayMode === 'custom' && event.pointerType === 'mouse') return;

    event.preventDefault();
    if (suppressCardClickTimer) {
      clearTimeout(suppressCardClickTimer);
      suppressCardClickTimer = null;
    }
    suppressCardClick = true;
    const shouldSelect = !selectedCards.has(card.dataset.uid);
    cardDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      shouldSelect,
      visited: new Set([card.dataset.uid]),
      moved: false
    };
    setCardSelection(card.dataset.uid, shouldSelect);
    if (container.setPointerCapture) {
      container.setPointerCapture(event.pointerId);
    }
  });

  container.addEventListener('pointermove', (event) => {
    if (!cardDragState || cardDragState.pointerId !== event.pointerId) return;

    const distance = Math.hypot(event.clientX - cardDragState.startX, event.clientY - cardDragState.startY);
    if (!cardDragState.moved && distance < CARD_DRAG_DISTANCE_THRESHOLD) return;
    cardDragState.moved = true;
    event.preventDefault();

    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.game-card');
    if (!target || !container.contains(target)) return;

    const cardUid = target.dataset.uid;
    if (!cardUid) return;
    if (cardDragState.visited.has(cardUid)) return;

    cardDragState.visited.add(cardUid);
    suppressCardClick = true;
    setCardSelection(cardUid, cardDragState.shouldSelect);
  });

  const finishGesture = (event) => {
    if (!cardDragState) return;
    if (typeof event.pointerId === 'number' && cardDragState.pointerId !== event.pointerId) return;

    const pointerId = cardDragState.pointerId;
    cardDragState = null;
    if (container.releasePointerCapture && typeof pointerId === 'number') {
      try {
        container.releasePointerCapture(pointerId);
      } catch (error) {}
    }
    suppressCardClickTimer = setTimeout(() => {
      suppressCardClick = false;
      suppressCardClickTimer = null;
    }, CARD_CLICK_SUPPRESS_MS);
  };

  container.addEventListener('pointerup', finishGesture);
  container.addEventListener('pointercancel', finishGesture);
  container.addEventListener('pointerleave', (event) => {
    if (cardDragState && event.buttons === 0) {
      finishGesture(event);
    }
  });
}

function handleForcedExit(message) {
  hideStartPrompt();
  document.getElementById('gameOverlay').classList.add('hidden');
  resetSpectatorUI();
  currentRoom = null;
  gameState = null;
  clearRoomContext();
  clearSelectionState();
  showScreen('lobbyScreen');
  refreshRooms();
  if (message) {
    showToast(message);
  }
}

function restoreRoomContextAfterReconnect() {
  if (restoreInFlight || !socket?.connected || !currentUser) return;
  const context = pendingInviteRoomId
    ? { roomId: pendingInviteRoomId, mode: 'player' }
    : getRememberedRoomContext();
  if (!context?.roomId) return;

  restoreInFlight = true;
  const done = () => {
    restoreInFlight = false;
    pendingInviteRoomId = null;
  };

  const fallbackToSpectate = () => {
    socket.emit('requestSpectate', { roomId: context.roomId }, (spectateRes) => {
      if (spectateRes?.success) {
        rememberRoomContext(context.roomId, spectateRes.rejoined ? 'player' : 'spectator');
        if (spectateRes.message) showConnectionToast(spectateRes.message, true);
      } else if (spectateRes?.error) {
        showToast(spectateRes.error);
        if (/不存在|已关闭|已删除/.test(String(spectateRes.error))) clearRoomContext();
      }
      done();
    });
  };

  if (context.mode === 'spectator') {
    fallbackToSpectate();
    return;
  }

  socket.emit('joinRoom', { roomId: context.roomId }, (res) => {
    if (res?.success) {
      rememberRoomContext(res.roomId || context.roomId, 'player');
      if (res.rejoined) showConnectionToast(res.message || '已自动回到对局', true);
      done();
      return;
    }

    if (/已开局|已开始|房间已开局/.test(String(res?.error || ''))) {
      fallbackToSpectate();
      return;
    }

    if (res?.error) {
      showToast(res.error);
      if (/不存在|已关闭|已删除/.test(String(res.error))) clearRoomContext();
    }
    done();
  });
}

function connectSocket() {
  socket = io({ auth: { token: currentUser.token } });

  socket.on('connect', () => {
    console.log('Connected');
    restoreRoomContextAfterReconnect();
  });
  socket.on('disconnect', () => {
    showConnectionToast('连接已断开，正在自动重连...');
  });
  socket.on('reconnecting', (data) => {
    showConnectionToast(`正在重连服务器（第 ${data?.attempt || 1} 次）...`);
  });
  socket.on('reconnect', () => {
    showConnectionToast('连接已恢复，正在同步房间状态', true);
    restoreRoomContextAfterReconnect();
  });
  socket.on('roomList', (rooms) => renderRoomList(rooms));

  socket.on('roomProfiles', (data) => {
    if (!data?.profiles) return;
    mergeRemoteProfiles(data.profiles);
    rerenderProfileDependentViews(data.roomId);
  });

  socket.on('roomState', (state) => {
    const prevRoom = currentRoom;
    currentRoom = state;
    rememberRoomContext(state.id, 'player');
    notifyRoomMemberChanges(prevRoom, state);
    renderRoomState(state);
    const amParticipant = (state.players || []).some(player => player && player.username === currentUser?.username);
    if (amParticipant && state.status !== 'playing') {
      hideStartPrompt();
      gameState = null;
      showScreen('roomScreen');
    }
  });

  socket.on('ownerStartPrompt', (payload) => {
    if (!currentRoom || currentRoom.owner !== currentUser?.username) return;
    if (currentRoom.id !== payload.roomId) return;
    showStartPrompt(payload);
  });

  socket.on('gameState', (state) => {
    gameState = state;
    rememberRoomContext(state.roomId || currentRoom?.id, 'player');
    hideGameOver();
    hideStartPrompt();
    clearSelectionState();
    resetPlayerGameUI();
    showScreen('gameScreen');
    renderGameState(state);
  });

  socket.on('gameOver', (data) => {
    showGameOver(data);
    loadUserStats();
  });

  socket.on('spectatorGameOver', (data) => {
    showGameOver({ ...data, spectator: true });
  });

  socket.on('roomParticipationEnded', (data) => {
    if (!data) return;
    handleForcedExit(data.message || '你已离开当前房间');
  });

  socket.on('roomClosed', (data) => {
    if (!data) return;
    handleForcedExit(data.message || '房间已关闭');
  });

  socket.on('gameStopped', (data) => {
    hideStartPrompt();
    document.getElementById('gameOverlay').classList.add('hidden');
    clearSelectionState();

    if (data?.spectator || isSpectating || spectatingRoomId === data?.roomId) {
      resetSpectatorUI();
      currentRoom = null;
      gameState = null;
      clearRoomContext();
      showScreen('lobbyScreen');
      refreshRooms();
      showToast(data?.message || '对局已停止');
      return;
    }

    gameState = null;
    showScreen('roomScreen');
    showToast(data?.message || '对局已停止');
  });

  socket.on('kicked', () => {
    handleForcedExit('你已被房主移出房间');
  });

  socket.on('chatMessage', (data) => {
    addChatMessage(data.displayName || data.username, data.message, data.username);
  });

  socket.on('playError', (data) => {
    isPlayingCards = false;
    showToast(data.error);
  });

  socket.on('spectateRequest', (data) => {
    pendingSpectateRequest = data;
    document.getElementById('spectateRequestText').textContent = `${data.requesterDisplayName || data.requester} 请求观战当前对局`;
    document.getElementById('spectateRequestModal').classList.remove('hidden');
  });

  socket.on('aiTakeoverRequest', (data) => {
    if (!data?.roomId || !data?.requestId) return;
    pendingAiTakeoverRequest = data;
    const accepted = confirm(data.message || `${data.displayName || data.username} 已断线，是否确认由 AI 接管？`);
    socket.emit('respondAiTakeover', {
      roomId: data.roomId,
      requestId: data.requestId,
      accept: accepted
    }, (res) => {
      pendingAiTakeoverRequest = null;
      if (!res?.success) {
        showToast(res?.error || '处理 AI 接管请求失败');
        return;
      }
      if (res.message) {
        showToast(res.message);
      } else {
        showToast(accepted ? '已确认 AI 接管' : '已继续等待玩家重连');
      }
    });
  });

  socket.on('aiTakeoverRequestCancelled', (data) => {
    if (pendingAiTakeoverRequest?.requestId === data?.requestId) {
      pendingAiTakeoverRequest = null;
    }
    showToast(data?.reason || 'AI 接管请求已取消');
  });

  socket.on('spectateApproved', (data) => {
    hideStartPrompt();
    isSpectating = true;
    spectatingRoomId = data.roomId;
    rememberRoomContext(data.roomId, 'spectator');
    showToast('观战请求已通过');
    showScreen('gameScreen');
    const leaveBtn = document.getElementById('gameLeaveBtn');
    if (leaveBtn) leaveBtn.classList.add('hidden');
    document.getElementById('spectatorBadge').classList.remove('hidden');
    document.getElementById('myHandArea').classList.add('hidden');
    document.getElementById('spectatorControls').classList.remove('hidden');
    document.getElementById('cardCounterPanel').classList.remove('hidden');
    document.getElementById('otherPlayersArea').classList.add('hidden');
    document.getElementById('spectatorAllPlayers').classList.remove('hidden');
  });

  socket.on('spectateDenied', () => {
    showToast('观战请求被拒绝');
  });

  socket.on('spectatorGameState', (state) => {
    gameState = state;
    rememberRoomContext(state.roomId || spectatingRoomId, 'spectator');
    clearSelectionState();
    showScreen('gameScreen');
    const leaveBtn = document.getElementById('gameLeaveBtn');
    if (leaveBtn) leaveBtn.classList.add('hidden');
    renderSpectatorState(state);
  });

  socket.on('spectateEnded', () => {
    document.getElementById('gameOverlay').classList.add('hidden');
    resetSpectatorUI();
    clearRoomContext();
    showScreen('lobbyScreen');
    refreshRooms();
    showToast('本局已结束，观战已退出');
  });

  socket.on('connect_error', (err) => {
    console.error('Connection error:', err.message);
    if (isAuthFailureMessage(err.message)) {
      handleAuthExpired('登录状态已失效，请重新登录');
      return;
    }
    showConnectionToast('连接服务器失败：' + err.message);
  });
}

function leaveRoom() {
  if (!currentRoom) return;
  socket.emit('leaveRoom', { roomId: currentRoom.id }, (res) => {
    if (!res?.success) {
      if (res?.error) showToast(res.error);
      return;
    }

    hideStartPrompt();
    document.getElementById('gameOverlay').classList.add('hidden');
    currentRoom = null;
    gameState = null;
    clearRoomContext();
    clearSelectionState();
    showScreen('lobbyScreen');
    refreshRooms();

    if (res.mode === 'playing') {
      showToast('已退出对局，AI 将接管座位；回来后会自动接回');
    } else if (res.mode === 'spectator') {
      showToast('已退出观战');
    }
  });
}

function leaveCurrentGame() {
  if (!currentRoom) return;
  if (!confirm('退出后将由 AI 接管当前座位，确定离开这局游戏吗？')) return;
  leaveRoom();
}

// ============ CHAT ============
function addChatMessage(displayName, message, username = displayName) {
  const container = document.getElementById('chatMessages');
  // Remove placeholder if present
  const placeholder = container.querySelector('.chat-placeholder');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.className = 'chat-message';
  const isSystem = username === '系统';
  div.innerHTML = `<span class="chat-user${isSystem ? ' system' : ''}">${escapeHtml(displayName)}:</span> <span class="chat-text">${escapeHtml(message)}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  // Keep max 100 messages
  while (container.children.length > 100) {
    container.firstChild.remove();
  }

  // Show unread dot if chat is collapsed
  const panel = document.getElementById('chatPanel');
  if (panel.classList.contains('collapsed')) {
    document.getElementById('chatUnread').classList.remove('hidden');
  }
}

function sendChat() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg || !currentRoom) return;
  socket.emit('chat', { roomId: currentRoom.id, message: msg });
  input.value = '';
}

function getCardSortKey(cardObj) {
  const cardId = typeof cardObj === 'string' ? cardObj : cardObj.id;
  if (cardId === 'X' || cardId === 'D') {
    return { value: CARD_VALUE_MAP[cardId], suit: 4, id: cardId, uid: typeof cardObj === 'string' ? cardId : cardObj.uid };
  }
  const suit = cardId[0];
  const rank = cardId.substring(1);
  return {
    value: CARD_VALUE_MAP[rank] || 0,
    suit: SUIT_ORDER_MAP[suit] ?? 99,
    id: cardId,
    uid: typeof cardObj === 'string' ? cardId : cardObj.uid
  };
}

function sortCardsForDisplay(cards) {
  return [...(cards || [])].sort((a, b) => {
    const ka = getCardSortKey(a);
    const kb = getCardSortKey(b);
    return ka.value - kb.value || ka.suit - kb.suit || String(ka.uid || ka.id).localeCompare(String(kb.uid || kb.id));
  });
}

function sortSelectedUidsForPlay(uids) {
  const handMap = new Map((gameState?.myHand || []).map(card => [card.uid, card]));
  return [...uids].sort((a, b) => {
    const cardA = handMap.get(a) || { uid: a, id: a };
    const cardB = handMap.get(b) || { uid: b, id: b };
    const ka = getCardSortKey(cardA);
    const kb = getCardSortKey(cardB);
    return ka.value - kb.value || ka.suit - kb.suit || String(a).localeCompare(String(b));
  });
}

function renderMiniCard(cardId) {
  const { suit, rank, color } = parseCard(cardId);
  return `<span class="card-mini ${color}">${suit}${rank}</span>`;
}

function loadCustomHandZones() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_HAND_ZONES_KEY) || '{}');
  } catch (error) {
    return {};
  }
}

function saveCustomHandZones() {
  localStorage.setItem(CUSTOM_HAND_ZONES_KEY, JSON.stringify(customHandZones));
}

function toggleChat() {
  const panel = document.getElementById('chatPanel');
  const badge = document.getElementById('chatBadge');
  const isCollapsed = panel.classList.toggle('collapsed');
  badge.classList.toggle('hidden', !isCollapsed);
  if (!isCollapsed) {
    document.getElementById('chatUnread').classList.add('hidden');
    document.getElementById('chatInput').focus();
  }
}

function showChatUI() {
  document.getElementById('chatBadge').classList.remove('hidden');
  document.getElementById('chatPanel').classList.add('collapsed');
}

function hideChatUI() {
  document.getElementById('chatBadge').classList.add('hidden');
  document.getElementById('chatPanel').classList.add('collapsed');
  const container = document.getElementById('chatMessages');
  container.innerHTML = '<div class="chat-message chat-placeholder" style="color:var(--text-quaternary)">暂无消息</div>';
}

function renderRoomState(state) {
  document.getElementById('roomTitle').textContent = state.name;
  document.getElementById('roomStatusBadge').textContent =
    state.status === 'waiting' ? '等待中' : state.status === 'playing' ? '游戏中' : '已结束';

  const grid = document.getElementById('seatGrid');
  grid.innerHTML = state.players.map((player) => {
    if (!player) {
      return `
        <div class="seat-card">
          <div class="seat-avatar">+</div>
          <div class="seat-name" style="color:var(--text-quaternary)">空位</div>
          <div class="seat-status">等待加入</div>
        </div>`;
    }

    const isMe = player.username === currentUser.username;
    const isOwner = player.username === state.owner;
    const canKick = state.owner === currentUser.username && !isMe && !player.isAI && state.status === 'waiting';
    const displayName = getDisplayName(player, player.username);

    return `
      <div class="seat-card ${player.ready ? 'ready' : ''} ${isMe ? 'is-me' : ''} occupied">
        <div class="seat-avatar">${renderAvatar(player.originalUsername || player.username, player.avatarData, { ai: player.isAI })}</div>
        <div class="seat-name">${escapeHtml(displayName)}${isMe ? '（我）' : ''}</div>
        ${isOwner ? '<div class="seat-owner">房主</div>' : ''}
        <div class="seat-status">${player.isAI ? 'AI 补位' : (player.ready ? '已准备' : '未准备')}</div>
        ${canKick ? `<div class="seat-kick" onclick="kickPlayer('${escapeHtml(player.username)}')">移出</div>` : ''}
      </div>`;
  }).join('');

  const isOwner = state.owner === currentUser.username;
  const startBtn = document.getElementById('startBtn');
  const readyBtn = document.getElementById('readyBtn');
  const summary = document.getElementById('roomReadySummary');
  const me = state.players.find(player => player && player.username === currentUser.username);

  if (summary) {
    summary.textContent = state.status === 'waiting'
      ? `真人已准备 ${state.readyHumanCount}/${state.humanPlayerCount}，空位 ${state.emptySeatCount} 个，开始后将由 AI 自动补位。`
      : '对局进行中，等待本局结束后可重新准备。';
  }

  renderRoomSettingsPanel(state);

  if (state.status === 'waiting' && me) {
    readyBtn.classList.remove('hidden');
    readyBtn.textContent = me.ready ? '取消准备' : '准备';
    readyBtn.className = me.ready ? 'btn btn-ghost' : 'btn btn-primary';
  } else {
    readyBtn.classList.add('hidden');
  }

  if (state.status === 'waiting' && isOwner) {
    startBtn.classList.remove('hidden');
    startBtn.disabled = !state.startable;
    startBtn.textContent = state.startable ? '开始对局' : '等待准备';
  } else {
    startBtn.classList.add('hidden');
  }
}

function renderRoomSettingsPanel(state) {
  const panel = document.getElementById('roomSettingsPanel');
  if (!panel) return;
  const settings = state.settings || { baseScore: 10, doubleEnabled: false, allowOpenCards: false, label: '10分底 · 1倍' };
  const isOwner = state.owner === currentUser.username;
  const canEdit = isOwner && state.status === 'waiting';

  if (!canEdit) {
    panel.innerHTML = `<div class="room-settings-readonly">
      <span>本局设置</span>
      <strong>${escapeHtml(settings.label || '1倍')}</strong>
    </div>`;
    return;
  }

  panel.innerHTML = `<div class="room-settings-editor">
    <span>房主设置</span>
    <input class="room-settings-score-input" type="number" id="roomSettingsBaseScore" min="1" max="100000" step="1" value="${Number(settings.baseScore) || 10}" onchange="updateRoomSettingsFromPanel()">
    <label class="checkbox-row compact">
      <input type="checkbox" id="roomSettingsDoubleEnabled" ${settings.doubleEnabled ? 'checked' : ''} onchange="updateRoomSettingsFromPanel()">
      <span>加倍</span>
    </label>
    <label class="checkbox-row compact">
      <input type="checkbox" id="roomSettingsOpenCards" ${settings.allowOpenCards ? 'checked' : ''} onchange="updateRoomSettingsFromPanel()">
      <span>允许明牌</span>
    </label>
  </div>`;
}

function updateRoomSettingsFromPanel() {
  if (!currentRoom || currentRoom.owner !== currentUser.username || currentRoom.status !== 'waiting') return;
  const settings = {
    baseScore: Number(document.getElementById('roomSettingsBaseScore')?.value || 10),
    doubleEnabled: Boolean(document.getElementById('roomSettingsDoubleEnabled')?.checked),
    allowOpenCards: Boolean(document.getElementById('roomSettingsOpenCards')?.checked)
  };
  socket.emit('updateRoomSettings', { roomId: currentRoom.id, settings }, (res) => {
    if (res?.success === false) showToast(res.error || '设置保存失败');
  });
}

function updateRevealHandButton(state) {
  const btn = document.getElementById('revealHandBtn');
  if (!btn) return;

  const revealedPlayers = state?.revealedPlayers || state?.settings?.revealedPlayers || [];
  const alreadyRevealed = revealedPlayers.includes(state?.myName);
  const canReveal = Boolean(
    currentRoom
    && !isSpectating
    && ['doubling', 'playing'].includes(state?.phase)
    && state?.settings?.allowOpenCards
    && state?.myName
    && !alreadyRevealed
    && Array.isArray(state.myHand)
    && state.myHand.length > 0
  );

  btn.classList.toggle('hidden', !canReveal);
  btn.disabled = !canReveal;
  btn.textContent = alreadyRevealed
    ? '已明牌'
    : (state.revealMultiplierAvailable === false ? '明牌(不加倍)' : '明牌');
}

function revealMyHand() {
  if (!currentRoom || !gameState) return;
  const multiplierAvailable = gameState.revealMultiplierAvailable !== false;
  const confirmText = multiplierAvailable
    ? '明牌后你的手牌会对所有玩家可见，并按5倍计入本局总倍数。确定明牌吗？'
    : '明牌后你的手牌会对所有玩家可见；本局已有出牌记录，本次明牌不再加倍。确定明牌吗？';
  if (!confirm(confirmText)) return;

  socket.emit('revealHand', { roomId: currentRoom.id }, (res) => {
    if (!res?.success) {
      showToast(res?.error || '明牌失败');
      return;
    }
    showToast(res.multiplierApplied
      ? `已明牌，当前倍数 ${res.scoreMultiplier} 倍`
      : '已明牌，本次不加倍');
  });
}

function chooseDouble(doubled) {
  if (!currentRoom || !gameState) return;
  socket.emit('chooseDouble', { roomId: currentRoom.id, doubled }, (res) => {
    if (!res?.success) {
      showToast(res?.error || '选择加倍失败');
      return;
    }
    showToast(doubled ? `已加倍，当前倍数 ${res.scoreMultiplier} 倍` : '已选择不加倍');
  });
}

function renderOtherPlayerCards(container, lastPlayHtml, visibleHand) {
  if (!container) return;
  const visibleCards = Array.isArray(visibleHand) && visibleHand.length > 0
    ? `<div class="visible-hand-strip">${sortCardsForDisplay(visibleHand).map(card => renderMiniCard(typeof card === 'string' ? card : card.id)).join('')}</div>`
    : '';
  container.innerHTML = `${lastPlayHtml || ''}${visibleCards}`;
}

function manualStart() {
  if (!currentRoom) return;
  if (!currentRoom.startable) {
    showToast('请等待所有真人玩家准备后再开始');
    return;
  }
  showStartPrompt(currentRoom);
}

function renderGameState(state) {
  resetPlayerGameUI();

  const markedEl = document.getElementById('markedCardDisplay');
  if (state.markedCard) {
    const { suit, rank, color } = parseCard(state.markedCard);
    markedEl.className = `card-mini ${color}`;
    markedEl.textContent = `${suit}${rank}`;
  } else {
    markedEl.className = 'card-mini';
    markedEl.textContent = '-';
  }

  const landlordLabel = document.getElementById('landlordLabel');
  let landlordText = `大地主 ${state.landlordDisplayName || getGameDisplayName(state.landlord, state)}`;
  if (state.hiddenLandlord) {
    landlordText += ` | 小地主 ${state.hiddenLandlordDisplayName || getGameDisplayName(state.hiddenLandlord, state)}`;
  }
  landlordLabel.textContent = landlordText;
  const multiplierBadge = document.getElementById('gameMultiplierBadge');
  if (multiplierBadge) multiplierBadge.textContent = state.settings?.label || '';

  const turnIndicator = document.getElementById('turnIndicator');
  if (state.phase === 'selectingMarked') {
    turnIndicator.textContent = state.myName === state.landlord ? '请选择明牌' : `等待 ${state.landlordDisplayName || getGameDisplayName(state.landlord, state)} 选择明牌`;
  } else if (state.phase === 'doubling') {
    const doubleDecisions = state.doubleDecisions || {};
    const decidedCount = Object.keys(doubleDecisions).length;
    turnIndicator.textContent = Object.prototype.hasOwnProperty.call(doubleDecisions, state.myName)
      ? `等待其他玩家选择加倍（${decidedCount}/5）`
      : '请选择是否加倍';
  } else {
    turnIndicator.textContent = state.isMyTurn ? '轮到你出牌' : `等待 ${state.currentPlayerDisplayName || getGameDisplayName(state.currentPlayer, state)} 出牌`;
  }
  turnIndicator.classList.toggle('my-turn', Boolean(state.isMyTurn && state.phase === 'playing'));

  const myIdx = state.players.findIndex(player => player.name === state.myName);
  const otherPlayers = [];
  for (let i = 1; i <= 4; i++) {
    otherPlayers.push(state.players[(myIdx + i) % 5]);
  }

  otherPlayers.forEach((player, index) => {
    const el = document.getElementById(`player${index + 1}`);
    const nameEl = el.querySelector('.player-name');
    const countEl = el.querySelector('.card-count-badge');
    const lastPlayEl = el.querySelector('.player-last-play');
    const avatarEl = el.querySelector('.avatar-circle');

    const displayName = getDisplayName(player, player.name);
    nameEl.textContent = displayName + (player.isLandlord ? ' 地主' : '') + (player.isHiddenLandlord ? ' 暗地主' : '');
    const showCount = player.cardCount <= 15;
    countEl.textContent = showCount ? `${player.cardCount} 张` : '';
    countEl.classList.toggle('hidden-count', !showCount);
    if (avatarEl) avatarEl.innerHTML = renderAvatar(player.originalUsername || player.name, player.avatarData);

    el.className = 'other-player';
    if (player.name === state.currentPlayer) el.classList.add('current-turn');
    if (player.isLandlord) el.classList.add('is-landlord');
    if (player.isHiddenLandlord) el.classList.add('is-hidden-landlord');

    const lastTurn = [...(state.turnHistory || [])].reverse().find(turn => turn.player === player.name);
    if (!lastTurn) {
      renderOtherPlayerCards(lastPlayEl, '', state.visibleHands?.[player.name]);
      return;
    }

    if (lastTurn.action === 'pass') {
      renderOtherPlayerCards(lastPlayEl, '<span class="spectator-pass">不出</span>', state.visibleHands?.[player.name]);
      return;
    }

    const lastPlayHtml = sortCardsForDisplay(lastTurn.cards || []).map(cardId => renderMiniCard(cardId)).join(' ');
    renderOtherPlayerCards(lastPlayEl, lastPlayHtml, state.visibleHands?.[player.name]);
  });

  const lastPlayDisplay = document.getElementById('lastPlayDisplay');
  if (state.lastPlay) {
    lastPlayDisplay.innerHTML = sortCardsForDisplay(state.lastPlay.cards).map(cardId => {
      const { suit, rank, color } = parseCard(cardId);
      return `<div class="display-card ${color}">
        <span class="card-rank">${rank}</span>
        <span class="card-suit">${suit}</span>
      </div>`;
    }).join('');
  } else {
    lastPlayDisplay.innerHTML = '<span style="color:var(--text-quaternary);font-size:14px">新一轮开始</span>';
  }

  renderMyHand(state.myHand || []);
  updateRevealHandButton(state);

  const passBtn = document.getElementById('passBtn');
  const playBtn = document.getElementById('playBtn');
  const hintBtn = document.getElementById('hintBtn');
  const markedSelectionArea = document.getElementById('markedSelectionArea');
  const doubleSelectionArea = document.getElementById('doubleSelectionArea');
  const gameActions = document.getElementById('gameActions');

  if (state.phase === 'selectingMarked') {
    if (doubleSelectionArea) doubleSelectionArea.classList.add('hidden');
    if (state.myName === state.landlord) {
      markedSelectionArea.classList.remove('hidden');
      gameActions.classList.add('hidden');
    } else {
      markedSelectionArea.classList.add('hidden');
      gameActions.classList.add('hidden');
    }
  } else if (state.phase === 'doubling') {
    markedSelectionArea.classList.add('hidden');
    gameActions.classList.add('hidden');
    if (doubleSelectionArea) {
      const doubleDecisions = state.doubleDecisions || {};
      const alreadyDecided = Object.prototype.hasOwnProperty.call(doubleDecisions, state.myName);
      const hintEl = document.getElementById('doubleSelectionHint');
      if (hintEl) {
        hintEl.textContent = alreadyDecided
          ? `你已选择${doubleDecisions[state.myName] ? '加倍' : '不加倍'}，等待其他玩家`
          : `请选择是否加倍（已选择 ${Object.keys(doubleDecisions).length}/5）`;
      }
      doubleSelectionArea.classList.toggle('hidden', alreadyDecided);
    }
  } else {
    markedSelectionArea.classList.add('hidden');
    if (doubleSelectionArea) doubleSelectionArea.classList.add('hidden');
    gameActions.classList.remove('hidden');
    gameActions.style.display = '';
    playBtn.style.display = '';
    passBtn.style.display = '';
    if (hintBtn) hintBtn.style.display = '';
    playBtn.disabled = !state.isMyTurn;
    passBtn.disabled = !state.isMyTurn || state.mustPlay;
    if (hintBtn) hintBtn.disabled = !state.isMyTurn;
  }

  updateSelectionHint();
}

function setHandDisplayMode(mode) {
  if (!['flat', 'stack', 'custom'].includes(mode)) return;
  handDisplayMode = mode;
  localStorage.setItem(HAND_MODE_STORAGE_KEY, mode);
  renderMyHand(gameState?.myHand || []);
}

function syncHandModeButtons() {
  document.querySelectorAll('.hand-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === handDisplayMode);
  });
}

function renderHandCard(cardObj, options = {}) {
  const cardId = typeof cardObj === 'string' ? cardObj : cardObj.id;
  const cardUid = typeof cardObj === 'string' ? cardObj : cardObj.uid;
  const { suit, rank, color, isJoker, isBig } = parseCard(cardId);
  const jokerClass = isJoker ? (isBig ? 'joker-big' : 'joker-small') : '';
  const selected = selectedCards.has(cardUid) ? 'selected' : '';
  const draggable = handDisplayMode === 'custom' ? ' draggable="true"' : '';
  return `<div class="game-card ${color} ${jokerClass} ${selected}" data-uid="${cardUid}" data-id="${cardId}"${draggable}>
    <span class="card-rank">${rank}</span>
    <span class="card-suit">${suit}</span>
    ${options.zoneHint ? '<span class="zone-dot"></span>' : ''}
  </div>`;
}

function renderFlatHand(hand) {
  return sortCardsForDisplay(hand).map(cardObj => renderHandCard(cardObj)).join('');
}

function renderStackHand(hand) {
  const groups = new Map();
  for (const card of sortCardsForDisplay(hand)) {
    const cardId = typeof card === 'string' ? card : card.id;
    if (!groups.has(cardId)) groups.set(cardId, []);
    groups.get(cardId).push(card);
  }
  return [...groups.entries()].map(([, cards]) => `
    <div class="hand-stack" style="--stack-size:${cards.length}">
      ${cards.map(card => renderHandCard(card)).join('')}
    </div>
  `).join('');
}

function getCardZone(cardObj, index, total) {
  const uid = typeof cardObj === 'string' ? cardObj : cardObj.uid;
  if (customHandZones[uid]) return customHandZones[uid];
  const zone = Math.min(4, Math.max(1, Math.ceil(((index + 1) / Math.max(total, 1)) * 4)));
  customHandZones[uid] = zone;
  return zone;
}

function renderCustomHand(hand) {
  const sorted = sortCardsForDisplay(hand);
  const knownUids = new Set(sorted.map(card => typeof card === 'string' ? card : card.uid));
  for (const uid of Object.keys(customHandZones)) {
    if (!knownUids.has(uid)) delete customHandZones[uid];
  }
  const zones = [1, 2, 3, 4].map(zone => ({ zone, cards: [] }));
  sorted.forEach((card, index) => {
    zones[getCardZone(card, index, sorted.length) - 1].cards.push(card);
  });
  saveCustomHandZones();

  return zones.map(({ zone, cards }) => `
    <div class="hand-zone" data-zone="${zone}">
      <div class="hand-zone-title">分区 ${zone}</div>
      <div class="hand-zone-cards">
        ${cards.map(card => renderHandCard(card, { zoneHint: true })).join('')}
      </div>
    </div>
  `).join('');
}

function renderMyHand(hand) {
  const container = document.getElementById('myHand');
  const handList = Array.isArray(hand) ? hand : [];
  const countEl = document.getElementById('myCardCount');
  if (countEl) countEl.textContent = `我的手牌 ${handList.length} 张`;
  syncHandModeButtons();

  container.className = `my-hand hand-mode-${handDisplayMode}`;
  if (handDisplayMode === 'stack') {
    container.innerHTML = renderStackHand(handList);
  } else if (handDisplayMode === 'custom') {
    container.innerHTML = renderCustomHand(handList);
  } else {
    container.innerHTML = renderFlatHand(handList);
  }
  updateSelectionHint();
}

function passCards() {
  if (!currentRoom) return;
  socket.emit('pass', { roomId: currentRoom.id });
  clearSelectionState();
  updateSelectionHint();
}

function confirmMarkedCards() {
  if (!currentRoom) return;
  if (selectedCards.size !== 2) return showToast('请选择 2 张同花色同数字的牌');
  const cards = Array.from(selectedCards);
  socket.emit('selectMarkedCards', { roomId: currentRoom.id, cards });
  clearSelectionState();
  updateSelectionHint();
}

function applyHint(hintUids) {
  selectedCards.clear();
  for (const uid of hintUids) {
    selectedCards.add(uid);
  }
  renderMyHand(gameState.myHand);
  document.querySelectorAll('.game-card.selected').forEach(el => el.classList.add('hint'));
  updateSelectionHint();
}

function leaveSpectate() {
  if (!spectatingRoomId) return;
  socket.emit('leaveSpectate', { roomId: spectatingRoomId }, () => {
    resetSpectatorUI();
    showScreen('lobbyScreen');
    refreshRooms();
    showToast('已退出观战');
  });
}

initializeCardSelectionGestures();
// ============ INIT ============
(function init() {
  // Apply saved theme
  const savedTheme = localStorage.getItem('doudizhu_theme');
  if (savedTheme === 'dark') {
    document.documentElement.classList.add('force-dark');
  } else if (savedTheme === 'light') {
    document.documentElement.classList.add('force-light');
  }

  const adminToken = localStorage.getItem('doudizhu_admin_token');
  const adminUser = localStorage.getItem('doudizhu_admin_user');
  if (adminToken && isAdminUsername(adminUser)) {
    window.location.replace('/admin.html');
    return;
  }

  // Check for saved session
  const token = localStorage.getItem('doudizhu_token');
  const username = localStorage.getItem('doudizhu_user');
  if (isAdminUsername(username)) {
    localStorage.removeItem('doudizhu_token');
    localStorage.removeItem('doudizhu_user');
    return;
  }
  if (token && username) {
    const nickname = localStorage.getItem(USER_NICKNAME_STORAGE_KEY) || username;
    currentUser = { username, nickname, displayName: nickname, token, avatarData: localStorage.getItem(USER_AVATAR_STORAGE_KEY) || null };
    connectSocket();
    showScreen('lobbyScreen');
    updateUserBadge();
    refreshRooms();
    loadUserStats();
    loadProfile();
    handleInviteFromUrl();
  }
})();

