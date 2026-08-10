export class FakeD1Database {
  constructor() {
    this.tables = {
      users: [],
      game_history: [],
      runtime_config: [{ key: 'aiDifficulty', value: 'normal', updated_at: nowSql() }]
    };
  }

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }
}

export class FakeSocket extends EventTarget {
  constructor() {
    super();
    this.sent = [];
    this.readyState = 1;
  }

  send(message) {
    this.sent.push(typeof message === 'string' ? JSON.parse(message) : message);
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }

  receive(message) {
    this.dispatchEvent(new MessageEvent('message', { data: message }));
  }

  events(name) {
    return this.sent.filter(message => message.event === name).map(message => message.data);
  }
}

export class FakeStorage {
  constructor(initial = {}) {
    this.data = new Map(Object.entries(initial));
  }

  async get(key) {
    return this.data.get(key);
  }

  async put(key, value) {
    this.data.set(key, value);
  }

  async delete(key) {
    this.data.delete(key);
  }
}

class FakeD1Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = normalizeSql(sql);
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async first() {
    return execute(this.db, this.sql, this.params).first ?? null;
  }

  async all() {
    return { results: execute(this.db, this.sql, this.params).results ?? [] };
  }

  async run() {
    execute(this.db, this.sql, this.params);
    return { success: true };
  }
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function nowSql() {
  return new Date().toISOString();
}

function clone(row) {
  return row ? JSON.parse(JSON.stringify(row)) : row;
}

function like(value, pattern) {
  const text = String(value ?? '');
  const needle = String(pattern ?? '').replace(/^%|%$/g, '');
  return text.includes(needle);
}

