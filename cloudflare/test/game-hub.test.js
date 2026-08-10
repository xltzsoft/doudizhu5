import { describe, expect, it, vi } from 'vitest';
import { GameHubCore } from '../src/game-hub.js';
import { FakeD1Database, FakeSocket, FakeStorage } from './fakes.js';
import { D1Store } from '../src/d1-store.js';

function makeCore() {
  const scheduled = [];
  const core = new GameHubCore({
    store: new D1Store(new FakeD1Database()),
    getAiDifficulty: async () => 'normal',
    schedule: callback => scheduled.push(callback)
  });
  core.flushScheduled = async () => {
    while (scheduled.length) await scheduled.shift()();
  };
  return core;
}

async function makePersistedCore(storage, options = {}) {
  const scheduled = [];
  const core = await GameHubCore.create({
    storage,
    store: new D1Store(new FakeD1Database()),
    getAiDifficulty: async () => 'normal',
    schedule: callback => scheduled.push(callback),
    ...options
  });
  core.flushScheduled = async () => {
    while (scheduled.length) await scheduled.shift()();
  };
  return core;
}

function makeCoreWithAi(ai) {
  const core = makeCore();
  core.createAI = () => ai;
  return core;
}

function attach(core, username) {
  const socket = new FakeSocket();
  core.attachSocket(username, socket);
  return socket;
}

