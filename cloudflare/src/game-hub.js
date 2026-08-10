import { AIPlayer } from '../../game/ai.js';
import { GameEngine } from '../../game/engine.js';
import { D1Store } from './d1-store.js';
import { verifyToken } from './auth.js';
import { jsonResponse, makeSocketMessage, normalizeRoomSettings, parseSocketMessage, randomId } from './shared.js';

const ROOMS_SNAPSHOT_KEY = 'roomsSnapshot';
const AI_TURN_DELAY_MS = 800;
const AI_TURN_DELAY_JITTER_MS = 800;
const AI_MARKED_SELECT_DELAY_MS = 500;
const AI_CLAIM_DELAY_MS = 700;
const BOTTOM_REVEAL_MS = 8000;
const MUTATING_SOCKET_EVENTS = new Set([
  'createRoom',
  'joinRoom',
  'updateRoomSettings',
  'leaveRoom',
  'ready',
  'kickPlayer',
  'startGame',
  'playCards',
  'pass',
  'selectMarkedCards',
  'chooseDouble',
  'claimLandlord',
  'declineLandlord',
  'redealGame',
  'revealHand',
  'settleGame',
  'requestSpectate',
  'approveSpectate',
  'denySpectate',
  'leaveSpectate',
  'respondAiTakeover'
]);

export class GameHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.corePromise = GameHubCore.create({
      storage: state.storage,
      store: new D1Store(env.DB),
      getAiSettings: async () => (await new D1Store(env.DB).getAiSettings()),
      createAI: settings => new AIPlayer({ ...settings, llmApiKey: env.LLM_API_KEY || '' })
    });
  }

  async fetch(request) {
    const core = await this.getCore();
    const url = new URL(request.url);
    if (url.pathname === '/ws') return this.acceptWebSocket(request);
    if (url.pathname === '/rooms') {
      return jsonResponse({ rooms: core.getRoomList(), onlineUsers: core.onlineUsers.size });
    }
    if (url.pathname.startsWith('/admin/rooms/')) {
      return this.handleAdmin(url, request);
    }
    if (url.pathname === '/profile-changed' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return jsonResponse(core.handleProfileChanged(body?.username));
    }
    return jsonResponse({ error: 'GameHub route not implemented' }, 404);
  }

  async getCore() {
    if (!this.core) this.core = await this.corePromise;
    return this.core;
  }

  async acceptWebSocket(request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return jsonResponse({ error: 'Expected websocket upgrade' }, 426);
    }

    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    let decoded;
    try {
      decoded = await verifyToken(token, this.env.JWT_SECRET);
    } catch {
      return jsonResponse({ error: '认证失败' }, 401);
    }
    if (!decoded?.username || decoded.role === 'admin') return jsonResponse({ error: '没有玩家权限' }, 403);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const core = await this.getCore();
    core.attachSocket(decoded.username, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleAdmin(url, request) {
    const core = await this.getCore();
    const stopMatch = url.pathname.match(/^\/admin\/rooms\/([^/]+)\/stop$/);
    if (stopMatch && request.method === 'POST') return jsonResponse(await core.runMutatingAction(() => core.stopRoom(stopMatch[1])));

    const deleteMatch = url.pathname.match(/^\/admin\/rooms\/([^/]+)$/);
    if (deleteMatch && request.method === 'DELETE') return jsonResponse(await core.runMutatingAction(() => core.deleteRoom(deleteMatch[1])));

    const removeMatch = url.pathname.match(/^\/admin\/rooms\/([^/]+)\/remove-member$/);
    if (removeMatch && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return jsonResponse(await core.runMutatingAction(() => core.removeMember(removeMatch[1], body.username)));
    }

    const spectateMatch = url.pathname.match(/^\/admin\/rooms\/([^/]+)\/spectate$/);
    if (spectateMatch && request.method === 'GET') return jsonResponse(core.getAdminRoomSnapshot(spectateMatch[1]));

    return jsonResponse({ error: '管理接口不存在' }, 404);
  }
}

export class GameHubCore {
  constructor(options = {}) {
    this.rooms = new Map();
    this.onlineUsers = new Map();
    this.socketUsers = new WeakMap();
    this.profileCache = new Map(); // username -> { displayName, avatarData }
    this.profileTasks = new Set();
    this.store = options.store || null;
    this.storage = options.storage || null;
    this.getAiSettings = options.getAiSettings || (async () => ({ difficulty: await (options.getAiDifficulty?.() || 'normal') }));
    this.schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
    this.createAI = options.createAI || (settings => new AIPlayer(settings));
  }

  static async create(options = {}) {
    const core = new GameHubCore(options);
    const snapshot = options.storage ? await options.storage.get(ROOMS_SNAPSHOT_KEY) : null;
    if (snapshot) core.importSnapshot(snapshot);
    core.resumeRestoredRooms();
    return core;
  }

  async persistRooms() {
    if (!this.storage) return;
    await this.storage.put(ROOMS_SNAPSHOT_KEY, this.exportSnapshot());
  }

  persistRoomsSoon() {
    if (!this.storage) return;
    this.persistRooms().catch(error => console.error('Failed to persist room snapshot', error));
  }

  async runMutatingAction(action) {
    const result = await action();
    await this.persistRooms();
    return result;
  }

  exportSnapshot() {
    return {
      version: 1,
      rooms: Array.from(this.rooms.values()).map(room => this.serializeRoom(room))
    };
  }

  importSnapshot(snapshot = {}) {
    this.rooms = new Map();
    for (const roomSnapshot of snapshot.rooms || []) {
      const room = this.deserializeRoom(roomSnapshot);
      if (room?.id) this.rooms.set(room.id, room);
    }
  }

  resumeRestoredRooms() {
    for (const [roomId, room] of this.rooms) {
      room.startPromptShown = false;
      this.refreshRoomProfilesSoon(room, roomId);
      if (room.status === 'playing' && room.game && !room.game.gameOver) {
        this.resumeRoomFlow(room, roomId);
      }
    }
  }

  serializeRoom(room) {
    return {
      ...room,
      game: room.game ? this.serializeGame(room.game) : null
    };
  }

  deserializeRoom(snapshot) {
    return {
      ...snapshot,
      players: snapshot.players || [null, null, null, null, null],
      settings: normalizeRoomSettings(snapshot.settings || {}),
      spectators: snapshot.spectators || [],
      spectateRequests: snapshot.spectateRequests || [],
      pendingAiTakeovers: snapshot.pendingAiTakeovers || {},
      startPromptShown: false,
      game: snapshot.game ? this.deserializeGame(snapshot.game) : null
    };
  }