function execute(db, sql, params) {
  if (sql.startsWith('SELECT * FROM users WHERE username = ? OR nickname = ?')) {
    return { first: clone(db.tables.users.find(user => user.username === params[0] || user.nickname === params[1])) };
  }

  if (sql.startsWith('SELECT * FROM users WHERE username = ?')) {
    return { first: clone(db.tables.users.find(user => user.username === params[0])) };
  }

  if (sql.startsWith('SELECT username FROM users WHERE (username = ? OR nickname = ?) AND username <> ?')) {
    return { first: clone(db.tables.users.find(user => (user.username === params[0] || user.nickname === params[1]) && user.username !== params[2])) };
  }

  if (sql.startsWith('INSERT INTO users')) {
    const [id, username, nickname, passwordHash] = params;
    if (db.tables.users.some(user => user.username === username || user.nickname === nickname)) {
      throw new Error('UNIQUE constraint failed');
    }
    db.tables.users.push({
      id,
      username,
      nickname,
      password_hash: passwordHash,
      wins: 0,
      losses: 0,
      games_played: 0,
      score: 0,
      avatar_data: null,
      nickname_updated_at: null,
      created_at: nowSql(),
      last_login: nowSql()
    });
    return {};
  }

  if (sql.startsWith('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE username = ?')) {
    const user = db.tables.users.find(item => item.username === params[0]);
    if (user) user.last_login = nowSql();
    return {};
  }

  if (sql.startsWith('UPDATE users SET nickname = ?, nickname_updated_at = ? WHERE username = ?')) {
    const [nickname, timestamp, username] = params;
    const user = db.tables.users.find(item => item.username === username);
    if (user) {
      user.nickname = nickname;
      user.nickname_updated_at = timestamp;
    }
    return {};
  }

  if (sql.startsWith('UPDATE users SET avatar_data = ? WHERE username = ?')) {
    const [avatarData, username] = params;
    const user = db.tables.users.find(item => item.username === username);
    if (user) user.avatar_data = avatarData;
    return {};
  }

  if (sql.startsWith('SELECT username, nickname, avatar_data FROM users WHERE username IN')) {
    return { results: db.tables.users.filter(user => params.includes(user.username)).map(clone) };
  }

  if (sql.startsWith('SELECT username, nickname, wins, losses, games_played, score FROM users ORDER BY score DESC')) {
    return { results: db.tables.users.slice().sort((a, b) => b.score - a.score).slice(0, params[0] || 20).map(clone) };
  }

  if (sql.startsWith('SELECT username, nickname, wins, losses, games_played, score FROM users WHERE username = ?')) {
    return { first: clone(db.tables.users.find(user => user.username === params[0])) };
  }

  if (sql.startsWith('UPDATE users SET wins = wins + ?')) {
    const [wins, losses, score, username] = params;
    const user = db.tables.users.find(item => item.username === username);
    if (user) {
      user.wins += wins;
      user.losses += losses;
      user.games_played += 1;
      user.score += score;
    }
    return {};
  }

  if (sql.startsWith('SELECT id, username, nickname, nickname_updated_at, wins, losses, games_played, score, created_at, last_login FROM users WHERE username = ?')) {
    return { first: clone(db.tables.users.find(user => user.username === params[0])) };
  }

  if (sql.startsWith('UPDATE users SET ')) {
    const username = params.at(-1);
    const user = db.tables.users.find(item => item.username === username);
    if (!user) return {};
    const setPart = sql.slice('UPDATE users SET '.length, sql.indexOf(' WHERE username = ?'));
    const fields = setPart.split(',').map(part => part.trim().split(' = ')[0]);
    fields.forEach((field, index) => {
      user[field] = params[index];
    });
    return {};
  }

  if (sql.startsWith('DELETE FROM users WHERE username = ?')) {
    db.tables.users = db.tables.users.filter(user => user.username !== params[0]);
    return {};
  }

  if (sql.startsWith('UPDATE users SET wins = 0, losses = 0, games_played = 0, score = 0 WHERE username = ?')) {
    const user = db.tables.users.find(item => item.username === params[0]);
    if (user) {
      user.wins = 0;
      user.losses = 0;
      user.games_played = 0;
      user.score = 0;
    }
    return {};
  }

  if (sql.startsWith('UPDATE users SET wins = 0, losses = 0, games_played = 0, score = 0')) {
    for (const user of db.tables.users) {
      user.wins = 0;
      user.losses = 0;
      user.games_played = 0;
      user.score = 0;
    }
    return {};
  }

  if (sql.startsWith('SELECT id, username, nickname')) {
    const hasKeyword = params.length === 3;
    const limit = hasKeyword ? params[2] : params[0];
    const rows = db.tables.users.filter(user => {
      if (!hasKeyword) return true;
      return like(user.username, params[0]) || like(user.nickname, params[1]);
    });
    return { results: rows.slice(0, limit).map(clone) };
  }

  if (sql.startsWith('SELECT COUNT(*) AS user_count')) {
    return {
      first: {
        user_count: db.tables.users.length,
        total_score: db.tables.users.reduce((sum, user) => sum + user.score, 0),
        total_games_played: db.tables.users.reduce((sum, user) => sum + user.games_played, 0),
        history_count: db.tables.game_history.length
      }
    };
  }

  if (sql.startsWith('SELECT value FROM runtime_config WHERE key = ?')) {
    return { first: clone(db.tables.runtime_config.find(row => row.key === params[0])) };
  }

  if (sql.startsWith('INSERT INTO runtime_config')) {
    const [key, value] = params;
    const existing = db.tables.runtime_config.find(row => row.key === key);
    if (existing) existing.value = value;
    else db.tables.runtime_config.push({ key, value, updated_at: nowSql() });
    return {};
  }

  if (sql.startsWith('INSERT INTO game_history')) {
    const [id, roomName, players, landlord, hiddenLandlord, winner, winnerTeam, scores, turnHistory, markedCard, initialHands, roomId] = params;
    db.tables.game_history.push({
      id,
      room_name: roomName,
      players,
      landlord,
      hidden_landlord: hiddenLandlord,
      winner,
      winner_team: winnerTeam,
      scores,
      turn_history: turnHistory,
      marked_card: markedCard,
      initial_hands: initialHands,
      room_id: roomId || '',
      created_at: nowSql()
    });
    return {};
  }

  if (sql.startsWith('SELECT id, room_name, players, landlord, hidden_landlord, winner, winner_team, scores, marked_card, created_at, room_id FROM game_history WHERE room_id = ?')) {
    const [roomId, roomName, limit] = params;
    const rows = db.tables.game_history.filter(game => game.room_id === roomId || (!game.room_id && game.room_name === roomName));
    return { results: rows.slice(0, limit || 500).map(clone) };
  }

  if (sql.startsWith('SELECT id, room_name, players')) {
    if (params.length > 1) {
      const needle = String(params[0] ?? '').replace(/^%|%$/g, '');
      const rows = db.tables.game_history.filter(game =>
        [game.room_name, game.players, game.landlord, game.winner].some(value => String(value ?? '').includes(needle))
      );
      return { results: rows.slice().reverse().slice(0, params[4] || 200).map(clone) };
    }
    return { results: db.tables.game_history.slice().reverse().slice(0, params[0] || 50).map(clone) };
  }

  if (sql.startsWith('SELECT * FROM game_history WHERE id = ?')) {
    return { first: clone(db.tables.game_history.find(game => game.id === params[0])) };
  }

  if (sql.startsWith('UPDATE game_history SET ')) {
    const id = params.at(-1);
    const game = db.tables.game_history.find(item => item.id === id);
    if (!game) return {};
    const setPart = sql.slice('UPDATE game_history SET '.length, sql.indexOf(' WHERE id = ?'));
    const fields = setPart.split(',').map(part => part.trim().split(' = ')[0]);
    fields.forEach((field, index) => {
      game[field] = params[index];
    });
    return {};
  }

  if (sql.startsWith('DELETE FROM game_history WHERE id = ?')) {
    db.tables.game_history = db.tables.game_history.filter(game => game.id !== params[0]);
    return {};
  }

  if (sql.startsWith('DELETE FROM game_history')) {
    db.tables.game_history = [];
    return {};
  }

  throw new Error(`FakeD1 does not implement SQL: ${sql}`);
}