describe('GameHubCore', () => {
  it('creates a room, seats five humans, and starts only after owner confirmation', () => {
    const core = makeCore();
    const ownerSocket = attach(core, 'p1');
    attach(core, 'p2');
    attach(core, 'p3');
    attach(core, 'p4');
    attach(core, 'p5');

    const created = core.createRoom('p1', ownerSocket, { name: '测试房', settings: { baseScore: 20 } });
    for (const name of ['p2', 'p3', 'p4', 'p5']) {
      expect(core.joinRoom(name, core.onlineUsers.get(name), created.roomId)).toMatchObject({ success: true });
    }
    for (const name of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      core.toggleReady(name, created.roomId);
    }

    const room = core.rooms.get(created.roomId);
    expect(room.players.map(player => player.username)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(room.status).toBe('waiting');
    expect(ownerSocket.events('ownerStartPrompt').at(-1)).toMatchObject({ roomId: created.roomId, humanPlayerCount: 5, aiFillCount: 0 });

    const started = core.startGame('p1', created.roomId);
    expect(started).toMatchObject({ success: true });
    expect(room.status).toBe('playing');
    expect(room.players.some(player => player.isAI)).toBe(false);
    expect(room.game.playerNames).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('emits gameDeal with per-player deal order when the game starts', () => {
    const core = makeCore();
    const ownerSocket = attach(core, 'owner');
    const p2Socket = attach(core, 'p2');
    const { roomId } = core.createRoom('owner', ownerSocket, {});
    core.joinRoom('p2', p2Socket, roomId);
    core.toggleReady('owner', roomId);
    core.toggleReady('p2', roomId);

    expect(core.startGame('owner', roomId)).toMatchObject({ success: true });
    const room = core.rooms.get(roomId);

    for (const [name, socket] of [['owner', ownerSocket], ['p2', p2Socket]]) {
      const deal = socket.events('gameDeal').at(-1);
      expect(deal).toMatchObject({
        roomId,
        roundId: room.roundId,
        myName: name,
        landlord: room.game.landlord,
        bottomCount: 7
      });
      expect(deal.seatOrder).toHaveLength(5);
      expect(deal.myHandOrder).toHaveLength(31);
      expect(deal.markedCard).toBeTruthy();
      // 发牌顺序必须与引擎中该玩家的手牌一致（与排序无关）
      const handUids = new Set((room.game.hands[name] || []).map(card => card.uid));
      for (const uid of deal.myHandOrder) expect(handUids.has(uid)).toBe(true);
    }

    // 全部座位的 31*5 张手牌 + 7 张底牌 = 162 张互不重复的牌
    const sequence = room.game.getDealSequence();
    const allUids = Object.values(sequence.hands).flat().concat(sequence.bottom);
    expect(allUids).toHaveLength(162);
    expect(new Set(allUids).size).toBe(162);
  });

  it('runs the landlord claim flow: decline around the table, must-take, claim, reveal', async () => {
    const core = makeCore();
    const sockets = {};
    for (const name of ['p1', 'p2', 'p3', 'p4', 'p5']) sockets[name] = attach(core, name);
    const { roomId } = core.createRoom('p1', sockets.p1, {});
    for (const name of ['p2', 'p3', 'p4', 'p5']) core.joinRoom(name, sockets[name], roomId);
    for (const name of ['p1', 'p2', 'p3', 'p4', 'p5']) core.toggleReady(name, roomId);
    expect(core.startGame('p1', roomId)).toMatchObject({ success: true });

    const room = core.rooms.get(roomId);
    expect(room.game.phase).toBe('claiming');
    expect(room.game.landlord).toBeNull();
    const original = room.game.claimState.claimant;
    // 底牌在要地主之前不平分
    expect(room.game.playerNames.map(name => room.game.hands[name].length)).toEqual([31, 31, 31, 31, 31]);
    // 每个玩家都收到要地主决策状态，且只有当前决策人 isMyDecision
    const st = sockets[original].events('gameState').at(-1);
    expect(st.phase).toBe('claiming');
    expect(st.claim).toMatchObject({ claimant: original, original, mustTake: false, isMyDecision: true });

    // 非决策人不能要/不要
    const other = room.game.playerNames.find(name => name !== original);
    expect((await core.claimLandlord(other, roomId)).success).toBe(false);
    expect((await core.declineLandlord(other, roomId)).success).toBe(false);

    // 依次不要，轮完一圈回到原点时必须接受
    let claimant = original;
    for (let i = 0; i < 5; i++) {
      const result = await core.declineLandlord(claimant, roomId);
      expect(result.success).toBe(true);
      claimant = result.nextClaimant;
    }
    expect(claimant).toBe(original);
    expect(room.game.claimState.mustTake).toBe(true);
    expect((await core.declineLandlord(original, roomId)).success).toBe(false);

    // 要地主：拿到底牌，进入公示阶段
    const claimed = await core.claimLandlord(original, roomId);
    expect(claimed.success).toBe(true);
    expect(room.game.phase).toBe('bottomReveal');
    expect(room.game.landlord).toBe(original);
    expect(room.game.hands[original]).toHaveLength(38);
    expect(room.game.initialHandsSnapshot[original]).toHaveLength(38);
    const revealState = sockets.p2.events('gameState').at(-1);
    expect(revealState.bottomReveal).toMatchObject({ landlord: original });
    expect(revealState.bottomReveal.cards).toHaveLength(7);

    // 公示 8 秒的调度执行后进入选明牌阶段
    await core.flushScheduled();
    expect(room.game.phase).toBe('selectingMarked');
  });

  it('lets only the room owner redeal during the claim phase', async () => {
    const core = makeCore();
    const ownerSocket = attach(core, 'owner');
    const p2Socket = attach(core, 'p2');
    const { roomId } = core.createRoom('owner', ownerSocket, {});
    core.joinRoom('p2', p2Socket, roomId);
    core.toggleReady('owner', roomId);
    core.toggleReady('p2', roomId);
    expect(core.startGame('owner', roomId)).toMatchObject({ success: true });

    const room = core.rooms.get(roomId);
    expect(room.game.phase).toBe('claiming');
    const firstRoundId = room.roundId;

    expect(core.redealGame('p2', roomId).success).toBe(false);
    const redealt = core.redealGame('owner', roomId);
    expect(redealt.success).toBe(true);
    expect(room.roundId).not.toBe(firstRoundId);
    expect(room.game.phase).toBe('claiming');
    expect(room.game.landlord).toBeNull();
    // 重新发牌后客户端会收到新的发牌事件
    expect(ownerSocket.events('gameDeal').length).toBe(2);
    expect(p2Socket.events('gameDeal').length).toBe(2);
    expect(ownerSocket.events('gameDeal').at(-1).roundId).toBe(room.roundId);

    // 过了要地主阶段不能再洗牌
    await core.claimLandlord(room.game.claimState.claimant, roomId);
    expect(core.redealGame('owner', roomId).success).toBe(false);
  });

  it('auto-resolves claim decisions for AI seats', async () => {
    const core = makeCore();
    const ownerSocket = attach(core, 'owner');
    const { roomId } = core.createRoom('owner', ownerSocket, {});
    core.toggleReady('owner', roomId);
    expect(core.startGame('owner', roomId)).toMatchObject({ success: true });

    const room = core.rooms.get(roomId);
    expect(room.players.filter(player => player.isAI)).toHaveLength(4);
    // AI 座位是要地主决策人时，调度后自动要/不要
    await core.flushScheduled();
    if (room.game.phase === 'claiming') {
      // 只剩真人（房主）未决定，手动要地主
      expect(room.game.claimState.claimant).toBe('owner');
      expect((await core.claimLandlord('owner', roomId)).success).toBe(true);
      await core.flushScheduled();
    }
    // 地主已确定并经过公示；若地主是 AI，选明牌/加倍也会被自动推进
    expect(['selectingMarked', 'doubling', 'playing']).toContain(room.game.phase);
    expect(room.game.landlord).toBeTruthy();
  });

  it('fills empty seats with AI when prepared humans start', () => {
    const core = makeCore();
    const ownerSocket = attach(core, 'owner');
    attach(core, 'p2');
    const { roomId } = core.createRoom('owner', ownerSocket, {});
    core.joinRoom('p2', core.onlineUsers.get('p2'), roomId);
    core.toggleReady('owner', roomId);
    core.toggleReady('p2', roomId);

    expect(core.startGame('owner', roomId)).toMatchObject({ success: true });
    const room = core.rooms.get(roomId);
    expect(room.players).toHaveLength(5);
    expect(room.players.filter(player => player.isAI)).toHaveLength(3);

    const summary = core.getRoomList()[0];
    expect(summary).toMatchObject({
      id: roomId,
      humanPlayers: ['owner', 'p2'],
      aiPlayers: ['AI_3', 'AI_4', 'AI_5'],
      spectatorCount: 0,
      spectators: [],
      pendingSpectateRequests: 0
    });
    expect(summary.humanPlayerDetails.map(player => player.username)).toEqual(['owner', 'p2']);
    expect(summary.playerDetails).toHaveLength(5);
  });

  it('builds admin room snapshots with room, room state, and optional spectator game state', () => {
    const core = makeCore();
    const ownerSocket = attach(core, 'owner');
    const { roomId } = core.createRoom('owner', ownerSocket, { name: '后台房间' });

    expect(core.getAdminRoomSnapshot(roomId)).toMatchObject({
      success: true,
      room: {
        id: roomId,
        name: '后台房间',
        humanPlayers: ['owner'],
        aiPlayers: [],
        pendingSpectateRequests: 0
      },
      roomState: {
        id: roomId,
        status: 'waiting'
      },
      gameState: null
    });

    core.toggleReady('owner', roomId);
    core.startGame('owner', roomId);

    const playingSnapshot = core.getAdminRoomSnapshot(roomId);
    expect(playingSnapshot).toMatchObject({
      success: true,
      room: {
        status: 'playing',
        aiPlayers: ['AI_2', 'AI_3', 'AI_4', 'AI_5']
      },
      gameState: {
        roomId
      }
    });
  });

  it('replaces disconnected players with confirmable AI and lets users reclaim the seat', () => {
    const core = makeCore();
    const p1 = attach(core, 'p1');
    const p2 = attach(core, 'p2');
    attach(core, 'p3');
    const { roomId } = core.createRoom('p1', p1, {});
    core.joinRoom('p2', p2, roomId);
    core.joinRoom('p3', core.onlineUsers.get('p3'), roomId);
    for (const name of ['p1', 'p2', 'p3']) core.toggleReady(name, roomId);
    core.startGame('p1', roomId);

    p2.close();
    const room = core.rooms.get(roomId);
    const pending = Object.values(room.pendingAiTakeovers)[0];
    expect(pending).toMatchObject({ username: 'p2', reviewer: 'p1' });
    expect(p1.events('aiTakeoverRequest').at(-1)).toMatchObject({ username: 'p2' });

    expect(core.respondAiTakeover('p1', { roomId, requestId: pending.requestId, accept: true })).toMatchObject({ success: true, accepted: true });
    const aiSeat = room.players.find(player => player.originalUsername === 'p2');
    expect(aiSeat).toMatchObject({ isAI: true, rejoinable: true });

    attach(core, 'p2');
    const reclaimed = room.players.find(player => player.username === 'p2');
    expect(reclaimed).toMatchObject({ isAI: false, username: 'p2' });
    expect(room.game.playerNames).toContain('p2');
  });

  it('keeps finished games in the room until manual settlement', async () => {
    const core = makeCore();
    const p1 = attach(core, 'p1');
    attach(core, 'p2');
    const { roomId } = core.createRoom('p1', p1, {});
    core.joinRoom('p2', core.onlineUsers.get('p2'), roomId);
    core.toggleReady('p1', roomId);
    core.toggleReady('p2', roomId);
    core.startGame('p1', roomId);
    const room = core.rooms.get(roomId);

    await core.handleGameOver(room, roomId, {
      winner: 'p1',
      winnerTeam: room.game.getTeam('p1'),
      scores: Object.fromEntries(room.players.map(player => [player.username, player.username === 'p1' ? 10 : -10]))
    });

    expect(room.status).toBe('finished');
    expect(room.finalResult).toMatchObject({ winner: 'p1' });
    expect(core.settleGame('p1', roomId)).toMatchObject({ success: true });
    expect(room.status).toBe('waiting');
    expect(room.game).toBeNull();
  });

  it('does not get stuck when AI returns an invalid play while it must play', async () => {
    const createAI = vi.fn(() => ({
      decide: async () => ({ action: 'play', cards: ['not-in-hand'] })
    }));
    const core = makeCoreWithAi({
      decide: async () => ({ action: 'play', cards: ['not-in-hand'] })
    });
    core.createAI = createAI;
    const p1 = attach(core, 'p1');
    const { roomId } = core.createRoom('p1', p1, {});
    core.toggleReady('p1', roomId);
    core.startGame('p1', roomId);
    const room = core.rooms.get(roomId);
    const ai2Index = room.game.playerNames.indexOf('AI_2');
    room.game.phase = 'playing';
    room.game.currentPlayer = ai2Index;
    room.game.lastPlay = null;
    room.game.lastPlayPlayer = null;

    await core.doAiTurn(room, roomId);

    expect(createAI).toHaveBeenCalled();
    expect(room.game.getCurrentPlayer()).not.toBe('AI_2');
    expect(room.game.turnHistory.at(-1)).toMatchObject({ player: 'AI_2', action: 'play' });
  });

  it('passes persisted LLM settings into AI turns', async () => {
    const createAI = vi.fn(() => ({
      decide: async state => ({ action: 'play', cards: state.hints[0] || [] })
    }));
    const core = new GameHubCore({
      store: new D1Store(new FakeD1Database()),
      getAiSettings: async () => ({
        difficulty: 'hard',
        llmEnabled: true,
        llmApiUrl: 'http://sub.stzo.cn:11666/v1',
        llmModel: 'K2.6-Inst'
      }),
      createAI,
      schedule: () => {}
    });
    const p1 = attach(core, 'p1');
    const { roomId } = core.createRoom('p1', p1, {});
    core.toggleReady('p1', roomId);
    core.startGame('p1', roomId);
    const room = core.rooms.get(roomId);
    const aiName = room.players.find(player => player?.isAI)?.username;
    room.game.phase = 'playing';
    room.game.currentPlayer = room.game.playerNames.indexOf(aiName);
    room.game.lastPlay = null;
    room.game.lastPlayPlayer = null;

    await core.doAiTurn(room, roomId);

    expect(createAI).toHaveBeenCalledWith(expect.objectContaining({
      difficulty: 'hard',
      llmEnabled: true,
      llmApiUrl: 'http://sub.stzo.cn:11666/v1',
      llmModel: 'K2.6-Inst'
    }));
    expect(createAI.mock.calls[0][0]).not.toHaveProperty('disableLlm');
  });

  it('restores an in-progress room snapshot after Durable Object memory is recreated', async () => {
    const core = makeCore();
    const p1 = attach(core, 'p1');
    attach(core, 'p2');
    const { roomId } = core.createRoom('p1', p1, { name: '持久房' });
    core.joinRoom('p2', core.onlineUsers.get('p2'), roomId);
    core.toggleReady('p1', roomId);
    core.toggleReady('p2', roomId);
    core.startGame('p1', roomId);

    const snapshot = core.exportSnapshot();
    const restored = makeCore();
    restored.importSnapshot(snapshot);
    const restoredRoom = restored.rooms.get(roomId);

    expect(restoredRoom).toMatchObject({ id: roomId, name: '持久房', status: 'playing' });
    expect(restoredRoom.game.getCurrentPlayer()).toBe(core.rooms.get(roomId).game.getCurrentPlayer());

    const reconnected = attach(restored, 'p1');
    expect(reconnected.events('roomState').at(-1)).toMatchObject({ id: roomId, status: 'playing' });
    expect(reconnected.events('gameState').at(-1)).toMatchObject({ roomId });
  });

  it('loads persisted rooms from Durable Object storage before serving room list', async () => {
    const core = makeCore();
    const p1 = attach(core, 'p1');
    const { roomId } = core.createRoom('p1', p1, { name: 'DO恢复房' });
    const storage = new FakeStorage({ roomsSnapshot: core.exportSnapshot() });
    const restored = await GameHubCore.create({
      storage,
      store: new D1Store(new FakeD1Database()),
      getAiDifficulty: async () => 'normal'
    });

    expect(restored.getRoomList()[0]).toMatchObject({ id: roomId, name: 'DO恢复房' });
  });

  it('persists room mutations after websocket events', async () => {
    const storage = new FakeStorage();
    const core = await makePersistedCore(storage);
    const p1 = attach(core, 'p1');

    const created = await core.dispatchEvent('p1', p1, 'createRoom', { name: '自动保存房' });

    const snapshot = await storage.get('roomsSnapshot');
    expect(snapshot.rooms[0]).toMatchObject({ id: created.roomId, name: '自动保存房' });
  });

  it('resumes an AI turn after restoring a playing room', async () => {
    const source = makeCore();
    const p1 = attach(source, 'p1');
    const { roomId } = source.createRoom('p1', p1, { name: '恢复AI房' });
    source.toggleReady('p1', roomId);
    source.startGame('p1', roomId);

    const room = source.rooms.get(roomId);
    const aiName = room.players.find(player => player?.isAI)?.username;
    room.game.phase = 'playing';
    room.game.currentPlayer = room.game.playerNames.indexOf(aiName);
    room.game.lastPlay = null;
    room.game.lastPlayPlayer = null;

    const storage = new FakeStorage({ roomsSnapshot: source.exportSnapshot() });
    const restored = await makePersistedCore(storage, {
      createAI: () => ({
        decide: async state => ({ action: 'play', cards: state.hints[0] || [] })
      })
    });

    await restored.flushScheduled();

    const restoredRoom = restored.rooms.get(roomId);
    expect(restoredRoom.game.getCurrentPlayer()).not.toBe(aiName);
  });

  it('asks online players to confirm AI takeover for offline seats after restore', async () => {
    const source = makeCore();
    const p1 = attach(source, 'p1');
    attach(source, 'p2');
    const { roomId } = source.createRoom('p1', p1, { name: '恢复断线房' });
    source.joinRoom('p2', source.onlineUsers.get('p2'), roomId);
    source.toggleReady('p1', roomId);
    source.toggleReady('p2', roomId);
    source.startGame('p1', roomId);

    const storage = new FakeStorage({ roomsSnapshot: source.exportSnapshot() });
    const restored = await makePersistedCore(storage);
    const reconnected = attach(restored, 'p1');

    expect(reconnected.events('aiTakeoverRequest').at(-1)).toMatchObject({
      roomId,
      username: 'p2'
    });
  });

  it('pushes nicknames and avatars to room members and uses them in states', async () => {
    const db = new FakeD1Database();
    const store = new D1Store(db);
    await store.createUser('u1', 'p1', 'hash', '小明');
    await store.updateAvatar('p1', 'data:image/webp;base64,QUJD');
    await store.createUser('u2', 'p2', 'hash', '小红');
    const scheduled = [];
    const core = new GameHubCore({
      store,
      getAiDifficulty: async () => 'normal',
      schedule: callback => scheduled.push(callback)
    });
    const s1 = attach(core, 'p1');
    const s2 = attach(core, 'p2');
    const { roomId } = core.createRoom('p1', s1, { name: '资料房' });
    core.joinRoom('p2', s2, roomId);
    await core.flushProfileTasks();

    const profilesEvent = s2.events('roomProfiles').at(-1);
    expect(profilesEvent.roomId).toBe(roomId);
    expect(profilesEvent.profiles.p1).toMatchObject({ displayName: '小明', avatarData: 'data:image/webp;base64,QUJD' });
    expect(profilesEvent.profiles.p2).toMatchObject({ displayName: '小红', avatarData: null });

    const roomState = core.buildRoomState(core.rooms.get(roomId));
    expect(roomState.players[0]).toMatchObject({ username: 'p1', displayName: '小明' });
    expect(roomState.ownerDisplayName).toBe('小明');
    expect(core.getRoomList()[0].ownerDisplayName).toBe('小明');

    core.toggleReady('p1', roomId);
    core.toggleReady('p2', roomId);
    core.startGame('p1', roomId);
    const gameStateEvent = s2.events('gameState').at(-1);
    expect(gameStateEvent.playerDisplayNames.p1).toBe('小明');
    expect(gameStateEvent.players.find(player => player.name === 'p1'))
      .toMatchObject({ displayName: '小明', avatarData: null });
  });

  it('refreshes cached profiles when a profile change is reported', async () => {
    const db = new FakeD1Database();
    const store = new D1Store(db);
    await store.createUser('u1', 'p1', 'hash', '旧名');
    const core = new GameHubCore({
      store,
      getAiDifficulty: async () => 'normal',
      schedule: () => {}
    });
    const s1 = attach(core, 'p1');
    const { roomId } = core.createRoom('p1', s1, {});
    await core.flushProfileTasks();
    expect(s1.events('roomProfiles').at(-1).profiles.p1.displayName).toBe('旧名');

    await store.updateNickname('p1', '新名字', new Date().toISOString());
    expect(core.handleProfileChanged('p1')).toMatchObject({ success: true });
    await core.flushProfileTasks();

    expect(s1.events('roomProfiles').at(-1).profiles.p1.displayName).toBe('新名字');
    expect(core.buildRoomState(core.rooms.get(roomId)).players[0].displayName).toBe('新名字');
  });

  it('ignores disconnects from stale sockets of the same account', async () => {
    const core = makeCore();
    const first = attach(core, 'p1');
    const { roomId } = core.createRoom('p1', first, {});
    const second = attach(core, 'p1');

    first.close();

    expect(core.onlineUsers.get('p1')).toBe(second);
    expect(core.rooms.get(roomId).players[0]).toMatchObject({ username: 'p1' });
  });
});
