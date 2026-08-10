/**
 * 五人斗地主游戏引擎
 * 规则：
 * - 3副牌(162张)，5人各31张，留7张底牌
 * - 随机一张非王牌作为明牌，拿到明牌的人是大地主
 * - 拿到同点数同花色另一张牌的人是小地主
 * - 地主方(1-2人) vs 农民方(3-4人)
 * - 大地主先出牌，出完牌的一方获胜
 * - 王炸只认三小王或三大王；三小王在5个2和6个3之间，三大王在6个2和7个3之间
 */

const SUITS = ['♠', '♥', '♣', '♦'];
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const RANK_VALUES = {
  '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, '2': 15,
  'X': 16, 'D': 17 // 小王=X, 大王=D
};
const SUIT_ORDER = { '♠': 0, '♥': 1, '♣': 2, '♦': 3, '': 4 };

let cardUidCounter = 0;

class Card {
  constructor(suit, rank) {
    this.suit = suit; // ♠♥♣♦ or '' for jokers
    this.rank = rank; // 3-2, X(小王), D(大王)
    this.value = RANK_VALUES[rank];
    this.id = suit + rank;
    this.uid = `${suit}${rank}_${cardUidCounter++}`; // Unique across decks
  }

  toString() {
    return this.id;
  }
}

class GameEngine {
  constructor(playerNames, options = {}) {
    this.playerNames = playerNames; // 5 players
    this.hands = {}; // player -> cards
    this.landlord = null; // 明地主
    this.hiddenLandlord = null; // 暗地主
    this.landlordRevealed = false;
    this.currentPlayer = 0; // index
    this.lastPlay = null; // { player, cards, type }
    this.lastPlayPlayer = null;
    this.passCount = 0;
    this.turnHistory = [];
    this.gameOver = false;
    this.winner = null;
    this.markedCard = null; // 明牌
    this.bottomCards = []; // 底牌
    this.landlordCards = []; // 明牌和底牌
    this.phase = 'dealing'; // 'dealing' | 'selectingMarked' | 'doubling' | 'playing'
    this.selectedMarkedCards = null; // 地主选择的明牌 (2张)
    this.initialHandsSnapshot = null; // 回放用开局手牌快照
    this.baseScore = this.normalizeBaseScore(options.baseScore || 10);
    this.doubleEnabled = Boolean(options.doubleEnabled);
    this.doubleDecisions = {};
    this.scoreMultiplier = 1;
    this.revealedPlayers = new Set();
    this.scoringRevealedPlayers = new Set();
  }

  createDeck() {
    const deck = [];
    // 3 decks
    for (let d = 0; d < 3; d++) {
      for (const suit of SUITS) {
        for (const rank of RANKS) {
          deck.push(new Card(suit, rank));
        }
      }
      deck.push(new Card('', 'X')); // 小王
      deck.push(new Card('', 'D')); // 大王
    }
    return deck;
  }

  shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  deal() {
    const deck = this.shuffle(this.createDeck());

    // Deal 31 cards to each player (155 total)
    for (let i = 0; i < 5; i++) {
      this.hands[this.playerNames[i]] = [];
    }

    let cardIdx = 0;
    for (let i = 0; i < 155; i++) {
      const playerIdx = i % 5;
      this.hands[this.playerNames[playerIdx]].push(deck[cardIdx]);
      cardIdx++;
    }

    // Last 7 cards are bottom cards
    this.bottomCards = deck.slice(155, 162);

    // Pick a non-joker card from dealt cards (not bottom cards) as the marked card
    const dealtCards = [];
    for (const name of this.playerNames) {
      for (const card of this.hands[name]) {
        if (card.rank !== 'X' && card.rank !== 'D') {
          dealtCards.push({ card, owner: name });
        }
      }
    }
    const markedEntry = dealtCards[Math.floor(Math.random() * dealtCards.length)];
    this.markedCard = markedEntry.card;

    // The player who holds the actual marked card object is the landlord
    this.landlord = markedEntry.owner;
    this.hiddenLandlord = null;

    // Give bottom cards to landlord
    this.hands[this.landlord].push(...this.bottomCards);

    // Sort all hands
    for (const name of this.playerNames) {
      this.sortHand(name);
    }

    this.initialHandsSnapshot = {};
    for (const name of this.playerNames) {
      this.initialHandsSnapshot[name] = this.hands[name].map(card => card.id);
    }

    // Enter selecting phase - landlord must choose 2 same-suit-same-rank cards as 明牌
    this.phase = 'selectingMarked';
    this.currentPlayer = this.playerNames.indexOf(this.landlord);
    this.lastPlay = null;
    this.lastPlayPlayer = null;
    this.passCount = 0;
  }

  /**
   * 获取地主可以选择的明牌选项（同花色同数字的牌对）
   */
  getMarkedCardOptions() {
    const hand = this.hands[this.landlord];
    if (!hand) return [];
    
    // Group cards by id (suit+rank), only non-joker
    const groups = {};
    for (const c of hand) {
      if (c.rank === 'X' || c.rank === 'D') continue;
      if (!groups[c.id]) groups[c.id] = [];
      groups[c.id].push(c);
    }
    
    // Return groups that have at least 2 cards (can pick 2 from same suit+rank)
    const options = [];
    for (const [id, cards] of Object.entries(groups)) {
      if (cards.length >= 2) {
        options.push({ id, count: cards.length });
      }
    }
    return options;
  }

