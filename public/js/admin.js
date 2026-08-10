const adminState = {
  token: localStorage.getItem('doudizhu_admin_token') || '',
  username: localStorage.getItem('doudizhu_admin_user') || '',
  selectedUser: null,
  selectedGame: null,
  overview: null,
  users: [],
  games: [],
  spectatingRoomId: '',
  spectateTimer: null,
  spectateLoading: false,
  aiSettings: {
    difficulty: 'normal',
    label: '标准',
    llmEnabled: false,
    llmApiUrl: 'http://sub.stzo.cn:11666/v1',
    llmModel: 'K2.6-Inst',
    llmApiKeyConfigured: false
  }
};

const adminPendingActions = new Set();

const AI_DIFFICULTY_SUMMARIES = {
  easy: '休闲模式：AI 更保守，少用复杂拆牌，适合陪练或降低托管压迫感。',
  normal: '标准模式：AI 会优先少拆牌、少浪费炸弹，并按残局压力排序提示。',
  hard: '高级协作：AI 会识别已知队友，通常不压队友；敌方残牌时会主动拦截。'
};

function showAdminScreen(screen) {
  document.getElementById('adminLoginScreen').classList.toggle('hidden', screen !== 'login');
  document.getElementById('adminDashboardScreen').classList.toggle('hidden', screen !== 'dashboard');
}

function showAdminLoginError(message) {
  const el = document.getElementById('adminLoginError');
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearAdminLoginError() {
  document.getElementById('adminLoginError').classList.add('hidden');
}

function setAdminAuth(token, username) {
  adminState.token = token;
  adminState.username = username;
  localStorage.setItem('doudizhu_admin_token', token);
  localStorage.setItem('doudizhu_admin_user', username);
  document.getElementById('adminCurrentUser').textContent = username;
}

function clearAdminAuth() {
  adminState.token = '';
  adminState.username = '';
  adminState.selectedUser = null;
  adminState.selectedGame = null;
  closeAdminSpectate();
  localStorage.removeItem('doudizhu_admin_token');
  localStorage.removeItem('doudizhu_admin_user');
}

function goToGameHome() {
  window.location.href = '/';
}

function applySavedTheme() {
  const savedTheme = localStorage.getItem('doudizhu_theme');
  document.documentElement.classList.remove('force-dark', 'force-light');
  if (savedTheme === 'dark') {
    document.documentElement.classList.add('force-dark');
  } else if (savedTheme === 'light') {
    document.documentElement.classList.add('force-light');
  }
}

function toggleAdminTheme() {
  const isDark = document.documentElement.classList.toggle('force-dark');
  document.documentElement.classList.toggle('force-light', !isDark);
  localStorage.setItem('doudizhu_theme', isDark ? 'dark' : 'light');
}

async function adminFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (adminState.token) {
    headers.set('Authorization', `Bearer ${adminState.token}`);
  }
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    adminLogout(false);
    throw new Error(data.error || '管理员登录已失效，请重新登录');
  }
  if (!response.ok) {
    throw new Error(data.error || '请求失败');
  }
  return data;
}

async function adminLogin() {
  const username = document.getElementById('adminUsername').value.trim();
  const password = document.getElementById('adminPassword').value;
  if (!username || !password) {
    showAdminLoginError('请输入管理员账号和密码');
    return;
  }

  clearAdminLoginError();
  try {
    const data = await adminFetch('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    setAdminAuth(data.token, data.username);
    document.getElementById('adminPassword').value = '';
    showAdminScreen('dashboard');
    await refreshAdminDashboard();
    showToast('后台登录成功');
  } catch (error) {
    showAdminLoginError(error.message || '登录失败');
  }
}

function adminLogout(showMessage = true) {
  clearAdminAuth();
  showAdminScreen('login');
  if (showMessage) {
    showToast('已退出后台');
  }
}

function selectAdminTab(tabName) {
  document.querySelectorAll('.admin-tab-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.tab === tabName);
  });
  document.querySelectorAll('.admin-tab').forEach(section => {
    section.classList.toggle('hidden', section.id !== `adminTab-${tabName}`);
    section.classList.toggle('active', section.id === `adminTab-${tabName}`);
  });
}