  serializeGame(game) {
    return {
      playerNames: game.playerNames,
      hands: game.hands,
      landlord: game.landlord,
      hiddenLandlord: game.hiddenLandlord,
      landlordRevealed: game.landlordRevealed,
      currentPlayer: game.currentPlayer,
      lastPlay: game.lastPlay,
      lastPlayPlayer: game.lastPlayPlayer,
      passCount: game.passCount,
      turnHistory: game.turnHistory,
      gameOver: game.gameOver,
      winner: game.winner,
      markedCard: game.markedCard,
      bottomCards: game.bottomCards,
      landlordCards: game.landlordCards,
      phase: game.phase,
      selectedMarkedCards: game.selectedMarkedCards,
      initialHandsSnapshot: game.initialHandsSnapshot,
      baseScore: game.baseScore,
      doubleEnabled: game.doubleEnabled,
      doubleDecisions: game.doubleDecisions,
      scoreMultiplier: game.scoreMultiplier,
      revealedPlayers: Array.from(game.revealedPlayers || []),
      scoringRevealedPlayers: Array.from(game.scoringRevealedPlayers || [])
    };
  }

  deserializeGame(snapshot) {
    const game = new GameEngine(snapshot.playerNames || [], {
      baseScore: snapshot.baseScore,
      doubleEnabled: snapshot.doubleEnabled
    });
    Object.assign(game, snapshot);
    game.revealedPlayers = new Set(snapshot.revealedPlayers || []);
    game.scoringRevealedPlayers = new Set(snapshot.scoringRevealedPlayers || []);
    return game;
  }

  attachSocket(username, socket) {
    this.onlineUsers.set(username, socket);
    this.socketUsers.set(socket, username);
    socket.addEventListener('message', event => this.handleSocketMessage(username, socket, event.data));
    socket.addEventListener('close', () => this.handleDisconnect(username, socket));
    socket.addEventListener('error', () => this.handleDisconnect(username, socket));
    this.emit(socket, 'connect');
    this.emit(socket, 'roomList', this.getRoomList());
    this.autoRejoin(username, socket);
  }

  async handleSocketMessage(username, socket, raw) {
    const message = parseSocketMessage(raw);
    if (!message) return;
    const reply = payload => {
      if (message.ackId) this.emit(socket, 'ack', { ackId: message.ackId, payload });
    };

    try {
      const result = await this.dispatchEvent(username, socket, message.event, message.data || {});
      if (message.ackId) reply(result ?? { success: true });
    } catch (error) {
      const payload = { success: false, error: error.message || '操作失败' };
      if (message.ackId) reply(payload);
      else this.emit(socket, 'playError', { error: payload.error });
    }
  }

  async dispatchEvent(username, socket, event, data) {
    const handlers = {
      createRoom: () => this.createRoom(username, socket, data),
      joinRoom: () => this.joinRoom(username, socket, data.roomId),
      updateRoomSettings: () => this.updateRoomSettings(username, data.roomId, data.settings),
      leaveRoom: () => this.leaveRoom(username, data.roomId),
      ready: () => this.toggleReady(username, data.roomId),
      kickPlayer: () => this.kickPlayer(username, data.roomId, data.target),
      startGame: () => this.startGame(username, data.roomId),
      playCards: () => this.playCards(username, data.roomId, data.cards),
      pass: () => this.pass(username, data.roomId),
      getHint: async () => this.getHint(username, data.roomId),
      selectMarkedCards: () => this.selectMarkedCards(username, data.roomId, data.cards),
      chooseDouble: () => this.chooseDouble(username, data.roomId, data.doubled),
      claimLandlord: () => this.claimLandlord(username, data.roomId),
      declineLandlord: () => this.declineLandlord(username, data.roomId),
      redealGame: () => this.redealGame(username, data.roomId),
      revealHand: () => this.revealHand(username, data.roomId),
      chat: () => this.chat(username, data.roomId, data.message),
      settleGame: () => this.settleGame(username, data.roomId),
      requestSpectate: () => this.requestSpectate(username, data.roomId),
      approveSpectate: () => this.approveSpectate(username, data.roomId, data.requester),
      denySpectate: () => this.denySpectate(username, data.roomId, data.requester),
      leaveSpectate: () => this.leaveSpectate(username, data.roomId),
      getCardCounter: () => this.getCardCounter(username, data.roomId),
      respondAiTakeover: () => this.respondAiTakeover(username, data)
    };
    if (!handlers[event]) return { success: false, error: '未知事件' };
    return MUTATING_SOCKET_EVENTS.has(event)
      ? this.runMutatingAction(handlers[event])
      : handlers[event]();
  }