  /**
   * 地主选择明牌（2张同花色同数字的牌）
   * @param {string[]} cardUids - 2张牌的uid
   */
  selectMarkedCards(cardUids) {
    if (this.phase !== 'selectingMarked') {
      return { success: false, error: '当前不是选择明牌阶段' };
    }
    if (!cardUids || cardUids.length !== 2) {
      return { success: false, error: '请选择2张牌' };
    }

    const hand = this.hands[this.landlord];
    const cards = [];
    for (const uid of cardUids) {
      const card = hand.find(c => c.uid === uid);
      if (!card) return { success: false, error: '你没有这些牌' };
      cards.push(card);
    }

    // Must be same suit and same rank (same id), but different cards (different uid)
    if (cards[0].id !== cards[1].id) {
      return { success: false, error: '必须选择两张同花色同数字的牌' };
    }
    if (cards[0].uid === cards[1].uid) {
      return { success: false, error: '必须选择两张不同的牌' };
    }
    // No jokers
    if (cards[0].rank === 'X' || cards[0].rank === 'D') {
      return { success: false, error: '不能选择王牌作为明牌' };
    }

    this.selectedMarkedCards = cards;
    this.markedCard = cards[0]; // Use first selected as the display marked card

    // Find hidden landlord: another player holding the same id card (3rd copy from 3rd deck)
    this.hiddenLandlord = null;
    for (const name of this.playerNames) {
      if (name === this.landlord) continue;
      for (const card of this.hands[name]) {
        if (card.id === cards[0].id) {
          this.hiddenLandlord = name;
          break;
        }
      }
      if (this.hiddenLandlord) break;
    }

    this.startDoublingIfNeeded();

    return { success: true, hiddenLandlord: this.hiddenLandlord, phase: this.phase };
  }

  sortHand(playerName) {
    this.hands[playerName].sort((a, b) => this.compareCards(a, b));
  }

  compareCards(a, b) {
    if (a.value !== b.value) return a.value - b.value;
    const suitA = Object.prototype.hasOwnProperty.call(SUIT_ORDER, a.suit) ? SUIT_ORDER[a.suit] : 99;
    const suitB = Object.prototype.hasOwnProperty.call(SUIT_ORDER, b.suit) ? SUIT_ORDER[b.suit] : 99;
    if (suitA !== suitB) return suitA - suitB;
    return String(a.uid || a.id).localeCompare(String(b.uid || b.id));
  }

  sortCards(cards) {
    return [...cards].sort((a, b) => this.compareCards(a, b));
  }

  normalizeScoreMultiplier(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 1;
    return Math.max(1, Math.min(1000000, Math.floor(numeric)));
  }

  normalizeBaseScore(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 10;
    return Math.max(1, Math.min(100000, Math.floor(numeric)));
  }

  setScoreMultiplier(value) {
    this.scoreMultiplier = this.normalizeScoreMultiplier(value);
  }

  setBaseScore(value) {
    this.baseScore = this.normalizeBaseScore(value);
  }

  setDoubleEnabled(enabled) {
    this.doubleEnabled = Boolean(enabled);
  }

  _recalculateScoreMultiplier() {
    const doubleCount = Object.values(this.doubleDecisions).filter(Boolean).length;
    const doubleMultiplier = this.doubleEnabled ? (2 ** doubleCount) : 1;
    const openCardMultiplier = 5 ** this.scoringRevealedPlayers.size;
    this.setScoreMultiplier(doubleMultiplier * openCardMultiplier);
  }

  canRevealWithMultiplier() {
    return !this.turnHistory.some(turn => turn.action === 'play');
  }

  startDoublingIfNeeded() {
    if (this.doubleEnabled) {
      this.phase = 'doubling';
      this.doubleDecisions = {};
      return { phase: this.phase };
    }

    this.phase = 'playing';
    this.currentPlayer = this.playerNames.indexOf(this.landlord);
    return { phase: this.phase };
  }

  chooseDouble(playerName, doubled) {
    if (this.phase !== 'doubling') {
      return { success: false, error: '当前不是加倍阶段' };
    }
    if (!this.playerNames.includes(playerName)) {
      return { success: false, error: '玩家不在本局中' };
    }
    if (Object.prototype.hasOwnProperty.call(this.doubleDecisions, playerName)) {
      return { success: false, error: '你已经选择过是否加倍' };
    }

    this.doubleDecisions[playerName] = Boolean(doubled);
    this._recalculateScoreMultiplier();

    if (Object.keys(this.doubleDecisions).length >= this.playerNames.length) {
      this.phase = 'playing';
      this.currentPlayer = this.playerNames.indexOf(this.landlord);
    }

    return {
      success: true,
      phase: this.phase,
      scoreMultiplier: this.scoreMultiplier,
      doubleDecisions: { ...this.doubleDecisions }
    };
  }

  revealHand(playerName) {
    if (!this.hands[playerName]) {
      return { success: false, error: '玩家不在本局中' };
    }
    if (this.revealedPlayers.has(playerName)) {
      return { success: false, error: '你已经明牌了' };
    }
    const multiplierApplied = this.canRevealWithMultiplier();
    this.revealedPlayers.add(playerName);
    if (multiplierApplied) {
      this.scoringRevealedPlayers.add(playerName);
    }
    this._recalculateScoreMultiplier();
    return {
      success: true,
      multiplierApplied,
      scoreMultiplier: this.scoreMultiplier,
      revealedPlayers: Array.from(this.revealedPlayers)
    };
  }

  getAllHandsSnapshot() {
    const allHands = {};
    for (const name of this.playerNames) {
      allHands[name] = this.sortCards(this.hands[name] || []).map(card => ({ uid: card.uid, id: card.id }));
    }
    return allHands;
  }

  getVisibleHandsFor(playerName) {
    const visibleHands = {};
    for (const name of this.playerNames) {
      if (name === playerName) continue;
      if (!this.revealedPlayers.has(name)) continue;
      visibleHands[name] = this.sortCards(this.hands[name] || []).map(card => ({ uid: card.uid, id: card.id }));
    }
    return visibleHands;
  }