function formatDateTime(value) {
  if (!value) return '-';
  const normalized = String(value).endsWith('Z') ? value : `${value}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function setAdminActionBusy(key, busy) {
  document.querySelectorAll(`[data-action-key="${CSS.escape(key)}"]`).forEach(button => {
    button.disabled = busy;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = '处理中...';
    } else if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  });
}

async function withAdminActionLock(key, action) {
  if (adminPendingActions.has(key)) {
    showToast('操作处理中，请勿重复点击');
    return null;
  }
  adminPendingActions.add(key);
  setAdminActionBusy(key, true);
  try {
    return await action();
  } finally {
    adminPendingActions.delete(key);
    setAdminActionBusy(key, false);
  }
}

function getEntityUsername(entity) {
  return typeof entity === 'string' ? entity : (entity?.username || entity?.name || '');
}

function getDisplayName(entity, fallback = '') {
  if (!entity) return fallback;
  if (typeof entity === 'string') return entity;
  return entity.displayName || entity.nickname || entity.name || entity.username || fallback;
}

function getGameDisplayName(username, state) {
  return state?.playerDisplayNames?.[username] || username;
}

function renderRoomPlayerChip(roomId, detail) {
  const tags = [];
  if (detail.isAI) {
    tags.push(detail.originalUsername ? `AI 托管 ${escapeHtml(detail.originalUsername)}` : 'AI 补位');
  } else {
    tags.push(detail.ready ? '已准备' : '未准备');
  }
  if (detail.rejoinable) {
    tags.push('可重连');
  }

  return `
    <div class="admin-member-chip ${detail.isAI ? 'is-ai' : ''} ${detail.ready ? 'is-ready' : ''}">
      <div class="admin-member-chip-main">
        <span class="admin-member-name">${escapeHtml(getDisplayName(detail, detail.username))}</span>
        <span class="admin-member-sub">@${escapeHtml(detail.originalUsername || detail.username)}</span>
        <span class="admin-member-tags">${tags.join(' · ')}</span>
      </div>
      ${detail.isAI ? '' : `<button class="btn btn-danger btn-sm" data-action-key="remove:${escapeHtml(roomId)}:player:${escapeHtml(detail.username)}" data-room-id="${escapeHtml(roomId)}" data-username="${escapeHtml(detail.username)}" data-mode="player" onclick="removeRoomMember(this.dataset.roomId, this.dataset.username, this.dataset.mode)">移出</button>`}
    </div>
  `;
}

function renderRoomSpectatorChip(roomId, spectator) {
  const username = getEntityUsername(spectator);
  return `
    <div class="admin-member-chip is-spectator">
      <div class="admin-member-chip-main">
        <span class="admin-member-name">${escapeHtml(getDisplayName(spectator, username))}</span>
        <span class="admin-member-sub">@${escapeHtml(username)}</span>
        <span class="admin-member-tags">观战中</span>
      </div>
      <button class="btn btn-danger btn-sm" data-action-key="remove:${escapeHtml(roomId)}:spectator:${escapeHtml(username)}" data-room-id="${escapeHtml(roomId)}" data-username="${escapeHtml(username)}" data-mode="spectator" onclick="removeRoomMember(this.dataset.roomId, this.dataset.username, this.dataset.mode)">移出</button>
    </div>
  `;
}

async function stopRoom(roomId) {
  if (!roomId) return;
  if (!confirm(`确定停止房间 ${roomId} 的当前对局吗？玩家会被退回房间等待区。`)) return;
  await withAdminActionLock(`stop:${roomId}`, async () => {
    try {
      const result = await adminFetch(`/api/admin/rooms/${encodeURIComponent(roomId)}/stop`, {
        method: 'POST'
      });
      if (adminState.spectatingRoomId === roomId) {
        closeAdminSpectate();
      }
      await refreshAdminDashboard();
      showToast(result.closed ? `房间 ${roomId} 已停止并关闭` : `房间 ${roomId} 对局已停止`);
    } catch (error) {
      showToast(error.message || '停止对局失败');
    }
  });
}

async function deleteRoom(roomId) {
  if (!roomId) return;
  if (!confirm(`确定删除房间 ${roomId} 吗？房间内玩家和观战者都会被移出。`)) return;
  await withAdminActionLock(`delete:${roomId}`, async () => {
    try {
      await adminFetch(`/api/admin/rooms/${encodeURIComponent(roomId)}`, {
        method: 'DELETE'
      });
      if (adminState.spectatingRoomId === roomId) {
        closeAdminSpectate();
      }
      await refreshAdminDashboard();
      showToast(`房间 ${roomId} 已删除`);
    } catch (error) {
      showToast(error.message || '删除房间失败');
    }
  });
}

async function removeRoomMember(roomId, username, mode = 'player') {
  if (!roomId || !username) return;
  const targetLabel = mode === 'spectator' ? '观战者' : '玩家';
  if (!confirm(`确定将${targetLabel} ${username} 移出房间 ${roomId} 吗？`)) return;
  await withAdminActionLock(`remove:${roomId}:${mode}:${username}`, async () => {
    try {
      const result = await adminFetch(`/api/admin/rooms/${encodeURIComponent(roomId)}/remove-member`, {
        method: 'POST',
        body: JSON.stringify({ username })
      });
      if (adminState.spectatingRoomId === roomId && result.closed) {
        closeAdminSpectate();
      }
      await refreshAdminDashboard();
      showToast(`已移出${targetLabel} ${username}`);
    } catch (error) {
      showToast(error.message || '移出成员失败');
    }
  });
}

function renderOverview(overview) {
  document.getElementById('adminCurrentUser').textContent = adminState.username || '管理员';
  document.getElementById('overviewUserCount').textContent = overview.userCount ?? 0;
  document.getElementById('overviewHistoryCount').textContent = overview.historyCount ?? 0;
  document.getElementById('overviewTotalScore').textContent = overview.totalScore ?? 0;
  document.getElementById('overviewLiveStats').textContent = `${overview.onlineUsers ?? 0} / ${overview.roomCount ?? 0}`;
  renderAiSettings(overview.aiSettings);
}

function renderAiSettings(settings) {
  const difficulty = settings?.difficulty || 'normal';
  adminState.aiSettings = {
    difficulty,
    label: settings?.label || (difficulty === 'hard' ? '高级协作' : difficulty === 'easy' ? '休闲' : '标准'),
    llmEnabled: Boolean(settings?.llmEnabled),
    llmApiUrl: settings?.llmApiUrl || 'http://sub.stzo.cn:11666/v1',
    llmModel: settings?.llmModel || 'K2.6-Inst',
    llmApiKeyConfigured: Boolean(settings?.llmApiKeyConfigured)
  };

  const select = document.getElementById('aiDifficultySelect');
  if (select) select.value = adminState.aiSettings.difficulty;

  const llmEnabled = document.getElementById('aiLlmEnabled');
  if (llmEnabled) llmEnabled.checked = adminState.aiSettings.llmEnabled;

  const llmApiUrl = document.getElementById('aiLlmApiUrl');
  if (llmApiUrl) llmApiUrl.value = adminState.aiSettings.llmApiUrl;

  const llmModel = document.getElementById('aiLlmModel');
  if (llmModel) llmModel.value = adminState.aiSettings.llmModel;

  const keyStatus = document.getElementById('aiLlmKeyStatus');
  if (keyStatus) {
    keyStatus.textContent = adminState.aiSettings.llmApiKeyConfigured
      ? 'LLM API Key 状态：已配置（密钥仅保存在 Cloudflare Secret，不会展示）'
      : 'LLM API Key 状态：未配置，开启后仍会自动回退本地 AI';
  }

  const summary = document.getElementById('aiDifficultySummary');
  if (summary) {
    const llmText = adminState.aiSettings.llmEnabled
      ? 'LLM 已开启：仅高级协作模式会调用，失败会自动回退本地策略。'
      : 'LLM 未开启：使用本地 AI 策略。';
    summary.textContent = `${AI_DIFFICULTY_SUMMARIES[adminState.aiSettings.difficulty] || AI_DIFFICULTY_SUMMARIES.normal} ${llmText}`;
  }
}

function renderLiveRooms(rooms) {
  const container = document.getElementById('liveRoomsContainer');
  if (!rooms || rooms.length === 0) {
    container.innerHTML = '<div class="admin-empty">当前没有在线房间</div>';
    return;
  }

  container.innerHTML = rooms.map(room => {
    const playerDetails = (room.playerDetails || []).filter(Boolean);
    const humanPlayers = Array.isArray(room.humanPlayers)
      ? room.humanPlayers
      : playerDetails.filter(player => !player.isAI).map(player => player.username);
    const aiPlayers = Array.isArray(room.aiPlayers)
      ? room.aiPlayers
      : playerDetails.filter(player => player.isAI).map(player => player.username);
    const spectators = Array.isArray(room.spectators) ? room.spectators : [];
    const pendingSpectateRequests = Number(room.pendingSpectateRequests || 0);

    return `
      <div class="admin-room-card">
        <strong>${escapeHtml(room.name)}</strong>
        <div class="admin-room-meta">
          <span>#${escapeHtml(room.id)}</span>
          <span>房主：${escapeHtml(room.ownerDisplayName || room.owner)}</span>
          <span>状态：${formatRoomStatus(room.status)}</span>
        </div>
        <div class="admin-room-users">
          <div class="admin-room-summary">真人 ${humanPlayers.length} · AI ${aiPlayers.length} · 观战 ${spectators.length} · 待处理 ${pendingSpectateRequests}</div>
          <div class="admin-room-member-group">
            <span class="admin-room-member-label">玩家席位</span>
            <div class="admin-room-member-list">
              ${playerDetails.length
                ? playerDetails.map(detail => renderRoomPlayerChip(room.id, detail)).join('')
                : '<div class="admin-room-tip">当前没有玩家</div>'}
            </div>
          </div>
          <div class="admin-room-member-group">
            <span class="admin-room-member-label">观战列表</span>
            <div class="admin-room-member-list">
              ${spectators.length
                ? spectators.map(spectator => renderRoomSpectatorChip(room.id, spectator)).join('')
                : '<div class="admin-room-tip">当前没有观战者</div>'}
            </div>
          </div>
        </div>
        <div class="admin-room-actions">
          <div class="admin-room-action-buttons">
            ${(room.status === 'playing' || room.status === 'finished')
              ? `<button class="btn btn-ghost btn-sm" data-room-id="${escapeHtml(room.id)}" onclick="openAdminSpectate(this.dataset.roomId)">🕶️ 隐身观战</button>`
              : '<span class="admin-room-tip">开局后可隐身观战</span>'}
            ${(room.status === 'playing' || room.status === 'finished')
              ? `<button class="btn btn-accent btn-sm" data-action-key="stop:${escapeHtml(room.id)}" data-room-id="${escapeHtml(room.id)}" onclick="stopRoom(this.dataset.roomId)">停止对局</button>`
              : ''}
            <button class="btn btn-danger btn-sm" data-action-key="delete:${escapeHtml(room.id)}" data-room-id="${escapeHtml(room.id)}" onclick="deleteRoom(this.dataset.roomId)">删除房间</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function formatRoomStatus(status) {
  if (status === 'playing') return '游戏中';
  if (status === 'finished') return '已结束';
  return '等待中';
}

function clearAdminSpectatePolling() {
  if (adminState.spectateTimer) {
    clearInterval(adminState.spectateTimer);
    adminState.spectateTimer = null;
  }
  adminState.spectateLoading = false;
}

function closeAdminSpectate(resetRoomId = true) {
  clearAdminSpectatePolling();
  if (resetRoomId) {
    adminState.spectatingRoomId = '';
  }
  document.getElementById('adminSpectateModal').classList.add('hidden');
  document.getElementById('adminSpectateViewer').classList.add('hidden');
  document.getElementById('adminSpectateEmpty').classList.remove('hidden');
}

async function openAdminSpectate(roomId) {
  if (!roomId) return;

  clearAdminSpectatePolling();
  adminState.spectatingRoomId = roomId;
  document.getElementById('adminSpectateModal').classList.remove('hidden');
  document.getElementById('adminSpectateEmpty').textContent = '正在同步当前对局状态...';

  await refreshAdminSpectate();
  adminState.spectateTimer = setInterval(() => {
    refreshAdminSpectate(false).catch((error) => {
      console.error('admin spectate refresh failed', error);
    });
  }, 1500);
  showToast('已进入管理员隐身观战，不会通知房间');
}

async function refreshAdminSpectate(showErrors = true) {
  if (!adminState.spectatingRoomId || adminState.spectateLoading) return;

  adminState.spectateLoading = true;
  try {
    const data = await adminFetch(`/api/admin/rooms/${encodeURIComponent(adminState.spectatingRoomId)}/spectate`);
    renderAdminSpectateSnapshot(data);
  } catch (error) {
    if (showErrors) {
      showToast(error.message || '隐身观战同步失败');
    }
    if ((error.message || '').includes('房间不存在')) {
      closeAdminSpectate();
    }
    throw error;
  } finally {
    adminState.spectateLoading = false;
  }
}

function renderAdminSpectateSnapshot(payload) {
  const room = payload?.room || {};
  const roomState = payload?.roomState || {};
  const gameState = payload?.gameState || null;
  const title = document.getElementById('adminSpectateTitle');
  const meta = document.getElementById('adminSpectateMeta');
  const empty = document.getElementById('adminSpectateEmpty');
  const viewer = document.getElementById('adminSpectateViewer');

  title.textContent = `隐身观战 · ${room.name || room.id || adminState.spectatingRoomId}`;

  const humanPlayers = (room.humanPlayerDetails || room.humanPlayers || [])
    .map(player => getDisplayName(player, getEntityUsername(player)))
    .join('、') || '无';
  const aiPlayers = (room.aiPlayers || []).join('、') || '无';
  meta.innerHTML = `
    <span>房间ID：#${escapeHtml(room.id || adminState.spectatingRoomId)}</span>
    <span>状态：${escapeHtml(formatRoomStatus(room.status))}</span>
    <span>房主：${escapeHtml(room.ownerDisplayName || room.owner || '-')}</span>
    <span>真人：${escapeHtml(humanPlayers)}</span>
    <span>AI：${escapeHtml(aiPlayers)}</span>
    <span>普通观战：${Number(room.spectatorCount || 0)} 人</span>
    <span>待处理请求：${Number(room.pendingSpectateRequests || 0)}</span>
  `;

  if (!gameState) {
    viewer.classList.add('hidden');
    empty.classList.remove('hidden');
    const players = Array.isArray(roomState.players)
      ? roomState.players.filter(Boolean).map(player => `${getDisplayName(player, player.username)}${player.ready ? '（已准备）' : '（未准备）'}`).join('、')
      : '';
    empty.textContent = players
      ? `本房间当前未在进行对局。当前座位：${players}`
      : '本房间当前未在进行对局。';
    return;
  }

  empty.classList.add('hidden');
  viewer.classList.remove('hidden');
  renderAdminSpectateState(gameState, room.status);
}

function renderAdminSpectateState(state, roomStatus) {
  const markedEl = document.getElementById('adminSpectateMarkedCard');
  if (state.markedCard) {
    const { suit, rank, color } = parseCard(state.markedCard);
    markedEl.className = `card-mini ${color}`;
    markedEl.textContent = `${suit}${rank}`;
  } else {
    markedEl.className = 'card-mini';
    markedEl.textContent = '-';
  }

  const landlordLabel = document.getElementById('adminSpectateLandlordLabel');
  let landlordText = `大地主: ${state.landlordDisplayName || getGameDisplayName(state.landlord, state) || '-'}`;
  if (state.hiddenLandlord) {
    landlordText += ` | 小地主: ${state.hiddenLandlordDisplayName || getGameDisplayName(state.hiddenLandlord, state)}`;
  }
  landlordLabel.textContent = landlordText;

  const turnIndicator = document.getElementById('adminSpectateTurnIndicator');
  if (roomStatus === 'finished' || state.gameOver) {
    turnIndicator.textContent = `对局已结束${state.winner ? ` · ${state.winnerDisplayName || getGameDisplayName(state.winner, state)} 所在方获胜` : ''}`;
  } else if (state.phase === 'selectingMarked') {
    turnIndicator.textContent = `等待 ${state.landlordDisplayName || getGameDisplayName(state.landlord, state)} 选择明牌`;
  } else {
    turnIndicator.textContent = `等待 ${state.currentPlayerDisplayName || getGameDisplayName(state.currentPlayer, state)} 出牌`;
  }

  const container = document.getElementById('adminSpectatePlayers');
  container.innerHTML = (state.players || []).map(player => {
    const isCurrent = player.name === state.currentPlayer && roomStatus !== 'finished';
    const roleIcon = player.isLandlord ? ' 👑' : (player.isHiddenLandlord ? ' 🎭' : '');
    const displayName = getDisplayName(player, player.name);
    const handCards = state.allHands?.[player.name] || [];
    const lastTurn = [...(state.turnHistory || [])].reverse().find(turn => turn.player === player.name);
    let lastPlayHtml = '';
    if (lastTurn) {
      if (lastTurn.action === 'pass') {
        lastPlayHtml = '<span class="spectator-pass">不出</span>';
      } else {
        lastPlayHtml = (lastTurn.cards || []).map(cardId => {
          const { suit, rank, color } = parseCard(cardId);
          return `<span class="card-mini ${color}">${suit}${rank}</span>`;
        }).join(' ');
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
      <div class="spectator-player ${isCurrent ? 'current-turn' : ''} ${player.isLandlord ? 'is-landlord' : ''} ${player.isHiddenLandlord ? 'is-hidden-landlord' : ''}">
        <div class="spectator-player-header">
          <span class="spectator-player-name">${escapeHtml(displayName)}${roleIcon}</span>
          <span class="spectator-card-count">${player.cardCount}张</span>
          ${isCurrent ? '<span class="spectator-turn-badge">出牌中</span>' : ''}
        </div>
        <div class="spectator-last-play">${lastPlayHtml}</div>
        <div class="spectator-hand">${cardsHtml}</div>
      </div>`;
  }).join('');

  const lastPlayDisplay = document.getElementById('adminSpectateLastPlay');
  if (state.lastPlay) {
    lastPlayDisplay.innerHTML = state.lastPlay.cards.map(cardId => {
      const { suit, rank, color } = parseCard(cardId);
      return `<div class="display-card ${color}">
        <span class="card-rank">${rank}</span>
        <span class="card-suit">${suit}</span>
      </div>`;
    }).join('');
  } else {
    lastPlayDisplay.innerHTML = '<span style="color:var(--text-quaternary);font-size:14px">新一轮开始</span>';
  }

  renderAdminSpectateCounter(state.cardCounter || {});
}

function renderAdminSpectateCounter(counter) {
  const grid = document.getElementById('adminSpectateCounterGrid');
  const rankOrder = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '小王', '大王'];

  grid.innerHTML = rankOrder.map(rank => {
    const info = counter?.[rank];
    if (!info) return '';
    const pct = info.total > 0 ? info.left / info.total : 0;
    const colorClass = info.left === 0 ? 'counter-empty' : (pct <= 0.33 ? 'counter-low' : '');
    return `<div class="counter-item ${colorClass}">
      <span class="counter-rank">${rank}</span>
      <span class="counter-value">${info.left}/${info.total}</span>
    </div>`;
  }).join('');
}

function parseCard(cardId) {
  if (!cardId) return { suit: '', rank: '?', color: 'black', isJoker: false, isBig: false };

  if (cardId === 'X') {
    return { suit: '☆', rank: '小王', color: 'black', isJoker: true, isBig: false };
  }
  if (cardId === 'D') {
    return { suit: '★', rank: '大王', color: 'red', isJoker: true, isBig: true };
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

async function loadOverview() {
  const overview = await adminFetch('/api/admin/overview');
  adminState.overview = overview;
  renderOverview(overview);
  renderLiveRooms(overview.liveRooms || []);
}

function renderUsersTable(users) {
  const tbody = document.getElementById('userTableBody');
  if (!users || users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">没有找到用户</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(user => {
    const encoded = encodeURIComponent(user.username);
    return `
      <tr>
        <td>${escapeHtml(user.username)}</td>
        <td>${escapeHtml(user.nickname || user.username)}</td>
        <td>${Number(user.score || 0)}</td>
        <td>${Number(user.wins || 0)} / ${Number(user.losses || 0)}</td>
        <td>${Number(user.games_played || 0)}</td>
        <td>${escapeHtml(formatDateTime(user.last_login))}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="selectUser('${encoded}')">查看 / 编辑</button></td>
      </tr>
    `;
  }).join('');
}

async function loadUsers(preserveSelection = true) {
  const keyword = document.getElementById('userSearchInput').value.trim();
  const users = await adminFetch(`/api/admin/users?keyword=${encodeURIComponent(keyword)}&limit=200`);
  adminState.users = users;
  renderUsersTable(users);

  if (preserveSelection && adminState.selectedUser?.username) {
    const stillExists = users.some(user => user.username === adminState.selectedUser.username);
    if (stillExists) {
      await selectUser(encodeURIComponent(adminState.selectedUser.username), false);
      return;
    }
  }

  if (!preserveSelection) {
    clearUserEditor();
  }
}

function clearUserEditor() {
  adminState.selectedUser = null;
  document.getElementById('userEditorEmpty').classList.remove('hidden');
  document.getElementById('userEditorForm').classList.add('hidden');
  document.getElementById('editUserPassword').value = '';
  document.getElementById('rechargeAmount').value = '';
}

function fillUserEditor(user) {
  document.getElementById('userEditorEmpty').classList.add('hidden');
  document.getElementById('userEditorForm').classList.remove('hidden');
  document.getElementById('editUserId').value = user.id || '';
  document.getElementById('editUsername').value = user.username || '';
  document.getElementById('editNickname').value = user.nickname || user.username || '';
  document.getElementById('editWins').value = Number(user.wins || 0);
  document.getElementById('editLosses').value = Number(user.losses || 0);
  document.getElementById('editGamesPlayed').value = Number(user.games_played || 0);
  document.getElementById('editScore').value = Number(user.score || 0);
  document.getElementById('editCreatedAt').value = formatDateTime(user.created_at);
  document.getElementById('editLastLogin').value = formatDateTime(user.last_login);
  document.getElementById('editUserPassword').value = '';
}

async function selectUser(encodedUsername, showMessage = false) {
  const username = decodeURIComponent(encodedUsername);
  const user = await adminFetch(`/api/admin/users/${encodeURIComponent(username)}`);
  adminState.selectedUser = user;
  fillUserEditor(user);
  if (showMessage) {
    showToast(`已加载用户 ${username}`);
  }
}

async function saveUserChanges() {
  const username = document.getElementById('editUsername').value;
  if (!username) return;

  const payload = {
    nickname: document.getElementById('editNickname').value.trim(),
    wins: Number(document.getElementById('editWins').value),
    losses: Number(document.getElementById('editLosses').value),
    games_played: Number(document.getElementById('editGamesPlayed').value),
    score: Number(document.getElementById('editScore').value)
  };
  const password = document.getElementById('editUserPassword').value.trim();
  if (password) {
    payload.password = password;
  }

  const updated = await adminFetch(`/api/admin/users/${encodeURIComponent(username)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
  adminState.selectedUser = updated;
  fillUserEditor(updated);
  await Promise.all([loadOverview(), loadUsers(true)]);
  showToast(`已保存用户 ${username}`);
}

async function rechargeUser() {
  const username = document.getElementById('editUsername').value;
  const amount = Number(document.getElementById('rechargeAmount').value);
  if (!username) return;
  if (!Number.isInteger(amount) || amount <= 0) {
    showToast('请输入大于 0 的整数充值积分');
    return;
  }

  const updated = await adminFetch(`/api/admin/users/${encodeURIComponent(username)}/recharge`, {
    method: 'POST',
    body: JSON.stringify({ amount })
  });
  adminState.selectedUser = updated;
  fillUserEditor(updated);
  document.getElementById('rechargeAmount').value = '';
  await Promise.all([loadOverview(), loadUsers(true)]);
  showToast(`已为 ${username} 充值 ${amount} 分`);
}

async function resetUserStats() {
  const username = document.getElementById('editUsername').value;
  if (!username) return;
  if (!confirm(`确定要重置用户 ${username} 的积分和战绩吗？`)) return;

  const updated = await adminFetch(`/api/admin/users/${encodeURIComponent(username)}/reset`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  adminState.selectedUser = updated;
  fillUserEditor(updated);
  await Promise.all([loadOverview(), loadUsers(true)]);
  showToast(`已重置用户 ${username}`);
}

async function deleteUserAccount() {
  const username = document.getElementById('editUsername').value;
  if (!username) return;
  if (!confirm(`确定删除用户 ${username} 吗？此操作不可恢复。`)) return;

  await adminFetch(`/api/admin/users/${encodeURIComponent(username)}`, {
    method: 'DELETE'
  });
  clearUserEditor();
  await Promise.all([loadOverview(), loadUsers(false)]);
  showToast(`已删除用户 ${username}`);
}

function renderGamesTable(games) {
  const tbody = document.getElementById('gameTableBody');
  if (!games || games.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">没有找到对局记录</td></tr>';
    return;
  }

  tbody.innerHTML = games.map(game => `
    <tr>
      <td>${escapeHtml(game.id)}</td>
      <td>${escapeHtml(game.room_name || '-')}</td>
      <td>${escapeHtml(game.winner || '-')}</td>
      <td>${game.winner_team === 'landlord' ? '地主' : game.winner_team === 'farmer' ? '农民' : '-'}</td>
      <td>${escapeHtml(formatDateTime(game.created_at))}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="selectGame('${escapeHtml(game.id)}')">查看 / 编辑</button></td>
    </tr>
  `).join('');
}

async function loadGames(preserveSelection = true) {
  const keyword = document.getElementById('gameSearchInput').value.trim();
  const games = await adminFetch(`/api/admin/games?keyword=${encodeURIComponent(keyword)}&limit=200`);
  adminState.games = games;
  renderGamesTable(games);

  if (preserveSelection && adminState.selectedGame?.id) {
    const stillExists = games.some(game => game.id === adminState.selectedGame.id);
    if (stillExists) {
      await selectGame(adminState.selectedGame.id, false);
      return;
    }
  }

  if (!preserveSelection) {
    clearGameEditor();
  }
}

function clearGameEditor() {
  adminState.selectedGame = null;
  document.getElementById('gameEditorEmpty').classList.remove('hidden');
  document.getElementById('gameEditorForm').classList.add('hidden');
}

function fillGameEditor(game) {
  document.getElementById('gameEditorEmpty').classList.add('hidden');
  document.getElementById('gameEditorForm').classList.remove('hidden');
  document.getElementById('editGameId').value = game.id || '';
  document.getElementById('editGameRoomName').value = game.room_name || '';
  document.getElementById('editGameLandlord').value = game.landlord || '';
  document.getElementById('editGameHiddenLandlord').value = game.hidden_landlord || '';
  document.getElementById('editGameWinner').value = game.winner || '';
  document.getElementById('editGameWinnerTeam').value = game.winner_team || '';
  document.getElementById('editGameMarkedCard').value = game.marked_card || '';
  document.getElementById('editGameCreatedAt').value = formatDateTime(game.created_at);
  document.getElementById('editGamePlayers').value = JSON.stringify(game.players || [], null, 2);
  document.getElementById('editGameScores').value = JSON.stringify(game.scores || {}, null, 2);
  document.getElementById('editGameTurnHistory').value = JSON.stringify(game.turn_history || [], null, 2);
  document.getElementById('editGameInitialHands').value = game.initial_hands === null ? 'null' : JSON.stringify(game.initial_hands || {}, null, 2);
}

async function selectGame(gameId, showMessage = false) {
  const game = await adminFetch(`/api/admin/games/${encodeURIComponent(gameId)}`);
  adminState.selectedGame = game;
  fillGameEditor(game);
  if (showMessage) {
    showToast(`已加载对局 ${gameId}`);
  }
}

function parseJsonInput(elementId, label, allowNull = false) {
  const raw = document.getElementById(elementId).value.trim();
  if (!raw) {
    if (allowNull) return null;
    throw new Error(`${label} 不能为空`);
  }
  const value = JSON.parse(raw);
  if (value === null && !allowNull) {
    throw new Error(`${label} 不能为 null`);
  }
  return value;
}

async function saveGameChanges() {
  const gameId = document.getElementById('editGameId').value;
  if (!gameId) return;

  const payload = {
    room_name: document.getElementById('editGameRoomName').value.trim(),
    landlord: document.getElementById('editGameLandlord').value.trim(),
    hidden_landlord: document.getElementById('editGameHiddenLandlord').value.trim(),
    winner: document.getElementById('editGameWinner').value.trim(),
    winner_team: document.getElementById('editGameWinnerTeam').value,
    marked_card: document.getElementById('editGameMarkedCard').value.trim(),
    players: parseJsonInput('editGamePlayers', '玩家列表 JSON'),
    scores: parseJsonInput('editGameScores', '积分 JSON'),
    turn_history: parseJsonInput('editGameTurnHistory', '回合历史 JSON'),
    initial_hands: parseJsonInput('editGameInitialHands', '起始手牌 JSON', true)
  };

  const updated = await adminFetch(`/api/admin/games/${encodeURIComponent(gameId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
  adminState.selectedGame = updated;
  fillGameEditor(updated);
  await Promise.all([loadOverview(), loadGames(true)]);
  showToast(`已保存对局 ${gameId}`);
}

async function deleteGameRecord() {
  const gameId = document.getElementById('editGameId').value;
  if (!gameId) return;
  if (!confirm(`确定删除对局 ${gameId} 吗？此操作不可恢复。`)) return;

  await adminFetch(`/api/admin/games/${encodeURIComponent(gameId)}`, {
    method: 'DELETE'
  });
  clearGameEditor();
  await Promise.all([loadOverview(), loadGames(false)]);
  showToast(`已删除对局 ${gameId}`);
}

async function saveAiSettings(event) {
  event?.preventDefault();
  const payload = {
    difficulty: document.getElementById('aiDifficultySelect').value,
    llmEnabled: document.getElementById('aiLlmEnabled')?.checked || false,
    llmApiUrl: document.getElementById('aiLlmApiUrl')?.value.trim() || 'http://sub.stzo.cn:11666/v1',
    llmModel: document.getElementById('aiLlmModel')?.value.trim() || 'K2.6-Inst'
  };
  const settings = await adminFetch('/api/admin/ai-settings', {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
  renderAiSettings(settings);
  showToast(`AI 出牌设置已保存：${settings.label || '标准'}${settings.llmEnabled ? '，LLM 已开启' : '，LLM 未开启'}`);
}

async function resetAllUsers() {
  const confirmText = prompt('这是危险操作，请输入 RESET_ALL_USERS 确认重置全部用户统计');
  if (!confirmText) return;
  await adminFetch('/api/admin/system/reset-all-users', {
    method: 'POST',
    body: JSON.stringify({ confirm: confirmText })
  });
  clearUserEditor();
  await refreshAdminDashboard();
  showToast('全部用户统计已重置');
}

async function clearHistory() {
  const confirmText = prompt('这是危险操作，请输入 CLEAR_HISTORY 确认清空全部对局历史');
  if (!confirmText) return;
  await adminFetch('/api/admin/system/clear-history', {
    method: 'POST',
    body: JSON.stringify({ confirm: confirmText })
  });
  clearGameEditor();
  await refreshAdminDashboard();
  showToast('全部对局历史已清空');
}

async function refreshAdminDashboard() {
  try {
    await Promise.all([loadOverview(), loadUsers(true), loadGames(true)]);
  } catch (error) {
    showToast(error.message || '刷新失败');
    throw error;
  }
}

document.addEventListener('keydown', (event) => {
  const loginVisible = !document.getElementById('adminLoginScreen').classList.contains('hidden');
  if (loginVisible && event.key === 'Enter') {
    adminLogin();
  }

  if (event.key === 'Escape' && !document.getElementById('adminSpectateModal').classList.contains('hidden')) {
    closeAdminSpectate();
  }
});

(async function initAdmin() {
  applySavedTheme();
  selectAdminTab('users');

  if (!adminState.token) {
    showAdminScreen('login');
    return;
  }

  document.getElementById('adminCurrentUser').textContent = adminState.username || '管理员';
  showAdminScreen('dashboard');
  try {
    await refreshAdminDashboard();
  } catch (error) {
    adminLogout(false);
    showToast(error.message || '管理员登录已失效，请重新登录');
  }
})();