  createRoom(username, socket, data = {}) {
    this.releaseUserPresence(username);
    const roomId = randomId(8);
    const settings = normalizeRoomSettings(data.settings || {});
    const room = {
      id: roomId,
      name: typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 30) : `${username}的房间`,
      owner: username,
      players: [{ username, ready: false, isAI: false, seatIndex: 0 }, null, null, null, null],
      status: 'waiting',
      game: null,
      settings,
      spectators: [],
      spectateRequests: [],
      pendingAiTakeovers: {},
      startPromptShown: false,
      finalResult: null
    };
    this.rooms.set(roomId, room);
    this.broadcastRoomState(roomId);
    this.broadcastRoomList();
    this.refreshRoomProfilesSoon(room, roomId);
    return { success: true, roomId };
  }

  joinRoom(username, socket, roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: '房间不存在' };
    this.releaseUserPresence(username, roomId);

    const existing = room.players.find(player => player?.username === username);
    if (existing) {
      this.broadcastRoomState(roomId);
      this.emitGameStateFor(username, room, roomId);
      this.refreshRoomProfilesSoon(room, roomId);
      return { success: true, roomId, status: room.status };
    }

    const reclaimable = room.players.find(player => player?.isAI && player.rejoinable && player.originalUsername === username);
    if (reclaimable && this.reclaimAiSeat(room, roomId, reclaimable, username)) {
      return { success: true, roomId, status: room.status, rejoined: true, message: '已回到对局' };
    }

    if (room.status !== 'waiting') return { success: false, error: '房间已开局' };
    const emptySlot = room.players.findIndex(player => player === null);
    if (emptySlot === -1) return { success: false, error: '房间已满' };
    room.players[emptySlot] = { username, ready: false, isAI: false, seatIndex: emptySlot };
    room.startPromptShown = false;
    this.broadcastRoomState(roomId);
    this.broadcastRoomList();
    this.refreshRoomProfilesSoon(room, roomId);
    return { success: true, roomId };
  }

  updateRoomSettings(username, roomId, settings) {
    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: '房间不存在' };
    if (room.owner !== username || room.status !== 'waiting') return { success: false, error: '只有房主可在开局前修改设置' };
    room.settings = normalizeRoomSettings(settings || {});
    room.startPromptShown = false;
    this.broadcastRoomState(roomId);
    this.broadcastRoomList();
    return { success: true, settings: this.describeRoomSettings(room) };
  }

  leaveRoom(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return { success: true };
    if (room.spectators.some(s => s.username === username)) return this.leaveSpectate(username, roomId);
    const player = room.players.find(seat => seat?.username === username);
    if (!player) return { success: true };

    if (room.status === 'playing' && room.game) {
      const success = this.replacePlayerWithAi(room, username, roomId, {
        rejoinable: true,
        message: `${this.getProfileDisplayName(username)} 已退出对局，AI 将接管座位`
      });
      return { success, mode: 'playing' };
    }

    this.removeWaitingPlayer(room, username, roomId);
    return { success: true, mode: room.status };
  }

  toggleReady(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'waiting') return { success: false, error: '房间不存在或已开局' };
    const player = room.players.find(seat => seat?.username === username);
    if (!player) return { success: false, error: '你不在房间内' };
    player.ready = !player.ready;
    room.startPromptShown = false;
    this.broadcastRoomState(roomId);
    this.emitOwnerStartPromptIfNeeded(room, roomId);
    return { success: true, ready: player.ready };
  }

  kickPlayer(username, roomId, target) {
    const room = this.rooms.get(roomId);
    if (!room || room.owner !== username || room.status !== 'waiting' || target === username) return { success: false };
    const targetSocket = this.onlineUsers.get(target);
    if (targetSocket) this.emit(targetSocket, 'roomParticipationEnded', { roomId, mode: 'player', message: '你已被房主移出房间' });
    return { success: this.removeWaitingPlayer(room, target, roomId) };
  }

  startGame(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room || room.owner !== username || room.status !== 'waiting') return { success: false, error: '只有房主可以开始游戏' };
    if (!this.canRoomStart(room)) return { success: false, error: '请等待所有真人玩家准备完成' };
    this.startRoomGame(room, roomId);
    return { success: true };
  }

  startRoomGame(room, roomId) {
    room.roundId = randomId(8);
    for (let i = 0; i < 5; i++) {
      if (!room.players[i]) {
        room.players[i] = { username: `AI_${i + 1}`, ready: true, isAI: true, seatIndex: i };
      } else {
        room.players[i].ready = true;
        room.players[i].isAI = false;
        delete room.players[i].originalUsername;
        delete room.players[i].rejoinable;
      }
    }
    room.status = 'playing';
    room.finalResult = null;
    room.settings = normalizeRoomSettings(room.settings);
    room.game = new GameEngine(room.players.map(player => player.username), {
      baseScore: room.settings.baseScore,
      doubleEnabled: room.settings.doubleEnabled,
      landlordClaim: true
    });
    room.game.deal();
    this.emitDealEvents(room, roomId);
    this.broadcastRoomState(roomId);
    this.broadcastGameState(roomId);
    this.broadcastRoomList();
    this.resumeRoomFlow(room, roomId);
  }

  /**
   * 开局时向玩家/观战者推送发牌顺序，客户端据此播放逐张发牌动画。
   * 动画期间到达的 gameState 由客户端暂存，动画结束后再渲染。
   */
  emitDealEvents(room, roomId) {
    const dealSequence = room.game.getDealSequence();
    if (!dealSequence) return;
    const base = {
      roomId,
      roundId: room.roundId,
      seatOrder: [...room.game.playerNames],
      landlord: room.game.landlord,
      markedCard: room.game.markedCard?.id || null,
      bottomCount: dealSequence.bottom.length
    };
    for (const player of room.players) {
      if (!player || player.isAI) continue;
      const socket = this.onlineUsers.get(player.username);
      if (!socket) continue;
      this.emit(socket, 'gameDeal', {
        ...base,
        myName: player.username,
        myHandOrder: dealSequence.hands[player.username] || []
      });
    }
    if (room.spectators.length) {
      const spectatorPayload = { ...base, isSpectator: true, allHandsOrder: dealSequence.hands };
      for (const spectator of room.spectators) {
        const socket = this.onlineUsers.get(spectator.username);
        if (socket) this.emit(socket, 'spectatorGameDeal', spectatorPayload);
      }
    }
  }

  /**
   * 要地主：决策人成为大地主，底牌公示 8 秒后进入选明牌阶段。
   */
  async claimLandlord(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room?.game) return { success: false, error: '对局不存在' };
    const result = room.game.claimLandlord(username);
    if (!result.success) {
      const socket = this.onlineUsers.get(username);
      if (socket) this.emit(socket, 'playError', { error: result.error });
      return result;
    }
    this.chat('系统', roomId, `${username} 选择要地主，7 张底牌公示 8 秒`);
    this.broadcastGameState(roomId);
    this.broadcastRoomState(roomId);
    this.schedule(() => this.finishBottomReveal(room, roomId), BOTTOM_REVEAL_MS);
    this.persistRoomsSoon();
    return result;
  }

  /**
   * 不要地主：地主身份传给下家；轮完一圈回到原点时必须接受。
   */
  async declineLandlord(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room?.game) return { success: false, error: '对局不存在' };
    const result = room.game.declineLandlord(username);
    if (!result.success) {
      const socket = this.onlineUsers.get(username);
      if (socket) this.emit(socket, 'playError', { error: result.error });
      return result;
    }
    this.chat('系统', roomId, result.mustTake
      ? `${username} 不要地主，地主身份回到 ${result.nextClaimant}，已轮完一圈必须选择要地主`
      : `${username} 不要地主，地主身份传给下家 ${result.nextClaimant}`);
    this.broadcastGameState(roomId);
    this.resumeRoomFlow(room, roomId);
    this.persistRoomsSoon();
    return result;
  }

  /**
   * 房主在要地主阶段重新洗牌发牌。
   */
  redealGame(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room?.game) return { success: false, error: '对局不存在' };
    if (room.owner !== username) return { success: false, error: '只有房主可以重新洗牌发牌' };
    if (room.game.phase !== 'claiming') return { success: false, error: '当前不能重新洗牌' };

    room.roundId = randomId(8);
    room.game = new GameEngine(room.players.map(player => player.username), {
      baseScore: room.settings.baseScore,
      doubleEnabled: room.settings.doubleEnabled,
      landlordClaim: true
    });
    room.game.deal();
    this.chat('系统', roomId, `${username} 重新洗牌发牌`);
    this.emitDealEvents(room, roomId);
    this.broadcastGameState(roomId);
    this.resumeRoomFlow(room, roomId);
    this.persistRoomsSoon();
    return { success: true, roundId: room.roundId };
  }

  /** 底牌公示 8 秒结束后进入选明牌阶段 */
  async finishBottomReveal(room, roomId) {
    if (!room.game || room.game.phase !== 'bottomReveal') return;
    room.game.finishBottomReveal();
    this.broadcastGameState(roomId);
    this.resumeRoomFlow(room, roomId);
    await this.persistRooms();
  }

  /** AI 决策是否要地主：必接或手牌强度足够则要，否则不要 */
  async autoResolveAiClaim(room, roomId) {
    if (!room.game || room.game.phase !== 'claiming') return;
    const claimant = room.game.claimState?.claimant;
    const seat = room.players.find(player => player?.username === claimant);
    if (!seat?.isAI) return;
    if (this.shouldAiClaim(room.game, claimant)) {
      await this.claimLandlord(claimant, roomId);
    } else {
      await this.declineLandlord(claimant, roomId);
    }
  }

  shouldAiClaim(game, playerName) {
    const claim = game.getClaimState();
    if (claim?.mustTake) return true;
    const hand = game.hands[playerName] || [];
    const byId = {};
    let score = 0;
    for (const card of hand) {
      if (card.rank === 'D') score += 3;
      else if (card.rank === 'X') score += 2;
      else if (card.rank === '2') score += 1.5;
      else if (card.rank === 'A') score += 0.5;
      byId[card.id] = (byId[card.id] || 0) + 1;
    }
    for (const count of Object.values(byId)) if (count >= 4) score += 4; // 炸弹
    return score >= 10;
  }

  async playCards(username, roomId, cards) {
    const room = this.rooms.get(roomId);
    if (!room?.game || !Array.isArray(cards)) return { success: false, error: '对局不存在' };
    const result = room.game.playCards(username, cards);
    if (!result.success) {
      const socket = this.onlineUsers.get(username);
      if (socket) this.emit(socket, 'playError', { error: result.error });
      return result;
    }
    this.broadcastGameState(roomId);
    if (result.gameOver) await this.handleGameOver(room, roomId, result);
    else this.resumeRoomFlow(room, roomId);
    return result;
  }

  pass(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room?.game) return { success: false, error: '对局不存在' };
    const result = room.game.pass(username);
    if (!result.success) {
      const socket = this.onlineUsers.get(username);
      if (socket) this.emit(socket, 'playError', { error: result.error });
      return result;
    }
    this.broadcastGameState(roomId);
    this.resumeRoomFlow(room, roomId);
    return result;
  }

  async getHint(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room?.game || room.game.getCurrentPlayer() !== username) return { hints: [] };
    const aiSettings = await this.getAiSettings();
    return { hints: room.game.getHints(username, { difficulty: aiSettings.difficulty }) };
  }

  selectMarkedCards(username, roomId, cards) {
    const room = this.rooms.get(roomId);
    if (!room?.game) return { success: false, error: '对局不存在' };
    if (room.game.landlord !== username) return { success: false, error: '只有地主可以选择明牌' };
    const result = room.game.selectMarkedCards(cards);
    if (result.success) {
      this.broadcastGameState(roomId);
      this.resumeRoomFlow(room, roomId);
    }
    return result;
  }

  chooseDouble(username, roomId, doubled) {
    const room = this.rooms.get(roomId);
    if (!room?.game) return { success: false, error: '当前不能选择加倍' };
    if (!room.settings.doubleEnabled) return { success: false, error: '房主未开启加倍' };
    const result = room.game.chooseDouble(username, Boolean(doubled));
    if (result.success) {
      this.broadcastGameState(roomId);
      this.broadcastRoomState(roomId);
      this.broadcastRoomList();
      this.resumeRoomFlow(room, roomId);
    }
    return result;
  }

  revealHand(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room?.game) return { success: false, error: '当前不能明牌' };
    if (!room.settings.allowOpenCards) return { success: false, error: '房主未开启主动明牌' };
    const result = room.game.revealHand(username);
    if (result.success) {
      this.chat('系统', roomId, result.multiplierApplied
        ? `${username} 选择明牌，明牌倍数为5倍，当前总倍数 ${result.scoreMultiplier} 倍`
        : `${username} 选择明牌，手牌已公开；因本局已有出牌记录，本次明牌不再加倍`);
      this.broadcastGameState(roomId);
      this.broadcastRoomState(roomId);
      this.broadcastRoomList();
    }
    return result;
  }

  chat(username, roomId, message) {
    const room = this.rooms.get(roomId);
    if (!room || typeof message !== 'string') return { success: false };
    this.broadcastToRoom(room, 'chatMessage', { username, displayName: this.getProfileDisplayName(username), message: message.slice(0, 200) });
    return { success: true };
  }

  settleGame(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'finished') return { success: false, error: '当前没有待结算的对局' };
    if (!room.players.some(player => player && !player.isAI && player.username === username)) return { success: false, error: '只有房间玩家可以结算对局' };
    this.settleFinishedRoom(room, roomId);
    return { success: true, closed: !this.rooms.has(roomId) };
  }

  requestSpectate(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: '房间不存在' };
    if (room.players.some(player => player?.username === username)) return { success: false, error: '你已经在当前房间中，无需申请观战' };
    const reclaimable = room.players.find(player => player?.isAI && player.rejoinable && player.originalUsername === username);
    if (reclaimable && this.reclaimAiSeat(room, roomId, reclaimable, username)) return { success: true, rejoined: true, message: '已回到对局' };
    if (room.spectators.some(s => s.username === username)) return { success: false, error: '你已经在观战中' };
    if (!room.spectateRequests.some(r => r.username === username)) room.spectateRequests.push({ username });
    const ownerSocket = this.onlineUsers.get(room.owner);
    if (ownerSocket) this.emit(ownerSocket, 'spectateRequest', { roomId, requester: username, requesterDisplayName: this.getProfileDisplayName(username) });
    this.broadcastRoomState(roomId);
    this.broadcastRoomList();
    return { success: true, message: '观战申请已提交，等待房主确认' };
  }

  approveSpectate(username, roomId, requester) {
    const room = this.rooms.get(roomId);
    if (!room || room.owner !== username) return { success: false };
    room.spectateRequests = room.spectateRequests.filter(r => r.username !== requester);
    if (!room.spectators.some(s => s.username === requester)) room.spectators.push({ username: requester });
    const requesterSocket = this.onlineUsers.get(requester);
    if (requesterSocket) {
      this.emit(requesterSocket, 'spectateApproved', { roomId, roomName: room.name });
      if (room.game) this.emit(requesterSocket, 'spectatorGameState', this.buildSpectatorGameState(room, roomId));
    }
    this.broadcastRoomState(roomId);
    this.broadcastRoomList();
    this.refreshRoomProfilesSoon(room, roomId);
    return { success: true };
  }

  denySpectate(username, roomId, requester) {
    const room = this.rooms.get(roomId);
    if (!room || room.owner !== username) return { success: false };
    room.spectateRequests = room.spectateRequests.filter(r => r.username !== requester);
    const requesterSocket = this.onlineUsers.get(requester);
    if (requesterSocket) this.emit(requesterSocket, 'spectateDenied', { roomId });
    this.broadcastRoomState(roomId);
    this.broadcastRoomList();
    return { success: true };
  }

  leaveSpectate(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return { success: true };
    room.spectators = room.spectators.filter(s => s.username !== username);
    room.spectateRequests = room.spectateRequests.filter(r => r.username !== username);
    this.broadcastRoomState(roomId);
    this.broadcastRoomList();
    return { success: true };
  }

  getCardCounter(username, roomId) {
    const room = this.rooms.get(roomId);
    if (!room?.game || !room.spectators.some(s => s.username === username)) return { counter: null };
    return { counter: room.game.getCardCounter() };
  }

  respondAiTakeover(username, data) {
    const room = this.rooms.get(data.roomId);
    if (!room) return { success: false, error: '请求已失效' };
    const entry = Object.entries(room.pendingAiTakeovers || {}).find(([, pending]) => pending.requestId === data.requestId);
    if (!entry) return { success: false, error: '请求已失效' };
    const [targetUsername, pending] = entry;
    if (pending.reviewer !== username) return { success: false, error: '只有收到弹窗的玩家可以处理该请求' };
    delete room.pendingAiTakeovers[targetUsername];
    if (!data.accept) return { success: true, accepted: false };
    if (this.onlineUsers.has(targetUsername)) return { success: true, accepted: false, message: '玩家已重新连接' };
    return {
      success: this.replacePlayerWithAi(room, targetUsername, data.roomId, {
        rejoinable: true,
        message: `${this.getProfileDisplayName(targetUsername)} 断线后经 ${this.getProfileDisplayName(username)} 确认，AI 已接管座位`
      }),
      accepted: true
    };
  }

  handleDisconnect(username, socket) {
    // 同一账号可能有多个连接（多标签页/重连），只有当前映射的连接断开才算离线
    if (this.onlineUsers.get(username) !== socket) return;
    this.onlineUsers.delete(username);
    let mutated = false;
    const spectator = this.findSpectatorRoom(username);
    if (spectator) {
      this.leaveSpectate(username, spectator.roomId);
      mutated = true;
    }
    const presence = this.findPlayerRoom(username);
    if (!presence) {
      if (mutated) this.persistRoomsSoon();
      return;
    }
    const { room, roomId } = presence;
    if (room.status === 'waiting' || !room.game) mutated = this.removeWaitingPlayer(room, username, roomId) || mutated;
    else if (room.status === 'playing') mutated = this.requestAiTakeoverConfirmation(room, roomId, username) || mutated;
    if (mutated) this.persistRoomsSoon();
  }

  autoRejoin(username, socket) {
    const presence = this.findPlayerRoom(username);
    if (presence) {
      this.emitGameStateFor(username, presence.room, presence.roomId);
      this.broadcastRoomState(presence.roomId);
      this.refreshRoomProfilesSoon(presence.room, presence.roomId);
      if (this.requestOfflineTakeovers(presence.room, presence.roomId)) this.persistRoomsSoon();
      return;
    }
    const rejoinable = this.findRejoinableRoom(username);
    if (rejoinable && this.reclaimAiSeat(rejoinable.room, rejoinable.roomId, rejoinable.seat, username)) {
      this.persistRoomsSoon();
    }
  }

  findPlayerRoom(username) {
    for (const [roomId, room] of this.rooms) {
      if (room.players.some(player => player?.username === username)) return { roomId, room };
    }
    return null;
  }

  findRejoinableRoom(username) {
    for (const [roomId, room] of this.rooms) {
      const seat = room.players.find(player => player?.isAI && player.rejoinable && player.originalUsername === username);
      if (seat) return { roomId, room, seat };
    }
    return null;
  }

  findSpectatorRoom(username) {
    for (const [roomId, room] of this.rooms) {
      if (room.spectators.some(s => s.username === username)) return { roomId, room };
    }
    return null;
  }

  releaseUserPresence(username, targetRoomId = null) {
    const spectator = this.findSpectatorRoom(username);
    if (spectator && spectator.roomId !== targetRoomId) this.leaveSpectate(username, spectator.roomId);
    const player = this.findPlayerRoom(username);
    if (!player || player.roomId === targetRoomId) return;
    if (player.room.status === 'playing' && player.room.game) this.replacePlayerWithAi(player.room, username, player.roomId, { rejoinable: false });
    else this.removeWaitingPlayer(player.room, username, player.roomId);
  }

  replacePlayerWithAi(room, username, roomId, options = {}) {
    const seatIndex = room.players.findIndex(player => player?.username === username);
    if (seatIndex === -1 || !room.game) return false;
    const aiName = this.buildTakeoverAiName(room, username, seatIndex);
    if (!room.game.replacePlayerName(username, aiName)) return false;
    room.players[seatIndex] = {
      ...room.players[seatIndex],
      username: aiName,
      ready: true,
      isAI: true,
      originalUsername: username,
      rejoinable: Boolean(options.rejoinable),
      seatIndex
    };
    if (room.owner === username) room.owner = this.getHumanPlayers(room)[0]?.username || aiName;
    if (options.message) this.broadcastToRoom(room, 'chatMessage', { username: '系统', message: options.message });
    this.broadcastRoomState(roomId);
    this.broadcastGameState(roomId);
    this.broadcastRoomList();
    this.refreshRoomProfilesSoon(room, roomId);
    this.resumeRoomFlow(room, roomId);
    return true;
  }

  reclaimAiSeat(room, roomId, seat, username) {
    if (!room.game || !seat?.isAI || seat.originalUsername !== username) return false;
    const aiName = seat.username;
    if (!room.game.replacePlayerName(aiName, username)) return false;
    seat.username = username;
    seat.ready = true;
    seat.isAI = false;
    delete seat.originalUsername;
    delete seat.rejoinable;
    if (!this.getHumanPlayers(room).some(player => player.username === room.owner)) room.owner = username;
    this.broadcastToRoom(room, 'chatMessage', { username: '系统', message: `${this.getProfileDisplayName(username)} 已接回自己的座位` });
    this.broadcastRoomState(roomId);
    this.broadcastGameState(roomId);
    this.broadcastRoomList();
    this.refreshRoomProfilesSoon(room, roomId);
    this.resumeRoomFlow(room, roomId);
    return true;
  }

  requestAiTakeoverConfirmation(room, roomId, username) {
    if (!room?.game || room.status !== 'playing' || this.onlineUsers.has(username)) return false;
    const reviewer = room.players.find(player => player && !player.isAI && player.username !== username && this.onlineUsers.has(player.username));
    if (!reviewer) return false;
    if (!room.pendingAiTakeovers) room.pendingAiTakeovers = {};
    if (room.pendingAiTakeovers[username]) return true;
    const requestId = randomId(12);
    room.pendingAiTakeovers[username] = { roomId, requestId, username, reviewer: reviewer.username, createdAt: Date.now() };
    const displayName = this.getProfileDisplayName(username);
    this.emit(this.onlineUsers.get(reviewer.username), 'aiTakeoverRequest', {
      roomId,
      requestId,
      username,
      displayName,
      roomName: room.name,
      message: `${displayName} 已断线，是否确认由 AI 暂时接管该座位？取消则继续等待玩家重连。`
    });
    return true;
  }

  requestOfflineTakeovers(room, roomId) {
    if (!room?.game || room.status !== 'playing') return false;
    let mutated = false;
    for (const player of room.players) {
      if (!player || player.isAI || this.onlineUsers.has(player.username)) continue;
      mutated = this.requestAiTakeoverConfirmation(room, roomId, player.username) || mutated;
    }
    return mutated;
  }

  removeWaitingPlayer(room, username, roomId) {
    const seatIndex = room.players.findIndex(player => player?.username === username);
    if (seatIndex === -1) return false;
    room.players[seatIndex] = null;
    if (room.owner === username) room.owner = this.getHumanPlayers(room)[0]?.username || null;
    room.startPromptShown = false;
    if (this.getHumanPlayers(room).length === 0) this.rooms.delete(roomId);
    else this.broadcastRoomState(roomId);
    this.broadcastRoomList();
    return true;
  }

  stopRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: '房间不存在' };
    room.status = 'waiting';
    room.game = null;
    room.finalResult = null;
    room.spectators = [];
    room.spectateRequests = [];
    room.players = room.players.map((player, index) => player && !player.isAI
      ? { username: player.username, ready: false, isAI: false, seatIndex: index }
      : null);
    if (this.getHumanPlayers(room).length === 0) this.rooms.delete(roomId);
    else this.broadcastRoomState(roomId);
    this.broadcastRoomList();
    return { success: true, closed: !this.rooms.has(roomId), room: this.rooms.has(roomId) ? this.buildLiveRoomSummary(room) : null };
  }

  deleteRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: '房间不存在' };
    this.broadcastToRoom(room, 'roomClosed', { roomId, message: '房间已被管理员删除' });
    this.rooms.delete(roomId);
    this.broadcastRoomList();
    return { success: true };
  }

  removeMember(roomId, username) {
    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: '房间不存在' };
    if (room.spectators.some(s => s.username === username)) return this.leaveSpectate(username, roomId);
    if (room.status === 'playing' && room.game) return { success: this.replacePlayerWithAi(room, username, roomId, { rejoinable: false }), mode: 'player' };
    return { success: this.removeWaitingPlayer(room, username, roomId), mode: 'player' };
  }

  canRoomStart(room) {
    const humans = this.getHumanPlayers(room);
    return room.status === 'waiting' && humans.length > 0 && humans.every(player => player.ready);
  }

  getHumanPlayers(room) {
    return room.players.filter(player => player && !player.isAI);
  }

  describeRoomSettings(room) {
    return {
      ...room.settings,
      effectiveMultiplier: room.game?.scoreMultiplier || 1,
      label: `${room.settings.baseScore}分底 · ${room.game?.scoreMultiplier || 1}倍${room.settings.doubleEnabled ? ' · 可加倍' : ''}${room.settings.allowOpenCards ? ' · 可明牌' : ''}`
    };
  }

  buildRoomState(room) {
    return {
      id: room.id,
      name: room.name,
      owner: room.owner,
      ownerDisplayName: this.getProfileDisplayName(room.owner),
      players: room.players.map(player => player ? {
        ...player,
        displayName: player.isAI && player.originalUsername
          ? `AI托管 ${this.getProfileDisplayName(player.originalUsername)}`
          : this.getProfileDisplayName(player.username),
        originalDisplayName: player.originalUsername ? this.getProfileDisplayName(player.originalUsername) : null
      } : null),
      status: room.status,
      settings: this.describeRoomSettings(room),
      startable: this.canRoomStart(room),
      humanPlayerCount: this.getHumanPlayers(room).length,
      readyHumanCount: this.getHumanPlayers(room).filter(player => player.ready).length,
      emptySeatCount: room.players.filter(player => player === null).length,
      spectators: room.spectators.map(spectator => ({
        ...spectator,
        displayName: this.getProfileDisplayName(spectator.username)
      })),
      spectateRequests: room.spectateRequests.map(request => ({
        ...request,
        displayName: this.getProfileDisplayName(request.username)
      }))
    };
  }

  buildLiveRoomSummary(room) {
    const playerDetails = (room.players || []).filter(Boolean);
    const humanPlayerDetails = playerDetails.filter(player => !player.isAI);
    const aiPlayers = playerDetails.filter(player => player.isAI).map(player => player.username);
    const spectators = room.spectators || [];
    const spectateRequests = room.spectateRequests || [];

    return {
      id: room.id,
      name: room.name,
      owner: room.owner,
      ownerDisplayName: this.getProfileDisplayName(room.owner),
      playerCount: humanPlayerDetails.length,
      humanPlayers: humanPlayerDetails.map(player => player.username),
      humanPlayerDetails: humanPlayerDetails.map(player => ({
        ...player,
        displayName: this.getProfileDisplayName(player.username)
      })),
      aiPlayers,
      maxPlayers: 5,
      status: room.status,
      settings: this.describeRoomSettings(room),
      spectatorCount: spectators.length,
      spectators,
      pendingSpectateRequests: spectateRequests.length,
      spectateRequests,
      rejoinablePlayers: playerDetails.filter(player => player?.isAI && player.rejoinable).map(player => player.originalUsername),
      playerDetails: room.players
    };
  }

  getAdminRoomSnapshot(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: '房间不存在' };
    return {
      success: true,
      room: this.buildLiveRoomSummary(room),
      roomState: this.buildRoomState(room),
      gameState: room.game ? this.buildSpectatorGameState(room, roomId) : null
    };
  }

  getRoomList() {
    return Array.from(this.rooms.values()).map(room => this.buildLiveRoomSummary(room));
  }

  broadcastRoomState(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.broadcastToRoom(room, 'roomState', this.buildRoomState(room));
    this.emitOwnerStartPromptIfNeeded(room, roomId);
  }

  broadcastRoomList() {
    const rooms = this.getRoomList();
    for (const socket of this.onlineUsers.values()) this.emit(socket, 'roomList', rooms);
  }

  broadcastGameState(roomId) {
    const room = this.rooms.get(roomId);
    if (!room?.game) return;
    for (const player of room.players) {
      if (!player || player.isAI) continue;
      this.emitGameStateFor(player.username, room, roomId);
    }
    const spectatorState = this.buildSpectatorGameState(room, roomId);
    for (const spectator of room.spectators) {
      const socket = this.onlineUsers.get(spectator.username);
      if (socket) this.emit(socket, 'spectatorGameState', spectatorState);
    }
  }

  emitGameStateFor(username, room, roomId) {
    const socket = this.onlineUsers.get(username);
    if (!socket || !room.game) return;
    const state = this.augmentGameState(room, room.game.getStateForPlayer(username));
    state.roomId = roomId;
    state.roundId = room.roundId;
    this.emit(socket, 'gameState', state);
  }

  buildSpectatorGameState(room, roomId) {
    const state = this.augmentGameState(room, room.game.getStateForSpectator());
    state.roomId = roomId;
    state.roundId = room.roundId;
    state.cardCounter = room.game.getCardCounter();
    return state;
  }

  augmentGameState(room, state) {
    state.settings = this.describeRoomSettings(room);
    state.players = (state.players || []).map(player => {
      const seat = room.players.find(roomPlayer => roomPlayer?.username === player.name);
      const isAI = Boolean(seat?.isAI);
      return {
        ...player,
        isAI,
        displayName: isAI && seat.originalUsername
          ? `AI托管 ${this.getProfileDisplayName(seat.originalUsername)}`
          : this.getProfileDisplayName(player.name),
        originalUsername: seat?.originalUsername || null,
        originalDisplayName: seat?.originalUsername ? this.getProfileDisplayName(seat.originalUsername) : null,
        avatarData: null
      };
    });
    state.playerDisplayNames = Object.fromEntries(state.players.map(player => [player.name, player.displayName]));
    return state;
  }

  getProfileDisplayName(username) {
    if (!username) return username;
    return this.profileCache.get(username)?.displayName || username;
  }

  getRoomUsernames(room) {
    const names = new Set();
    for (const player of room.players || []) {
      if (!player) continue;
      if (player.isAI) {
        if (player.originalUsername) names.add(player.originalUsername);
      } else {
        names.add(player.username);
      }
    }
    for (const spectator of room.spectators || []) names.add(spectator.username);
    for (const request of room.spectateRequests || []) names.add(request.username);
    return [...names].filter(Boolean);
  }

  // 头像数据较大（单个可达 220KB），不随每次状态广播发送，
  // 只在成员/资料变化时一次性推送 roomProfiles，由客户端缓存。
  async refreshRoomProfiles(room, roomId) {
    if (!this.store) return;
    const usernames = this.getRoomUsernames(room);
    try {
      const profiles = await this.store.getUserProfiles(usernames);
      for (const [name, profile] of Object.entries(profiles || {})) {
        this.profileCache.set(name, {
          displayName: profile.displayName || profile.nickname || name,
          avatarData: profile.avatarData || null
        });
      }
      this.pruneProfileCache();
      if (!this.rooms.has(roomId)) return;
      this.broadcastToRoom(room, 'roomProfiles', {
        roomId,
        profiles: Object.fromEntries(usernames.map(name => [
          name,
          this.profileCache.get(name) || { displayName: name, avatarData: null }
        ]))
      });
    } catch (error) {
      console.error('Failed to refresh room profiles:', error);
    }
  }

  refreshRoomProfilesSoon(room, roomId) {
    if (!this.store || !room) return;
    const task = this.refreshRoomProfiles(room, roomId);
    this.profileTasks.add(task);
    task.finally(() => this.profileTasks.delete(task));
  }

  async flushProfileTasks() {
    while (this.profileTasks.size > 0) {
      await Promise.all([...this.profileTasks]);
    }
  }

  pruneProfileCache() {
    const active = new Set();
    for (const room of this.rooms.values()) {
      for (const name of this.getRoomUsernames(room)) active.add(name);
    }
    for (const key of this.profileCache.keys()) {
      if (!active.has(key)) this.profileCache.delete(key);
    }
  }

  handleProfileChanged(username) {
    if (!username) return { success: false, error: '用户名无效' };
    this.profileCache.delete(username);
    for (const [roomId, room] of this.rooms) {
      if (this.getRoomUsernames(room).includes(username)) {
        this.refreshRoomProfilesSoon(room, roomId);
      }
    }
    return { success: true };
  }

  emitOwnerStartPromptIfNeeded(room, roomId) {
    if (!this.canRoomStart(room)) {
      room.startPromptShown = false;
      return;
    }
    if (room.startPromptShown) return;
    const socket = this.onlineUsers.get(room.owner);
    if (!socket) return;
    room.startPromptShown = true;
    this.emit(socket, 'ownerStartPrompt', {
      roomId,
      roomName: room.name,
      humanPlayerCount: this.getHumanPlayers(room).length,
      readyHumanCount: this.getHumanPlayers(room).filter(player => player.ready).length,
      aiFillCount: room.players.filter(player => player === null).length,
      players: room.players
    });
  }

  async resumeRoomFlow(room, roomId) {
    if (!room?.game || room.game.gameOver) return;
    if (room.game.phase === 'claiming') {
      const claimant = room.game.claimState?.claimant;
      const seat = room.players.find(player => player?.username === claimant);
      if (seat?.isAI) this.schedule(() => this.autoResolveAiClaim(room, roomId), AI_CLAIM_DELAY_MS);
      return;
    }
    if (room.game.phase === 'bottomReveal') return; // 公示结束的调度已在要地主时注册
    if (room.game.phase === 'selectingMarked') {
      const landlord = room.players.find(player => player?.username === room.game.landlord);
      if (landlord?.isAI) this.schedule(() => this.autoSelectMarkedCards(room, roomId), AI_MARKED_SELECT_DELAY_MS);
      return;
    }
    if (room.game.phase === 'doubling') {
      this.autoResolveAiDoubleChoices(room, roomId);
      return;
    }
    if (room.game.phase === 'playing') {
      this.schedule(() => this.doAiTurn(room, roomId), AI_TURN_DELAY_MS + Math.floor(Math.random() * AI_TURN_DELAY_JITTER_MS));
    }
  }

  async autoSelectMarkedCards(room, roomId) {
    if (!room.game || room.game.phase !== 'selectingMarked') return;
    const option = room.game.getMarkedCardOptions()[0];
    if (!option) room.game.startDoublingIfNeeded();
    else {
      const matching = room.game.hands[room.game.landlord].filter(card => card.id === option.id);
      room.game.selectMarkedCards([matching[0].uid, matching[1].uid]);
    }
    this.broadcastGameState(roomId);
    this.resumeRoomFlow(room, roomId);
    await this.persistRooms();
  }

  async autoResolveAiDoubleChoices(room, roomId) {
    if (!room.game || room.game.phase !== 'doubling') return;
    for (const player of room.players) {
      if (!player?.isAI) continue;
      if (Object.prototype.hasOwnProperty.call(room.game.doubleDecisions, player.username)) continue;
      room.game.chooseDouble(player.username, false);
    }
    this.broadcastGameState(roomId);
    if (room.game.phase === 'playing') this.resumeRoomFlow(room, roomId);
    await this.persistRooms();
  }

  async doAiTurn(room, roomId) {
    if (!room.game || room.game.gameOver || room.game.phase !== 'playing') return;
    const currentPlayer = room.game.getCurrentPlayer();
    const player = room.players.find(item => item?.username === currentPlayer);
    if (!player?.isAI) return;
    try {
      const aiSettings = await this.getAiSettings();
      const difficulty = aiSettings.difficulty;
      const state = room.game.getStateForPlayer(currentPlayer);
      state.aiDifficulty = difficulty;
      state.hints = room.game.getHints(currentPlayer, { difficulty });
      const decision = await this.createAI({ ...aiSettings, difficulty }).decide(state);
      // 异步等待期间对局可能已结束或房间被关闭
      if (!room.game || room.game.gameOver || room.game.getCurrentPlayer() !== currentPlayer) return;
      let result = decision.action === 'pass'
        ? room.game.pass(currentPlayer)
        : room.game.playCards(currentPlayer, decision.cards);
      if (!result.success) {
        result = this.getAiFallbackResult(room, currentPlayer, state);
      }
      if (result.success) {
        this.broadcastGameState(roomId);
        if (result.gameOver) await this.handleGameOver(room, roomId, result);
        else this.resumeRoomFlow(room, roomId);
        await this.persistRooms();
      }
    } catch (error) {
      console.error('AI turn failed:', error);
      if (!room.game || room.game.gameOver || room.game.getCurrentPlayer() !== currentPlayer) return;
      const fallback = this.getAiFallbackResult(room, currentPlayer, room.game.getStateForPlayer(currentPlayer));
      if (fallback.success) {
        this.broadcastGameState(roomId);
        if (fallback.gameOver) await this.handleGameOver(room, roomId, fallback);
        else this.resumeRoomFlow(room, roomId);
        await this.persistRooms();
      }
    }
  }

  getAiFallbackResult(room, currentPlayer, state) {
    if (!room?.game) return { success: false, error: '对局不存在' };
    if (!state.mustPlay) {
      const passResult = room.game.pass(currentPlayer);
      if (passResult.success) return passResult;
    }

    const hints = room.game.getHints(currentPlayer, { difficulty: 'normal' });
    for (const hint of hints) {
      const playResult = room.game.playCards(currentPlayer, hint);
      if (playResult.success) return playResult;
    }

    const hand = room.game.hands[currentPlayer] || [];
    if (hand.length > 0) {
      return room.game.playCards(currentPlayer, [hand[0].uid]);
    }

    return { success: false, error: 'AI 无可用出牌' };
  }

  async handleGameOver(room, roomId, result) {
    room.status = 'finished';
    const spectatorState = this.augmentGameState(room, room.game.getStateForSpectator());
    const payload = {
      roomId,
      roundId: room.roundId,
      winner: result.winner,
      winnerTeam: result.winnerTeam,
      scores: result.scores,
      settings: this.describeRoomSettings(room),
      lastPlay: spectatorState.lastPlay,
      players: spectatorState.players,
      playerDisplayNames: spectatorState.playerDisplayNames,
      finalHands: room.game.getAllHandsSnapshot()
    };
    room.finalResult = payload;
    for (const player of room.players) {
      if (!player || player.isAI) continue;
      const socket = this.onlineUsers.get(player.username);
      if (socket) this.emit(socket, 'gameOver', payload);
    }
    for (const spectator of room.spectators) {
      const socket = this.onlineUsers.get(spectator.username);
      if (socket) this.emit(socket, 'spectatorGameOver', payload);
    }
    if (this.store) {
      await this.store.saveGameHistory({
        id: randomId(12),
        roomName: room.name,
        players: room.players.map(player => player?.username || null),
        landlord: room.game.landlord,
        hiddenLandlord: room.game.hiddenLandlord,
        winner: result.winner,
        winnerTeam: result.winnerTeam,
        scores: result.scores,
        turnHistory: room.game.turnHistory,
        markedCard: room.game.markedCard?.id || '',
        initialHands: room.game.initialHandsSnapshot
      });
      for (const [playerName, score] of Object.entries(result.scores || {})) {
        const seat = room.players.find(player => player?.username === playerName);
        if (seat?.isAI) continue;
        await this.store.updateStats(playerName, score > 0 ? 1 : 0, score <= 0 ? 1 : 0, score);
      }
    }
    this.broadcastRoomList();
    await this.persistRooms();
  }

  settleFinishedRoom(room, roomId) {
    room.status = 'waiting';
    room.game = null;
    room.finalResult = null;
    room.players = room.players.map((player, index) => player && !player.isAI
      ? { username: player.username, ready: false, isAI: false, seatIndex: index }
      : null);
    room.spectators = [];
    room.spectateRequests = [];
    if (!this.getHumanPlayers(room).some(player => player.username === room.owner)) room.owner = this.getHumanPlayers(room)[0]?.username || null;
    if (this.getHumanPlayers(room).length === 0) this.rooms.delete(roomId);
    else this.broadcastRoomState(roomId);
    this.broadcastRoomList();
  }

  broadcastToRoom(room, event, payload) {
    const recipients = new Set();
    for (const player of room.players) if (player && !player.isAI) recipients.add(player.username);
    for (const spectator of room.spectators) recipients.add(spectator.username);
    for (const username of recipients) {
      const socket = this.onlineUsers.get(username);
      if (socket) this.emit(socket, event, payload);
    }
  }

  emit(socket, event, data = null) {
    if (!socket || socket.readyState > 1) return;
    socket.send(makeSocketMessage(event, data));
  }

  buildTakeoverAiName(room, username, seatIndex) {
    const base = `AI_${String(username || `Seat${seatIndex + 1}`).replace(/[^\w\u4e00-\u9fa5]/g, '_')}`.slice(0, 24);
    let candidate = base || `AI_${seatIndex + 1}`;
    let suffix = 1;
    while (room.players.some((player, index) => index !== seatIndex && player?.username === candidate)) {
      candidate = `${base}_${suffix++}`;
    }
    return candidate;
  }
}