  sortHandByUidList(playerName, cardUids) {
    const hand = this.hands[playerName] || [];
    const cards = [];
    for (const uid of cardUids) {
      const card = hand.find(c => c.uid === uid || c.id === uid);
      if (card && !cards.includes(card)) cards.push(card);
    }
    return this.sortCards(cards).map(card => card.uid);
  }

  _getProtectedBombValues(hand) {
    const groups = this._groupByValue(hand);
    const protectedValues = new Set();
    for (const [value, cards] of Object.entries(groups)) {
      if (cards.length >= 5) protectedValues.add(Number(value));
    }
    return protectedValues;
  }

  _isProtectedValue(value, protectedValues) {
    return protectedValues instanceof Set && protectedValues.has(Number(value));
  }

  _getHintCards(cards, count, protectedValues) {
    if (!cards || cards.length < count) return null;
    if (this._isProtectedValue(cards[0].value, protectedValues)) return null;
    return cards.slice(0, count);
  }

  _getSmallestNonProtectedCards(hand, excludedCards, count, protectedValues) {
    const excluded = new Set(excludedCards || []);
    const cards = this.sortCards(hand)
      .filter(card => !excluded.has(card) && !this._isProtectedValue(card.value, protectedValues));
    return cards.length >= count ? cards.slice(0, count) : null;
  }

  _buildBombHintsFromGroups(groups) {
    const hints = [];
    for (const [, cards] of Object.entries(groups)) {
      if (cards.length >= 5) {
        hints.push(this.sortCards(cards).map(c => c.uid));
      } else if (cards.length === 4) {
        hints.push(this.sortCards(cards).map(c => c.uid));
      }
    }
    return hints;
  }

  _sortGroupCards(groupCards) {
    return this.sortCards(groupCards);
  }

  sortCardsInPlayType(cards) {
    return this.sortCards(cards);
  }

  sortCardIds(cardIds) {
    return [...cardIds].sort((a, b) => {
      const cardA = this._cardIdToComparable(a);
      const cardB = this._cardIdToComparable(b);
      return this.compareCards(cardA, cardB);
    });
  }

  _cardIdToComparable(cardId) {
    if (cardId === 'X' || cardId === 'D') {
      return { suit: '', rank: cardId, value: RANK_VALUES[cardId], id: cardId, uid: cardId };
    }
    const suit = cardId[0];
    const rank = cardId.slice(1);
    return { suit, rank, value: RANK_VALUES[rank] || 0, id: cardId, uid: cardId };
  }

  _sortTurnCards(cards) {
    return this.sortCardIds(cards || []);
  }

  _sortTurnHistoryCards(turn) {
    if (!turn || !Array.isArray(turn.cards)) return turn;
    return { ...turn, cards: this._sortTurnCards(turn.cards) };
  }

  _sortAllTurns(turns) {
    return (turns || []).map(turn => this._sortTurnHistoryCards(turn));
  }

  getCurrentPlayer() {
    return this.playerNames[this.currentPlayer];
  }

  canPlayerSeeHiddenLandlord(playerName) {
    return this.landlordRevealed || playerName === this.hiddenLandlord;
  }

  getTeam(playerName) {
    if (playerName === this.landlord || playerName === this.hiddenLandlord) {
      return 'landlord';
    }
    return 'farmer';
  }

  replacePlayerName(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return false;

    const playerIndex = this.playerNames.indexOf(oldName);
    if (playerIndex === -1 || this.playerNames.includes(newName)) {
      return false;
    }

    this.playerNames[playerIndex] = newName;

    if (Object.prototype.hasOwnProperty.call(this.hands, oldName)) {
      this.hands[newName] = this.hands[oldName];
      delete this.hands[oldName];
    } else if (!Object.prototype.hasOwnProperty.call(this.hands, newName)) {
      this.hands[newName] = [];
    }

    if (this.landlord === oldName) this.landlord = newName;
    if (this.hiddenLandlord === oldName) this.hiddenLandlord = newName;
    if (this.lastPlayPlayer === oldName) this.lastPlayPlayer = newName;
    if (this.lastPlay && this.lastPlay.player === oldName) {
      this.lastPlay.player = newName;
    }
    if (this.winner === oldName) this.winner = newName;
    if (this.revealedPlayers.has(oldName)) {
      this.revealedPlayers.delete(oldName);
      this.revealedPlayers.add(newName);
    }
    if (this.scoringRevealedPlayers.has(oldName)) {
      this.scoringRevealedPlayers.delete(oldName);
      this.scoringRevealedPlayers.add(newName);
    }

    if (this.initialHandsSnapshot && Object.prototype.hasOwnProperty.call(this.initialHandsSnapshot, oldName)) {
      this.initialHandsSnapshot[newName] = this.initialHandsSnapshot[oldName];
      delete this.initialHandsSnapshot[oldName];
    }

    return true;
  }

  playCards(playerName, cardIds) {
    if (this.gameOver) return { success: false, error: '游戏已结束' };
    if (this.phase !== 'playing') return { success: false, error: '游戏尚未开始' };
    if (this.getCurrentPlayer() !== playerName) {
      return { success: false, error: '不是你的回合' };
    }

    // Find cards in hand
    const hand = this.hands[playerName];
    const cards = [];
    const cardIdsCopy = [...cardIds];

    for (const uid of cardIdsCopy) {
      // Support both uid and legacy id matching
      const idx = hand.findIndex(c => (c.uid === uid || c.id === uid) && !cards.includes(c));
      if (idx === -1) return { success: false, error: '你没有这些牌' };
      cards.push(hand[idx]);
    }

    // Validate play type
    const playType = this.getPlayType(cards);
    if (!playType) return { success: false, error: '无效的牌型' };
    const sortedCards = this.sortCardsInPlayType(cards);

    // Check if it beats last play
    if (this.lastPlay && this.lastPlayPlayer !== playerName) {
      if (!this.canBeat(playType, sortedCards, this.lastPlay.type, this.lastPlay.cards)) {
        return { success: false, error: '出的牌不够大' };
      }
    }

    // Remove cards from hand
    for (const card of cards) {
      const idx = hand.indexOf(card);
      hand.splice(idx, 1);
    }

    this.lastPlay = { player: playerName, cards: sortedCards, type: playType };
    this.lastPlayPlayer = playerName;
    this.passCount = 0;

    // Check hidden landlord reveal
    if (playerName === this.hiddenLandlord && !this.landlordRevealed) {
      for (const c of sortedCards) {
        if (c.id === this.markedCard.id) {
          this.landlordRevealed = true;
          break;
        }
      }
    }

    this.turnHistory.push({
      player: playerName,
      action: 'play',
      cards: sortedCards.map(c => c.id),
      type: playType.name
    });

    // Check win
    if (hand.length === 0) {
      this.gameOver = true;
      this.winner = playerName;
      const winnerTeam = this.getTeam(playerName);
      return {
        success: true,
        gameOver: true,
        winner: playerName,
        winnerTeam,
        scores: this.calculateScores(winnerTeam)
      };
    }

    // Next player
    this.nextTurn();

    return { success: true, gameOver: false };
  }

  pass(playerName) {
    if (this.gameOver) return { success: false, error: '游戏已结束' };
    if (this.phase !== 'playing') return { success: false, error: '游戏尚未开始' };
    if (this.getCurrentPlayer() !== playerName) {
      return { success: false, error: '不是你的回合' };
    }

    // Can't pass if no last play (you're starting a new round)
    if (!this.lastPlay || this.lastPlayPlayer === playerName) {
      return { success: false, error: '你必须出牌' };
    }

    this.passCount++;
    this.turnHistory.push({
      player: playerName,
      action: 'pass'
    });

    // If all 4 others passed, round resets and last player who played starts a new round
    if (this.passCount >= 4) {
      const roundStarter = this.lastPlayPlayer;
      this.passCount = 0;
      this.lastPlay = null;
      this.lastPlayPlayer = null;
      this.currentPlayer = this.playerNames.indexOf(roundStarter);
      return { success: true, newRound: true };
    }

    this.nextTurn();
    return { success: true, newRound: false };
  }

  nextTurn() {
    this.currentPlayer = (this.currentPlayer + 1) % 5;
    // Skip players with no cards (shouldn't happen normally in 5p but safety)
    let safety = 0;
    while (this.hands[this.playerNames[this.currentPlayer]].length === 0 && safety < 5) {
      this.currentPlayer = (this.currentPlayer + 1) % 5;
      safety++;
    }
  }

  // ============ CARD TYPE DETECTION ============
  getPlayType(cards) {
    const n = cards.length;
    if (n === 0) return null;

    const values = cards.map(c => c.value).sort((a, b) => a - b);
    const ranks = cards.map(c => c.rank);

    // Count by value
    const countMap = {};
    for (const v of values) {
      countMap[v] = (countMap[v] || 0) + 1;
    }
    const counts = Object.entries(countMap).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));

    // Single
    if (n === 1) return { name: 'single', mainValue: values[0], length: 1 };

    // Joker handling for three-deck five-player rules.
    // Same two jokers are normal pairs; only three same jokers are wang bombs.
    const jokerCount = cards.filter(c => c.rank === 'X' || c.rank === 'D').length;
    if (jokerCount === n && n >= 2) {
      const smallJokers = cards.filter(c => c.rank === 'X').length;
      const bigJokers = cards.filter(c => c.rank === 'D').length;

      if (n === 3 && (smallJokers === 3 || bigJokers === 3)) {
        return { name: 'sanwang', mainValue: bigJokers === 3 ? 17 : 16, bombSize: 3, jokerBomb: true, length: 1 };
      }
    }

    // Pair
    if (n === 2 && counts.length === 1 && counts[0][1] === 2) {
      return { name: 'pair', mainValue: values[0], length: 1 };
    }

    // Triple
    if (n === 3 && counts.length === 1 && counts[0][1] === 3) {
      return { name: 'triple', mainValue: values[0], length: 1 };
    }

    // Bomb (4+ same rank)
    if (counts.length === 1 && counts[0][1] >= 4) {
      return { name: 'bomb', mainValue: Number(counts[0][0]), bombSize: counts[0][1], length: 1 };
    }

    // Triple with pair (三带二): 3+2,  must be pair not random 2 cards
    if (n === 5 && counts.length === 2) {
      const tripleVal = Number(counts.find(c => c[1] === 3)?.[0]);
      const pairVal = Number(counts.find(c => c[1] === 2)?.[0]);
      if (tripleVal && tripleVal <= 15 && pairVal) {
        return { name: 'tripleWithPair', mainValue: tripleVal, length: 1 };
      }
    }

    // Four with two singles (四带二单张): 4 same + 2 singles
    if (n === 6) {
      const quad = counts.find(c => c[1] >= 4);
      if (quad) {
        return { name: 'fourWithSingles', mainValue: Number(quad[0]), length: 1 };
      }
    }

    // Straight (顺子): 5+ consecutive singles, no 2 or jokers
    if (n >= 5 && counts.every(c => c[1] === 1)) {
      const vals = values.filter(v => v <= 14); // No 2 or jokers
      if (vals.length === n && this.isConsecutive(vals)) {
        return { name: 'straight', mainValue: Math.max(...vals), length: n };
      }
    }

    // Consecutive pairs (连对): 3+ consecutive pairs
    if (n >= 6 && n % 2 === 0 && counts.every(c => c[1] === 2)) {
      const vals = counts.map(c => Number(c[0])).filter(v => v <= 14).sort((a, b) => a - b);
      if (vals.length === n / 2 && this.isConsecutive(vals)) {
        return { name: 'consecutivePairs', mainValue: Math.max(...vals), length: vals.length };
      }
    }

    const planeType = this._getPlanePlayType(counts, n);
    if (planeType) return planeType;

    // Single triple with pair
    if (n === 5) {
      const triple = counts.find(c => c[1] === 3);
      const pair = counts.find(c => c[1] === 2);
      if (triple && Number(triple[0]) <= 15 && pair) {
        return { name: 'tripleWithPair', mainValue: Number(triple[0]), length: 1 };
      }
    }

    return null;
  }

  _getPlanePlayType(counts, cardCount) {
    const tripleValues = counts
      .filter(([v, c]) => Number(v) >= 3 && Number(v) <= 14 && c >= 3)
      .map(([v]) => Number(v))
      .sort((a, b) => a - b);

    const candidates = [];
    if (cardCount % 3 === 0) {
      candidates.push({ name: 'plane', length: cardCount / 3 });
    }
    if (cardCount % 5 === 0) {
      candidates.push({ name: 'planeWithPairs', length: cardCount / 5 });
    }

    for (const candidate of candidates) {
      if (candidate.length < 2 || candidate.length > tripleValues.length) continue;
      for (let i = 0; i <= tripleValues.length - candidate.length; i++) {
        const run = tripleValues.slice(i, i + candidate.length);
        if (!this.isConsecutive(run)) continue;
        if (this._matchesPlaneCandidate(counts, run, candidate.name)) {
          return { name: candidate.name, mainValue: Math.max(...run), length: candidate.length };
        }
      }
    }

    return null;
  }

  _matchesPlaneCandidate(counts, planeValues, typeName) {
    const planeSet = new Set(planeValues);
    const remainingCounts = [];
    let remainingTotal = 0;

    for (const [val, count] of counts) {
      const value = Number(val);
      const remaining = count - (planeSet.has(value) ? 3 : 0);
      if (remaining < 0) return false;
      if (remaining > 0) {
        remainingCounts.push([value, remaining]);
        remainingTotal += remaining;
      }
    }

    if (typeName === 'plane') {
      return remainingTotal === 0;
    }

    if (typeName === 'planeWithPairs') {
      if (remainingTotal !== planeValues.length * 2) return false;
      const pairValues = remainingCounts.filter(([value, count]) => (
        !planeSet.has(value) && value >= 3 && value <= 15 && count >= 2
      ));
      return pairValues.length >= planeValues.length;
    }

    return false;
  }

  isConsecutive(values) {
    if (values.length < 2) return true;
    const sorted = [...values].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] !== 1) return false;
    }
    return true;
  }

  /**
   * 炸弹排序权重:
   * 三小王: 5个2 < 三小王 < 6个3
   * 三大王: 6个2 < 三大王 < 7个3
   * 使用 bombRank 统一排序
   */
  getBombRank(type) {
    // 12炸
    if (type.name === 'bomb' && type.bombSize === 12) return 1200 + type.mainValue;
    // 11炸
    if (type.name === 'bomb' && type.bombSize === 11) return 1100 + type.mainValue;
    // 10炸
    if (type.name === 'bomb' && type.bombSize === 10) return 1000 + type.mainValue;
    // 9炸
    if (type.name === 'bomb' && type.bombSize === 9) return 900 + type.mainValue;
    // 8炸
    if (type.name === 'bomb' && type.bombSize === 8) return 800 + type.mainValue;
    // 7炸
    if (type.name === 'bomb' && type.bombSize === 7) return 700 + type.mainValue;
    // 三大王
    if (type.name === 'sanwang' && type.mainValue === 17) return 650;
    // 6炸
    if (type.name === 'bomb' && type.bombSize === 6) return 600 + type.mainValue;
    // 三小王
    if (type.name === 'sanwang' && type.mainValue === 16) return 550;
    // 5炸
    if (type.name === 'bomb' && type.bombSize === 5) return 500 + type.mainValue;
    // 4炸
    if (type.name === 'bomb' && type.bombSize === 4) return 100 + type.mainValue;
    return 0;
  }

  canBeat(type1, cards1, type2, cards2) {
    const isBomb1 = !!type1.bombSize;
    const isBomb2 = !!type2.bombSize;

    // Bomb beats everything except bigger bomb
    if (isBomb1 && !isBomb2) return true;
    if (!isBomb1 && isBomb2) return false;

    // Both bombs: use unified bomb ranking
    if (isBomb1 && isBomb2) {
      return this.getBombRank(type1) > this.getBombRank(type2);
    }

    // Same type and length
    if (type1.name !== type2.name) return false;
    if (type1.length !== type2.length) return false;

    return type1.mainValue > type2.mainValue;
  }

  // ============ STATE ============
  getStateForPlayer(playerName) {
    const canSeeHidden = this.canPlayerSeeHiddenLandlord(playerName);
    const state = {
      phase: this.phase,
      myHand: this.sortCards(this.hands[playerName] || []).map(c => ({ uid: c.uid, id: c.id })),
      myName: playerName,
      currentPlayer: this.getCurrentPlayer(),
      isMyTurn: this.getCurrentPlayer() === playerName,
      lastPlay: this.lastPlay ? {
        player: this.lastPlay.player,
        cards: this.lastPlay.cards.map(c => c.id),
        type: this.lastPlay.type.name
      } : null,
      lastPlayPlayer: this.lastPlayPlayer,
      mustPlay: !this.lastPlay || this.lastPlayPlayer === playerName,
      landlord: this.landlord,
      hiddenLandlord: canSeeHidden ? this.hiddenLandlord : null,
      landlordLabel: '大地主',
      hiddenLandlordLabel: '小地主',
      markedCard: this.markedCard?.id,
      players: this.playerNames.map((name, i) => {
        return {
          name,
          cardCount: this.hands[name]?.length || 0,
          isLandlord: name === this.landlord,
          isHiddenLandlord: canSeeHidden ? name === this.hiddenLandlord : null,
          team: name === this.landlord
            ? 'landlord'
            : (canSeeHidden ? (name === this.hiddenLandlord ? 'landlord' : 'farmer') : 'unknown')
        };
      }),
      myTeam: this.getTeam(playerName),
      gameOver: this.gameOver,
      winner: this.winner,
      turnHistory: this._sortAllTurns(this.turnHistory.slice(-10)), // Last 10 turns
      passCount: this.passCount,
      cardCounter: this.getCardCounter(),
      baseScore: this.baseScore,
      doubleEnabled: this.doubleEnabled,
      doubleDecisions: { ...this.doubleDecisions },
      scoreMultiplier: this.scoreMultiplier,
      revealedPlayers: Array.from(this.revealedPlayers),
      scoringRevealedPlayers: Array.from(this.scoringRevealedPlayers),
      revealMultiplierAvailable: this.canRevealWithMultiplier(),
      visibleHands: this.getVisibleHandsFor(playerName)
    };

    // Landlord can see hidden landlord's hand if revealed
    if (this.landlordRevealed && (playerName === this.landlord || playerName === this.hiddenLandlord)) {
      const partner = playerName === this.landlord ? this.hiddenLandlord : this.landlord;
      if (partner) {
        state.partnerHand = this.sortCards(this.hands[partner] || []).map(c => c.id);
      }
    }

    // During selectingMarked phase, landlord gets available options
    if (this.phase === 'selectingMarked' && playerName === this.landlord) {
      state.markedCardOptions = this.getMarkedCardOptions();
    }

    return state;
  }

  // ============ SPECTATOR STATE ============
  getStateForSpectator() {
    const allHands = this.getAllHandsSnapshot();

    return {
      phase: this.phase,
      isSpectator: true,
      allHands,
      currentPlayer: this.getCurrentPlayer(),
      lastPlay: this.lastPlay ? {
        player: this.lastPlay.player,
        cards: this.lastPlay.cards.map(c => c.id),
        type: this.lastPlay.type.name
      } : null,
      lastPlayPlayer: this.lastPlayPlayer,
      landlord: this.landlord,
      hiddenLandlord: this.hiddenLandlord, // spectators can see hidden landlord
      landlordLabel: '大地主',
      hiddenLandlordLabel: '小地主',
      markedCard: this.markedCard?.id,
      players: this.playerNames.map((name) => ({
        name,
        cardCount: this.hands[name]?.length || 0,
        isLandlord: name === this.landlord,
        isHiddenLandlord: name === this.hiddenLandlord,
        team: (name === this.landlord || name === this.hiddenLandlord) ? 'landlord' : 'farmer'
      })),
      gameOver: this.gameOver,
      winner: this.winner,
      turnHistory: this._sortAllTurns(this.turnHistory), // Full history for spectators
      passCount: this.passCount,
      baseScore: this.baseScore,
      doubleEnabled: this.doubleEnabled,
      doubleDecisions: { ...this.doubleDecisions },
      scoreMultiplier: this.scoreMultiplier,
      revealedPlayers: Array.from(this.revealedPlayers),
      scoringRevealedPlayers: Array.from(this.scoringRevealedPlayers),
      revealMultiplierAvailable: this.canRevealWithMultiplier()
    };
  }

  // ============ CARD COUNTER ============
  getCardCounter() {
    // Count all played cards from turn history
    const played = {};
    for (const turn of this.turnHistory) {
      if (turn.action === 'play' && turn.cards) {
        for (const cardId of turn.cards) {
          played[cardId] = (played[cardId] || 0) + 1;
        }
      }
    }

    // Total cards in 3 decks
    const total = {};
    for (const rank of RANKS) {
      for (const suit of SUITS) {
        const id = suit + rank;
        total[id] = 3; // 3 decks
      }
    }
    total['X'] = 3; // 3 小王
    total['D'] = 3; // 3 大王

    // Remaining per rank (aggregate)
    const remaining = {};
    for (const rank of [...RANKS, 'X', 'D']) {
      const rankName = rank === 'X' ? '小王' : rank === 'D' ? '大王' : rank;
      let totalCount, playedCount = 0;
      if (rank === 'X' || rank === 'D') {
        totalCount = 3;
        playedCount = played[rank] || 0;
      } else {
        totalCount = 12; // 4 suits × 3 decks
        for (const suit of SUITS) {
          playedCount += played[suit + rank] || 0;
        }
      }
      remaining[rankName] = { total: totalCount, played: playedCount, left: totalCount - playedCount };
    }

    return remaining;
  }

  // ============ HINT SYSTEM ============
  getHints(playerName, options = {}) {
    const hand = this.hands[playerName];
    if (!hand || hand.length === 0) return [];

    const hints = [];
    const mustBeat = this.lastPlay && this.lastPlayPlayer !== playerName;
    const protectedValues = this._getProtectedBombValues(hand);

    if (!mustBeat) {
      // Free play - suggest all valid combinations
      // Singles
      const seen = new Set();
      for (const c of hand) {
        if (this._isProtectedValue(c.value, protectedValues)) continue;
        if (!seen.has(c.value)) {
          seen.add(c.value);
          hints.push([c.uid]);
        }
      }
      // Pairs
      const groups = this._groupByValue(hand);
      for (const [val, cards] of Object.entries(groups)) {
        const pair = this._getHintCards(this._sortGroupCards(cards), 2, protectedValues);
        if (pair) hints.push(pair.map(c => c.uid));
      }
      // Triples
      for (const [val, cards] of Object.entries(groups)) {
        const triple = this._getHintCards(this._sortGroupCards(cards), 3, protectedValues);
        if (triple) hints.push(triple.map(c => c.uid));
      }
      hints.push(...this._findPlaneCombos(hand, null, protectedValues));
      // Bombs
      hints.push(...this._buildBombHintsFromGroups(groups));
      return this._rankHints(playerName, this._dedupeHints(hints), options);
    }

    // Must beat last play
    const lastType = this.lastPlay.type;
    const lastCards = this.lastPlay.cards;

    // Try same type combos that beat
    const combos = this._findBeatingCombos(hand, lastType, lastCards, protectedValues);
    hints.push(...combos);

    // Also try any bombs that beat
    const bombs = this._findAllBombs(hand);
    for (const bombCards of bombs) {
      const bombType = this.getPlayType(bombCards);
      if (bombType && (!lastType.bombSize || this.getBombRank(bombType) > this.getBombRank(lastType))) {
        hints.push(bombCards.map(c => c.uid));
      }
    }

    return this._rankHints(playerName, this._dedupeHints(hints), options);
  }

  _dedupeHints(hints) {
    const unique = [];
    const seen2 = new Set();
    for (const h of hints) {
      const key = [...h].sort().join(',');
      if (!seen2.has(key)) {
        seen2.add(key);
        unique.push(h);
      }
    }
    return unique;
  }

  _rankHints(playerName, hints, options = {}) {
    if (!Array.isArray(hints) || hints.length <= 1) return hints;

    const hand = this.hands[playerName] || [];
    const uidMap = new Map(hand.map(card => [card.uid, card]));
    const mustBeat = this.lastPlay && this.lastPlayPlayer !== playerName;
    const lastType = this.lastPlay?.type || null;
    const enemyCritical = this._hasCriticalOpponent(playerName);
    const difficulty = ['easy', 'normal', 'hard'].includes(options.difficulty) ? options.difficulty : 'normal';

    return hints
      .map((hint, index) => {
        const cards = hint.map(uid => uidMap.get(uid)).filter(Boolean);
        const type = this.getPlayType(cards);
        return {
          hint,
          index,
          score: type ? this._scoreHint(cards, type, {
            handCount: hand.length,
            mustBeat,
            lastType,
            enemyCritical,
            difficulty
          }) : -Infinity
        };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(item => item.hint);
  }

  _scoreHint(cards, type, context) {
    const remaining = context.handCount - cards.length;
    if (remaining === 0) return 100000;

    let score = 0;
    const mainValue = type.mainValue || Math.max(...cards.map(card => card.value));
    const isBomb = !!type.bombSize;

    if (!context.mustBeat) {
      score += cards.length * 42;
      score -= mainValue * 2;
      if (['straight', 'consecutivePairs', 'plane', 'planeWithPairs'].includes(type.name)) {
        score += 140;
      }
      if (type.name === 'single' && context.handCount > 3) score -= 90;
      if (isBomb && context.handCount > 6) score -= 420;
    } else {
      score += 900;
      score -= mainValue * 4;
      score -= cards.length;
      if (isBomb) score -= context.enemyCritical ? 80 : 520;
    }

    if (context.enemyCritical) {
      score += 220;
      if (isBomb) score += 160;
      if (mainValue >= 15) score += 60;
    }

    if (context.difficulty === 'easy') {
      score -= cards.length * 10;
      if (isBomb) score -= 200;
    }

    return score;
  }

  _hasCriticalOpponent(playerName) {
    const myTeam = this.getTeam(playerName);
    return this.playerNames.some(name => {
      if (name === playerName) return false;
      if (this.getTeam(name) === myTeam) return false;
      return (this.hands[name]?.length || 0) <= 3;
    });
  }

  _groupByValue(hand) {
    const groups = {};
    for (const c of hand) {
      if (!groups[c.value]) groups[c.value] = [];
      groups[c.value].push(c);
    }
    return groups;
  }

  _findBeatingCombos(hand, lastType, lastCards, protectedValues = this._getProtectedBombValues(hand)) {
    const results = [];
    const groups = this._groupByValue(hand);

    if (lastType.name === 'single') {
      for (const c of hand) {
        if (this._isProtectedValue(c.value, protectedValues)) continue;
        if (c.value > lastType.mainValue) results.push([c.uid]);
      }
    } else if (lastType.name === 'pair') {
      for (const [val, cards] of Object.entries(groups)) {
        if (this._isProtectedValue(val, protectedValues)) continue;
        if (cards.length >= 2 && Number(val) > lastType.mainValue) {
          results.push(this._sortGroupCards(cards).slice(0, 2).map(c => c.uid));
        }
      }
    } else if (lastType.name === 'triple') {
      for (const [val, cards] of Object.entries(groups)) {
        if (this._isProtectedValue(val, protectedValues)) continue;
        if (cards.length >= 3 && Number(val) > lastType.mainValue) {
          results.push(this._sortGroupCards(cards).slice(0, 3).map(c => c.uid));
        }
      }
    } else if (lastType.name === 'tripleWithPair') {
      for (const [val, cards] of Object.entries(groups)) {
        if (this._isProtectedValue(val, protectedValues)) continue;
        if (cards.length >= 3 && Number(val) > lastType.mainValue) {
          const triple = this._sortGroupCards(cards).slice(0, 3);
          // Find a pair from remaining
          for (const [v2, c2] of Object.entries(groups)) {
            if (this._isProtectedValue(v2, protectedValues)) continue;
            if (v2 !== val && c2.length >= 2) {
              const pair = this._sortGroupCards(c2).slice(0, 2);
              results.push([...triple.map(c => c.uid), pair[0].uid, pair[1].uid]);
              break;
            }
          }
        }
      }
    } else if (lastType.name === 'straight') {
      const sorted = Object.entries(groups)
        .filter(([v]) => Number(v) <= 14 && Number(v) >= 3 && !this._isProtectedValue(v, protectedValues))
        .sort((a, b) => Number(a[0]) - Number(b[0]));
      const len = lastType.length;
      for (let i = 0; i <= sorted.length - len; i++) {
        const run = sorted.slice(i, i + len);
        const vals = run.map(([v]) => Number(v));
        if (this.isConsecutive(vals) && Math.max(...vals) > lastType.mainValue) {
          results.push(run.map(([, cards]) => this._sortGroupCards(cards)[0].uid));
        }
      }
    } else if (lastType.name === 'consecutivePairs') {
      const sorted = Object.entries(groups)
        .filter(([v, cards]) => Number(v) <= 14 && Number(v) >= 3 && cards.length >= 2 && !this._isProtectedValue(v, protectedValues))
        .sort((a, b) => Number(a[0]) - Number(b[0]));
      const pairLen = lastType.length;
      for (let i = 0; i <= sorted.length - pairLen; i++) {
        const run = sorted.slice(i, i + pairLen);
        const vals = run.map(([v]) => Number(v));
        if (this.isConsecutive(vals) && Math.max(...vals) > lastType.mainValue) {
          const uids = [];
          for (const [, cards] of run) {
            const pair = this._sortGroupCards(cards).slice(0, 2);
            uids.push(pair[0].uid, pair[1].uid);
          }
          results.push(uids);
        }
      }
    } else if (lastType.name === 'fourWithSingles') {
      for (const [val, cards] of Object.entries(groups)) {
        if (this._isProtectedValue(val, protectedValues)) continue;
        if (cards.length >= 4 && Number(val) > lastType.mainValue) {
          const quad = this._sortGroupCards(cards).slice(0, 4);
          const rest = this._getSmallestNonProtectedCards(hand, quad, 2, protectedValues);
          if (rest) {
            results.push([...quad.map(c => c.uid), rest[0].uid, rest[1].uid]);
          }
        }
      }
    } else if (['plane', 'planeWithPairs'].includes(lastType.name)) {
      results.push(...this._findPlaneCombos(hand, lastType, protectedValues));
    }

    return results;
  }

  _findPlaneCombos(hand, targetType = null, protectedValues = this._getProtectedBombValues(hand)) {
    const results = [];
    const groups = this._groupByValue(hand);
    const tripleGroups = Object.entries(groups)
      .filter(([v, cards]) => Number(v) >= 3 && Number(v) <= 14 && cards.length >= 3 && !this._isProtectedValue(v, protectedValues))
      .sort((a, b) => Number(a[0]) - Number(b[0]));

    const minLen = targetType?.length || 2;
    const maxLen = targetType?.length || tripleGroups.length;
    const modes = targetType
      ? [targetType.name]
      : ['plane', 'planeWithPairs'];

    for (let len = minLen; len <= maxLen; len++) {
      for (let i = 0; i <= tripleGroups.length - len; i++) {
        const run = tripleGroups.slice(i, i + len);
        const vals = run.map(([v]) => Number(v));
        if (!this.isConsecutive(vals)) continue;

        const mainValue = Math.max(...vals);
        if (targetType && mainValue <= targetType.mainValue) continue;

        const triples = [];
        for (const [, cards] of run) {
          triples.push(...this._sortGroupCards(cards).slice(0, 3));
        }
        const tripleSet = new Set(triples);
        const remaining = hand.filter(card => !tripleSet.has(card));

        for (const mode of modes) {
          let combo = null;
          if (mode === 'plane') {
            combo = triples;
          } else if (mode === 'planeWithPairs') {
            const pairs = this._findWingPairs(remaining, vals, len, protectedValues);
            if (pairs) combo = [...triples, ...pairs];
          }

          if (!combo) continue;
          const playType = this.getPlayType(combo);
          if (!playType || playType.name !== mode || playType.length !== len) continue;
          results.push(combo.map(card => card.uid));
        }
      }
    }

    return results;
  }

  _findWingPairs(cards, excludedValues, pairCount, protectedValues = new Set()) {
    const groups = this._groupByValue(cards);
    const pairs = [];
    for (const [val, groupCards] of Object.entries(groups).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const value = Number(val);
      if (excludedValues.includes(value) || value < 3 || value > 15) continue;
      if (this._isProtectedValue(value, protectedValues)) continue;
      if (groupCards.length >= 2) {
        pairs.push(...this._sortGroupCards(groupCards).slice(0, 2));
        if (pairs.length === pairCount * 2) return pairs;
      }
    }
    return null;
  }

  _findAllBombs(hand) {
    const results = [];
    const groups = this._groupByValue(hand);

    // 提示不拆 5 炸及以上；合法性仍允许玩家手动选择拆牌。
    for (const [val, cards] of Object.entries(groups)) {
      const sorted = this._sortGroupCards(cards);
      if (cards.length >= 5) {
        results.push(sorted);
      } else if (cards.length === 4) {
        results.push(sorted);
      }
    }

    // Joker bombs
    const smallJokers = hand.filter(c => c.rank === 'X');
    const bigJokers = hand.filter(c => c.rank === 'D');
    // 三张同王是王炸；其它王组合不算王炸。
    if (smallJokers.length >= 3) {
      results.push(smallJokers.slice(0, 3));
    }
    if (bigJokers.length >= 3) {
      results.push(bigJokers.slice(0, 3));
    }

    return results;
  }

  calculateScores(winnerTeam) {
    const scores = {};
    const winners = this.playerNames.filter(name => this.getTeam(name) === winnerTeam);
    const losers = this.playerNames.filter(name => this.getTeam(name) !== winnerTeam);
    const baseScore = this.baseScore * this.scoreMultiplier;

    for (const name of this.playerNames) {
      const team = this.getTeam(name);
      scores[name] = team === winnerTeam
        ? losers.length * baseScore
        : -winners.length * baseScore;
    }
    return scores;
  }
}

module.exports = { GameEngine, Card, RANK_VALUES };
