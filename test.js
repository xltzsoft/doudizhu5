/**
 * 五人斗地主 - 自动化测试
 * 测试游戏引擎、牌型识别、对比逻辑
 */

const { GameEngine, Card, RANK_VALUES } = require('./game/engine');

// Helper: deal and auto-select marked cards to enter playing phase
function dealAndStart(engine) {
  engine.deal();
  if (engine.phase === 'selectingMarked') {
    const options = engine.getMarkedCardOptions();
    if (options.length > 0) {
      const hand = engine.hands[engine.landlord];
      const matching = hand.filter(c => c.id === options[0].id);
      engine.selectMarkedCards([matching[0].uid, matching[1].uid]);
    }
  }
}

function createHiddenLandlordScenario() {
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  const markedCard1 = new Card('♠', '9');
  const markedCard2 = new Card('♠', '9');
  const hiddenMarkedCard = new Card('♠', '9');

  engine.hands = {
    A: [markedCard1, markedCard2, new Card('♥', '3')],
    B: [hiddenMarkedCard, new Card('♣', '4')],
    C: [new Card('♣', '5'), new Card('♦', '5')],
    D: [new Card('♣', '6'), new Card('♦', '6')],
    E: [new Card('♣', '7'), new Card('♦', '7')]
  };
  engine.landlord = 'A';
  engine.hiddenLandlord = 'B';
  engine.landlordRevealed = false;
  engine.currentPlayer = engine.playerNames.indexOf('A');
  engine.lastPlay = null;
  engine.lastPlayPlayer = null;
  engine.passCount = 0;
  engine.turnHistory = [];
  engine.gameOver = false;
  engine.winner = null;
  engine.markedCard = markedCard1;
  engine.bottomCards = [];
  engine.landlordCards = [];
  engine.phase = 'playing';
  engine.selectedMarkedCards = [markedCard1, markedCard2];

  return { engine, hiddenMarkedCard };
}

let testsPassed = 0;
let testsFailed = 0;
const failures = [];

function assert(condition, testName) {
  if (condition) {
    testsPassed++;
    console.log(`  ✓ ${testName}`);
  } else {
    testsFailed++;
    failures.push(testName);
    console.log(`  ✗ ${testName}`);
  }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

// ============ TEST 1: Deck Creation ============
section('牌组创建');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  const deck = engine.createDeck();
  assert(deck.length === 162, '三副牌共162张');
  
  const jokers = deck.filter(c => c.rank === 'X' || c.rank === 'D');
  assert(jokers.length === 6, '6张王牌(3大3小)');
  
  const hearts = deck.filter(c => c.suit === '♥');
  assert(hearts.length === 39, '红心39张');
}

// ============ TEST 2: Deal ============
section('发牌');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  engine.deal();
  
  const totalCards = Object.values(engine.hands).reduce((sum, h) => sum + h.length, 0);
  // Landlord gets 38 (31+7), others get 31 each = 38 + 31*4 = 162
  assert(totalCards === 162, '所有牌都分发完毕(162张)');
  
  const landlordHand = engine.hands[engine.landlord];
  assert(landlordHand.length === 38, '地主有38张牌(31+7底牌)');

  assert(engine.initialHandsSnapshot !== null, '保存开局手牌快照');
  assert(Object.keys(engine.initialHandsSnapshot).length === 5, '开局手牌快照包含5位玩家');
  assert(engine.initialHandsSnapshot[engine.landlord].length === 38, '地主开局快照为38张');
  
  for (const name of engine.playerNames) {
    if (name !== engine.landlord) {
      assert(engine.hands[name].length === 31, `${name}有31张牌`);
      assert(engine.initialHandsSnapshot[name].length === 31, `${name}开局快照为31张`);
    }
  }
  
  assert(engine.landlord !== null, '地主已确定');
  assert(engine.markedCard !== null, '明牌已选定');
  assert(engine.markedCard.rank !== 'X' && engine.markedCard.rank !== 'D', '明牌不是王');
}

// ============ TEST 3: Card Type Detection ============
section('牌型识别');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);

  // Single
  const single = engine.getPlayType([new Card('♠', '3')]);
  assert(single && single.name === 'single', '单牌识别');

  // Pair
  const pair = engine.getPlayType([new Card('♠', '3'), new Card('♥', '3')]);
  assert(pair && pair.name === 'pair', '对子识别');

  // Triple
  const triple = engine.getPlayType([new Card('♠', '3'), new Card('♥', '3'), new Card('♣', '3')]);
  assert(triple && triple.name === 'triple', '三张识别');

  // Bomb (4 same)
  const bomb4 = engine.getPlayType([
    new Card('♠', '5'), new Card('♥', '5'), new Card('♣', '5'), new Card('♦', '5')
  ]);
  assert(bomb4 && bomb4.name === 'bomb' && bomb4.bombSize === 4, '四炸识别');

  // Bomb (5 same - two decks)
  const bomb5 = engine.getPlayType([
    new Card('♠', '5'), new Card('♥', '5'), new Card('♣', '5'), new Card('♦', '5'), new Card('♠', '5')
  ]);
  assert(bomb5 && bomb5.name === 'bomb' && bomb5.bombSize === 5, '五炸识别');

  // Triple with pair
  const tripleWithPair = engine.getPlayType([
    new Card('♠', '5'), new Card('♥', '5'), new Card('♣', '5'),
    new Card('♠', '7'), new Card('♥', '7')
  ]);
  assert(tripleWithPair && tripleWithPair.name === 'tripleWithPair', '三带二识别');

  // Straight (5 cards)
  const straight5 = engine.getPlayType([
    new Card('♠', '3'), new Card('♥', '4'), new Card('♣', '5'), new Card('♦', '6'), new Card('♠', '7')
  ]);
  assert(straight5 && straight5.name === 'straight' && straight5.length === 5, '五张顺子识别');

  // Consecutive pairs
  const conPairs = engine.getPlayType([
    new Card('♠', '5'), new Card('♥', '5'),
    new Card('♠', '6'), new Card('♥', '6'),
    new Card('♠', '7'), new Card('♥', '7')
  ]);
  assert(conPairs && conPairs.name === 'consecutivePairs', '连对识别');

  const plane = engine.getPlayType([
    new Card('♠', '5'), new Card('♥', '5'), new Card('♣', '5'),
    new Card('♠', '6'), new Card('♥', '6'), new Card('♣', '6')
  ]);
  assert(plane && plane.name === 'plane' && plane.length === 2, '飞机不带牌识别');

  const planeWithSingles = engine.getPlayType([
    new Card('♠', '5'), new Card('♥', '5'), new Card('♣', '5'),
    new Card('♠', '6'), new Card('♥', '6'), new Card('♣', '6'),
    new Card('♠', '7'), new Card('♠', 'A')
  ]);
  assert(!planeWithSingles, '飞机不能带单张');

  const planeWithPairs = engine.getPlayType([
    new Card('♠', '5'), new Card('♥', '5'), new Card('♣', '5'),
    new Card('♠', '6'), new Card('♥', '6'), new Card('♣', '6'),
    new Card('♠', '7'), new Card('♥', '7'),
    new Card('♠', 'A'), new Card('♥', 'A')
  ]);
  assert(planeWithPairs && planeWithPairs.name === 'planeWithPairs', '飞机带不连续对子识别');

  const planeWithTwos = engine.getPlayType([
    new Card('♠', 'Q'), new Card('♥', 'Q'), new Card('♣', 'Q'),
    new Card('♠', 'K'), new Card('♥', 'K'), new Card('♣', 'K'),
    new Card('♠', 'A'), new Card('♥', 'A'),
    new Card('♠', '2'), new Card('♥', '2')
  ]);
  assert(planeWithTwos && planeWithTwos.name === 'planeWithPairs' && planeWithTwos.mainValue === 13, 'QQQKKKAA22飞机带2对子识别');

  const invalidPlanePairs = engine.getPlayType([
    new Card('♠', '5'), new Card('♥', '5'), new Card('♣', '5'), new Card('♦', '5'), new Card('♠', '5'),
    new Card('♠', '6'), new Card('♥', '6'), new Card('♣', '6'),
    new Card('♠', '7'), new Card('♥', '7')
  ]);
  assert(!invalidPlanePairs, '飞机带对不能用飞机本体点数作翅膀');

  const planeWithTwosLow = engine.getPlayType([
    new Card('♠', '5'), new Card('♥', '5'), new Card('♣', '5'),
    new Card('♠', '6'), new Card('♥', '6'), new Card('♣', '6'),
    new Card('♠', '2'), new Card('♥', '2'),
    new Card('♠', 'A'), new Card('♥', 'A')
  ]);
  assert(planeWithTwosLow && planeWithTwosLow.name === 'planeWithPairs', '飞机带对可以带2');

  // Same jokers are pairs in three-deck five-player rules
  const doubleKing = engine.getPlayType([new Card('', 'X'), new Card('', 'X')]);
  assert(doubleKing && doubleKing.name === 'pair', '双小王对子识别');

  const doubleBigKing = engine.getPlayType([new Card('', 'D'), new Card('', 'D')]);
  assert(doubleBigKing && doubleBigKing.name === 'pair', '双大王对子识别');

  // Triple same king
  const tripleKing = engine.getPlayType([new Card('', 'X'), new Card('', 'X'), new Card('', 'X')]);
  assert(tripleKing && tripleKing.name === 'sanwang', '三同王炸识别');

  const mixedTripleKing = engine.getPlayType([new Card('', 'X'), new Card('', 'D'), new Card('', 'X')]);
  assert(!mixedTripleKing, '三张混王不是有效王炸');

  const jokerTripleWithPair = engine.getPlayType([
    new Card('', 'X'), new Card('', 'X'), new Card('', 'X'),
    new Card('♠', '7'), new Card('♥', '7')
  ]);
  assert(!jokerTripleWithPair, '三张王不能作为普通三带二');

  // Other joker mixes are not wang bombs
  const quadKing = engine.getPlayType([
    new Card('', 'X'), new Card('', 'X'), new Card('', 'D'), new Card('', 'D')
  ]);
  assert(!quadKing, '四王不算王炸');

  // Mixed big+small joker is not a pair or bomb in this variant
  const rocket = engine.getPlayType([new Card('', 'X'), new Card('', 'D')]);
  assert(!rocket, '一大一小王不能作为火箭出');

  // Invalid: 2 in straight
  const invalidStraight = engine.getPlayType([
    new Card('♠', '10'), new Card('♥', 'J'), new Card('♣', 'Q'), new Card('♦', 'K'), new Card('♠', '2')
  ]);
  assert(!invalidStraight || invalidStraight.name !== 'straight', '2不能在顺子中');

  // 四带两对不是支持的牌型
  const fourWithPairs = engine.getPlayType([
    new Card('♠', '4'), new Card('♥', '4'), new Card('♣', '4'), new Card('♦', '4'),
    new Card('♠', '2'), new Card('♥', '2'),
    new Card('♠', '3'), new Card('♥', '3')
  ]);
  assert(!fourWithPairs, '四带两对(4444+2233)不是合法牌型');

  const fourWithPairsFromQuads = engine.getPlayType([
    new Card('♠', '7'), new Card('♥', '7'), new Card('♣', '7'), new Card('♦', '7'),
    new Card('♠', '8'), new Card('♥', '8'), new Card('♣', '8'), new Card('♦', '8')
  ]);
  assert(!fourWithPairsFromQuads, '两个四张(7777+8888)也不是合法牌型');

  // 四带二单张仍然合法
  const fourWithSingles = engine.getPlayType([
    new Card('♠', '4'), new Card('♥', '4'), new Card('♣', '4'), new Card('♦', '4'),
    new Card('♠', '2'), new Card('♠', '3')
  ]);
  assert(fourWithSingles && fourWithSingles.name === 'fourWithSingles', '四带二单张仍然合法');

  // 飞机翅膀不能拆四张当两对
  const planeWithQuadWings = engine.getPlayType([
    new Card('♠', '3'), new Card('♥', '3'), new Card('♣', '3'),
    new Card('♠', '4'), new Card('♥', '4'), new Card('♣', '4'),
    new Card('♠', '5'), new Card('♥', '5'), new Card('♣', '5'), new Card('♦', '5')
  ]);
  assert(!planeWithQuadWings, '飞机翅膀不能用四张拆两对(333444+5555)');
}

// ============ TEST 4: Card Comparison ============
section('牌型比较');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);

  // Single vs single
  const s1 = { name: 'single', mainValue: 5, length: 1 };
  const s2 = { name: 'single', mainValue: 3, length: 1 };
  assert(engine.canBeat(s1, [], s2, []), '单牌5>3');

  // Bomb beats single
  const bomb = { name: 'bomb', mainValue: 5, bombSize: 4, length: 1 };
  assert(engine.canBeat(bomb, [], s1, []), '炸弹>单牌');

  // Bigger bomb beats smaller bomb
  const bomb5 = { name: 'bomb', mainValue: 5, bombSize: 5, length: 1 };
  const bomb4 = { name: 'bomb', mainValue: 10, bombSize: 4, length: 1 };
  assert(engine.canBeat(bomb5, [], bomb4, []), '五炸>四炸');

  // Same size bomb, bigger value wins
  const bombA = { name: 'bomb', mainValue: 14, bombSize: 4, length: 1 };
  const bombK = { name: 'bomb', mainValue: 13, bombSize: 4, length: 1 };
  assert(engine.canBeat(bombA, [], bombK, []), 'AAAA>KKKK');

  // Wang bombs have explicit slots in the bomb hierarchy
  const smallWang = { name: 'sanwang', mainValue: 16, bombSize: 3, jokerBomb: true };
  assert(engine.canBeat(smallWang, [], bomb5, []), '三小王>五炸');
  assert(engine.canBeat({ name: 'bomb', mainValue: 3, bombSize: 6, length: 1 }, [], smallWang, []), '六个3>三小王');

  // Can't beat different type
  const pair = { name: 'pair', mainValue: 5, length: 1 };
  assert(!engine.canBeat(pair, [], s1, []), '对子不能打单牌');
}

// ============ TEST 5: Game Flow ============
section('游戏流程');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  dealAndStart(engine);

  const firstPlayer = engine.getCurrentPlayer();
  assert(firstPlayer === engine.landlord, '地主先出牌');

  // Get first player's hand
  const handLength = engine.hands[firstPlayer].length;
  assert(handLength > 0, '手牌非空');

  // Play a single card
  const card = engine.hands[firstPlayer][0];
  const result = engine.playCards(firstPlayer, [card.id]);
  assert(result.success, '出牌成功');
  assert(engine.hands[firstPlayer].length === handLength - 1, '手牌减少1张');

  // Wrong player can't play
  const wrongResult = engine.playCards(firstPlayer, []);
  assert(!wrongResult.success, '非当前玩家不能出牌');

  // Current player can pass if there's a last play
  const nextPlayer = engine.getCurrentPlayer();
  assert(nextPlayer !== firstPlayer, '轮转到下一个玩家');
}

// ============ TEST 6: Pass Logic ============
section('过牌逻辑');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  dealAndStart(engine);

  const firstPlayer = engine.getCurrentPlayer();
  const hand = engine.hands[firstPlayer];

  // First player must play, can't pass
  const passResult = engine.pass(firstPlayer);
  assert(!passResult.success, '新一轮第一手不能过牌');

  // Play a card first
  engine.playCards(firstPlayer, [hand[0].id]);

  // Next player can pass
  const nextPlayer = engine.getCurrentPlayer();
  const passResult2 = engine.pass(nextPlayer);
  assert(passResult2.success, '有上家出牌后可以过牌');
}

// ============ TEST 7: Team Assignment ============
section('阵营分配');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  dealAndStart(engine);

  const landlordTeam = engine.playerNames.filter(n => engine.getTeam(n) === 'landlord');
  const farmerTeam = engine.playerNames.filter(n => engine.getTeam(n) === 'farmer');

  assert(landlordTeam.length <= 2, '地主方最多2人');
  assert(farmerTeam.length >= 3, '农民方至少3人');
  assert(landlordTeam.length + farmerTeam.length === 5, '总共5人');
}

// ============ TEST 7.5: Score Balance ============
section('结算分数');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  dealAndStart(engine);

  const landlordTeam = engine.playerNames.filter(n => engine.getTeam(n) === 'landlord');
  const farmerTeam = engine.playerNames.filter(n => engine.getTeam(n) === 'farmer');

  const landlordScores = engine.calculateScores('landlord');
  const farmerScores = engine.calculateScores('farmer');

  const landlordTotal = Object.values(landlordScores).reduce((sum, score) => sum + score, 0);
  const farmerTotal = Object.values(farmerScores).reduce((sum, score) => sum + score, 0);

  assert(landlordTotal === 0, '地主获胜时总分守恒');
  assert(farmerTotal === 0, '农民获胜时总分守恒');

  landlordTeam.forEach(name => {
    assert(landlordScores[name] === farmerTeam.length * 10, `${name}地主获胜得分按农民人数计算`);
    assert(farmerScores[name] === -farmerTeam.length * 10, `${name}农民获胜时扣分按获胜农民人数计算`);
  });

  farmerTeam.forEach(name => {
    assert(landlordScores[name] === -landlordTeam.length * 10, `${name}地主获胜时扣分按地主人数计算`);
    assert(farmerScores[name] === landlordTeam.length * 10, `${name}农民获胜得分按地主人数计算`);
  });

  engine.setScoreMultiplier(4);
  const doubledScores = engine.calculateScores('landlord');
  landlordTeam.forEach(name => {
    assert(doubledScores[name] === farmerTeam.length * 40, `${name}动态倍数4倍后结算`);
  });

  engine.setBaseScore(20);
  const baseScoreResult = engine.calculateScores('landlord');
  landlordTeam.forEach(name => {
    assert(baseScoreResult[name] === farmerTeam.length * 80, `${name}按房主指定一倍分结算`);
  });
}

// ============ TEST 7.6: Double and Reveal Multipliers ============
section('加倍与明牌倍数');
{
  const doubleEngine = new GameEngine(['A', 'B', 'C', 'D', 'E'], { baseScore: 10, doubleEnabled: true });
  dealAndStart(doubleEngine);
  assert(doubleEngine.phase === 'doubling', '开启加倍后进入加倍选择阶段');
  assert(doubleEngine.chooseDouble('A', true).success, '玩家A可以选择加倍');
  assert(doubleEngine.scoreMultiplier === 2, '1名玩家加倍后倍数为2');
  assert(doubleEngine.chooseDouble('B', false).success, '玩家B可以选择不加倍');
  assert(doubleEngine.scoreMultiplier === 2, '不加倍不改变倍数');
  assert(doubleEngine.chooseDouble('C', true).success, '玩家C可以选择加倍');
  assert(doubleEngine.scoreMultiplier === 4, '2名玩家加倍后倍数为4');
  assert(doubleEngine.chooseDouble('D', false).success, '玩家D可以选择不加倍');
  assert(doubleEngine.chooseDouble('E', false).success, '玩家E可以选择不加倍');
  assert(doubleEngine.phase === 'playing', '所有玩家选择后进入出牌阶段');

  const revealEngine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  dealAndStart(revealEngine);
  const revealResult = revealEngine.revealHand(revealEngine.playerNames[0]);
  assert(revealResult.success, '玩家可以主动明牌');
  assert(revealResult.multiplierApplied === true, '首轮未出牌前明牌会应用5倍');
  assert(revealEngine.scoreMultiplier === 5, '明牌后按5倍计入倍数');

  const lateRevealEngine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  dealAndStart(lateRevealEngine);
  const firstPlayer = lateRevealEngine.getCurrentPlayer();
  const firstCard = lateRevealEngine.hands[firstPlayer][0];
  assert(lateRevealEngine.playCards(firstPlayer, [firstCard.uid]).success, '先完成一次出牌');
  const lateRevealPlayer = lateRevealEngine.playerNames.find(name => name !== firstPlayer);
  const lateRevealResult = lateRevealEngine.revealHand(lateRevealPlayer);
  assert(lateRevealResult.success, '出牌后仍允许明牌展示手牌');
  assert(lateRevealResult.multiplierApplied === false, '已有出牌记录后明牌不再应用5倍');
  assert(lateRevealEngine.scoreMultiplier === 1, '出牌后明牌不改变倍数');

  const revealAfterDouble = doubleEngine.revealHand('A');
  assert(revealAfterDouble.success, '加倍后仍可主动明牌');
  assert(revealAfterDouble.multiplierApplied === true, '加倍后首轮未出牌前明牌仍应用5倍');
  assert(doubleEngine.scoreMultiplier === 20, '2名玩家加倍且1人明牌后总倍数为4×5=20');
}

// ============ TEST 8: State Serialization ============
section('状态序列化');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  dealAndStart(engine);

  const state = engine.getStateForPlayer('A');
  assert(state.myHand.length > 0, 'getStateForPlayer返回手牌');
  assert(state.myName === 'A', '玩家名称正确');
  assert(state.players.length === 5, '5个玩家信息');
  assert(state.markedCard !== undefined, '包含明牌信息');
  assert(state.landlord !== null, '包含地主信息');

  const revealedPlayer = engine.playerNames.find(name => name !== 'A');
  engine.revealHand(revealedPlayer);
  const stateAfterReveal = engine.getStateForPlayer('A');
  assert(Array.isArray(stateAfterReveal.visibleHands[revealedPlayer]), '其他玩家明牌后手牌对当前玩家可见');
  assert(!stateAfterReveal.visibleHands.A, '自己的可见明牌区不重复返回自己的手牌');
}

// ============ TEST 8.5: Hidden Landlord Visibility ============
section('小地主身份保密');
{
  const { engine, hiddenMarkedCard } = createHiddenLandlordScenario();

  const landlordStateBeforeReveal = engine.getStateForPlayer('A');
  const hiddenStateBeforeReveal = engine.getStateForPlayer('B');
  const farmerStateBeforeReveal = engine.getStateForPlayer('C');
  const spectatorStateBeforeReveal = engine.getStateForSpectator();

  const hiddenFromLandlord = landlordStateBeforeReveal.players.find(player => player.name === 'B');
  const hiddenFromHidden = hiddenStateBeforeReveal.players.find(player => player.name === 'B');
  const hiddenFromFarmer = farmerStateBeforeReveal.players.find(player => player.name === 'B');

  assert(landlordStateBeforeReveal.hiddenLandlord === null, '大地主在亮明前看不到小地主');
  assert(hiddenFromLandlord.isHiddenLandlord === null, '大地主视角下不会标记小地主');
  assert(hiddenFromLandlord.team === 'unknown', '大地主视角下其他玩家阵营保持未知');
  assert(hiddenStateBeforeReveal.hiddenLandlord === 'B', '小地主自己能知道身份');
  assert(hiddenFromHidden.isHiddenLandlord === true, '小地主视角下能看到自己的小地主标签');
  assert(hiddenStateBeforeReveal.myTeam === 'landlord', '小地主知道自己属于地主阵营');
  assert(farmerStateBeforeReveal.hiddenLandlord === null, '其他玩家在亮明前看不到小地主');
  assert(hiddenFromFarmer.team === 'unknown', '其他玩家视角下小地主阵营保持未知');
  assert(spectatorStateBeforeReveal.hiddenLandlord === 'B', '观战视角仍可看到小地主');

  engine.currentPlayer = engine.playerNames.indexOf('B');
  const revealResult = engine.playCards('B', [hiddenMarkedCard.uid]);
  assert(revealResult.success, '小地主打出地主牌成功');
  assert(engine.landlordRevealed === true, '小地主打出地主牌后会公开身份');

  const landlordStateAfterReveal = engine.getStateForPlayer('A');
  assert(landlordStateAfterReveal.hiddenLandlord === 'B', '公开后大地主可以看到小地主');
}

// ============ TEST 9: Multiple Games ============
section('多局游戏稳定性');
{
  let errors = 0;
  for (let i = 0; i < 50; i++) {
    try {
      const engine = new GameEngine(['P1', 'P2', 'P3', 'P4', 'P5']);
      dealAndStart(engine);
      
      // Play a few random turns
      for (let turn = 0; turn < 20; turn++) {
        if (engine.gameOver) break;
        const player = engine.getCurrentPlayer();
        const hand = engine.hands[player];
        if (hand.length === 0) break;

        if (engine.lastPlay && engine.lastPlayPlayer !== player) {
          engine.pass(player);
        } else {
          engine.playCards(player, [hand[0].id]);
        }
      }
    } catch (e) {
      errors++;
      console.log(`  Game ${i} error: ${e.message}`);
    }
  }
  assert(errors === 0, `50局游戏无崩溃（错误: ${errors}）`);
}

// ============ TEST 10: Edge Cases ============
section('边界情况');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  dealAndStart(engine);

  // Play cards not in hand
  const result = engine.playCards(engine.getCurrentPlayer(), ['♠Z']);
  assert(!result.success, '无效牌ID被拒绝');

  // Empty play
  const result2 = engine.playCards(engine.getCurrentPlayer(), []);
  assert(!result2.success, '空出牌被拒绝');

  // Invalid combination
  const player = engine.getCurrentPlayer();
  const hand = engine.hands[player];
  if (hand.length >= 2) {
    // Try to play 2 unrelated cards (not a valid type)
    const card1 = hand[0];
    const card2 = hand.find(c => c.value !== card1.value && c.rank !== 'X' && c.rank !== 'D');
    if (card2) {
      const result3 = engine.playCards(player, [card1.id, card2.id]);
      assert(!result3.success, '无效牌型被拒绝');
    }
  }
}

// ============ TEST 11: Bomb Hierarchy (Official Rules) ============
section('炸弹等级: 5个2 < 三小王 < 6个3；6个2 < 三大王 < 7个3');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);

  const bomb5_2 = { name: 'bomb', mainValue: 15, bombSize: 5, length: 1 };
  const bomb6_3 = { name: 'bomb', mainValue: 3, bombSize: 6, length: 1 };
  const bomb6_2 = { name: 'bomb', mainValue: 15, bombSize: 6, length: 1 };
  const bomb7_3 = { name: 'bomb', mainValue: 3, bombSize: 7, length: 1 };
  const sanwangSmall = { name: 'sanwang', mainValue: 16, bombSize: 3, jokerBomb: true, length: 1 };
  const sanwangBig = { name: 'sanwang', mainValue: 17, bombSize: 3, jokerBomb: true, length: 1 };
  const bomb5 = { name: 'bomb', mainValue: 3, bombSize: 5, length: 1 };
  const bomb6 = { name: 'bomb', mainValue: 5, bombSize: 6, length: 1 };
  const bomb7 = { name: 'bomb', mainValue: 3, bombSize: 7, length: 1 };
  const bomb8 = { name: 'bomb', mainValue: 3, bombSize: 8, length: 1 };
  const bomb9 = { name: 'bomb', mainValue: 3, bombSize: 9, length: 1 };
  const bomb10 = { name: 'bomb', mainValue: 3, bombSize: 10, length: 1 };
  const bomb11 = { name: 'bomb', mainValue: 3, bombSize: 11, length: 1 };
  const bomb12 = { name: 'bomb', mainValue: 3, bombSize: 12, length: 1 };

  // 王炸只认三小王和三大王，并分别落在指定区间。
  assert(engine.canBeat(sanwangSmall, [], bomb5_2, []), '三小王 > 5个2');
  assert(engine.canBeat(bomb6_3, [], sanwangSmall, []), '6个3 > 三小王');
  assert(engine.canBeat(sanwangBig, [], bomb6_2, []), '三大王 > 6个2');
  assert(engine.canBeat(bomb7_3, [], sanwangBig, []), '7个3 > 三大王');
  assert(engine.canBeat(sanwangBig, [], sanwangSmall, []), '三大王 > 三小王');

  // 5炸 < 6炸
  assert(engine.canBeat(bomb6, [], bomb5, []), '6炸 > 5炸');

  // 6炸 < 7炸 < 8炸
  assert(engine.canBeat(bomb7, [], bomb6, []), '7炸 > 6炸');
  assert(engine.canBeat(bomb8, [], bomb7, []), '8炸 > 7炸');

  // 8炸 < 9炸 < 10炸 < 11炸 < 12炸
  assert(engine.canBeat(bomb9, [], bomb8, []), '9炸 > 8炸');
  assert(engine.canBeat(bomb10, [], bomb9, []), '10炸 > 9炸');

  // 10炸 < 11炸
  assert(engine.canBeat(bomb11, [], bomb10, []), '11炸 > 10炸');

  // 11炸 < 12炸
  assert(engine.canBeat(bomb12, [], bomb11, []), '12炸 > 11炸');

  // 12炸是最大的
  assert(!engine.canBeat(sanwangBig, [], bomb12, []), '三大王 < 12炸');

  // 同级炸弹按点数比
  const bomb4_5 = { name: 'bomb', mainValue: 5, bombSize: 4, length: 1 };
  const bomb4_6 = { name: 'bomb', mainValue: 6, bombSize: 4, length: 1 };
  assert(engine.canBeat(bomb4_6, [], bomb4_5, []), '4炸: 6666 > 5555');
  assert(!engine.canBeat(bomb4_5, [], bomb4_6, []), '4炸: 5555 < 6666');
}

// ============ TEST 12: Hint System ============
section('提示系统');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  dealAndStart(engine);

  // Hints for first player (must play, free choice)
  const firstPlayer = engine.getCurrentPlayer();
  const hints = engine.getHints(firstPlayer);
  assert(hints.length > 0, '第一手有提示可出牌');
  assert(Array.isArray(hints[0]), '提示是uid数组');

  // Each hint should be a valid play
  const hand = engine.hands[firstPlayer];
  for (let i = 0; i < Math.min(hints.length, 5); i++) {
    const hintUids = hints[i];
    const hintCards = hintUids.map(uid => hand.find(c => c.uid === uid)).filter(Boolean);
    const playType = engine.getPlayType(hintCards);
    assert(playType !== null, `提示${i + 1}是有效牌型: ${playType?.name || 'null'}`);
  }

  // Play a card, then test hints for next player with lastPlay
  const firstCard = hand[0];
  engine.playCards(firstPlayer, [firstCard.uid]);
  const nextPlayer = engine.getCurrentPlayer();
  const hints2 = engine.getHints(nextPlayer);
  // hints2 may be empty if hand can't beat, that's OK
  assert(Array.isArray(hints2), '有上家出牌时提示返回数组');

  const planeEngine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  planeEngine.hands.A = [
    new Card('♠', '5'), new Card('♥', '5'), new Card('♣', '5'),
    new Card('♠', '6'), new Card('♥', '6'), new Card('♣', '6'),
    new Card('♠', '2'), new Card('♥', '2'),
    new Card('♠', 'A'), new Card('♥', 'A')
  ];
  const planeHints = planeEngine.getHints('A');
  const hasPlanePairHint = planeHints.some(hint => {
    const cards = hint.map(uid => planeEngine.hands.A.find(card => card.uid === uid)).filter(Boolean);
    return planeEngine.getPlayType(cards)?.name === 'planeWithPairs';
  });
  assert(hasPlanePairHint, '提示包含飞机带2对子');
  assert(!planeHints.some(hint => {
    const cards = hint.map(uid => planeEngine.hands.A.find(card => card.uid === uid)).filter(Boolean);
    return planeEngine.getPlayType(cards)?.name === 'planeWithSingles';
  }), '提示不包含飞机带单张');

  const lastPlaneType = { name: 'planeWithPairs', mainValue: 6, length: 2 };
  const beatingHand = [
    new Card('♠', '7'), new Card('♥', '7'), new Card('♣', '7'),
    new Card('♠', '8'), new Card('♥', '8'), new Card('♣', '8'),
    new Card('♠', '2'), new Card('♥', '2'),
    new Card('♠', 'K'), new Card('♥', 'K')
  ];
  const beatingCombos = planeEngine._findBeatingCombos(beatingHand, lastPlaneType, []);
  assert(beatingCombos.some(combo => {
    const cards = combo.map(uid => beatingHand.find(card => card.uid === uid)).filter(Boolean);
    const type = planeEngine.getPlayType(cards);
    return type?.name === 'planeWithPairs' && type.mainValue > lastPlaneType.mainValue;
  }), '提示可生成更大的飞机带对子');

  const protectedEngine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  const protectedBomb = [
    new Card('♠', '3'), new Card('♥', '3'), new Card('♣', '3'), new Card('♦', '3'), new Card('♠', '3')
  ];
  protectedEngine.hands.A = [
    ...protectedBomb,
    new Card('♠', '4'), new Card('♥', '4'),
    new Card('♠', '5'), new Card('♥', '5')
  ];
  const protectedUids = new Set(protectedBomb.map(card => card.uid));
  const protectedHints = protectedEngine.getHints('A');
  assert(!protectedHints.some(hint => hint.some(uid => protectedUids.has(uid)) && hint.length < protectedBomb.length), '提示不拆5炸做单牌/对子/三张');
  assert(protectedHints.some(hint => protectedBomb.every(card => hint.includes(card.uid))), '提示保留完整5炸');
}

// ============ TEST 12.5: Play Card Sorting ============
section('出牌排序');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  const spade5 = new Card('♠', '5');
  const heart5 = new Card('♥', '5');
  engine.hands = {
    A: [heart5, spade5, new Card('♠', '9')],
    B: [new Card('♠', '3')],
    C: [new Card('♠', '4')],
    D: [new Card('♠', '6')],
    E: [new Card('♠', '7')]
  };
  engine.phase = 'playing';
  engine.currentPlayer = 0;
  const result = engine.playCards('A', [heart5.uid, spade5.uid]);
  assert(result.success, '倒序选择对子也能出牌');
  assert(engine.lastPlay.cards[0].id === '♠5' && engine.lastPlay.cards[1].id === '♥5', '服务端保存的已出牌自动排序');
  assert(engine.turnHistory[0].cards[0] === '♠5' && engine.turnHistory[0].cards[1] === '♥5', '出牌记录自动排序');
}

// ============ TEST 13: Landlord Labels ============
section('大地主/小地主标签');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  engine.deal();

  const state = engine.getStateForPlayer('A');
  assert(state.landlordLabel === '大地主', '状态包含大地主标签');
  assert(state.hiddenLandlordLabel === '小地主', '状态包含小地主标签');
}

// ============ TEST 14: Other joker mixes ============
section('其它王组合不算王炸');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);

  // 五王 (5 jokers)
  const fiveJokers = [
    new Card('', 'X'), new Card('', 'X'), new Card('', 'X'),
    new Card('', 'D'), new Card('', 'D')
  ];
  const wuwangType = engine.getPlayType(fiveJokers);
  assert(!wuwangType, '五王不算王炸');

  // 六王 (6 jokers)
  const sixJokers = [
    new Card('', 'X'), new Card('', 'X'), new Card('', 'X'),
    new Card('', 'D'), new Card('', 'D'), new Card('', 'D')
  ];
  const liuwangType = engine.getPlayType(sixJokers);
  assert(!liuwangType, '六王不算王炸');
}

// ============ TEST 15: 记牌器 ============
section('记牌器');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  engine.deal();

  const counter = engine.getCardCounter();
  assert(counter !== null, '记牌器返回数据');
  assert(counter['3'] && counter['3'].total === 12, '3副牌每种普通牌12张');
  assert(counter['小王'] && counter['小王'].total === 3, '小王3张');
  assert(counter['大王'] && counter['大王'].total === 3, '大王3张');

  // Initially all cards are "left" (not played)
  assert(counter['3'].left === 12, '开局所有3未出');
}

// ============ TEST 16: 观战状态 ============
section('观战状态');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  engine.deal();

  const spectState = engine.getStateForSpectator();
  assert(spectState.allHands !== undefined, '观战状态包含所有手牌');
  assert(Object.keys(spectState.allHands).length === 5, '5个玩家的手牌');
  assert(spectState.players.length === 5, '5个玩家信息');
  assert(spectState.phase !== undefined, '观战状态包含当前阶段');
  assert(spectState.markedCard !== undefined, '包含明牌');
  assert(spectState.landlord !== null, '包含地主');
}

// ============ TEST 17: 要地主流程 ============
section('要地主流程');
{
  const engine = new GameEngine(['A', 'B', 'C', 'D', 'E'], { landlordClaim: true });
  engine.deal();

  assert(engine.phase === 'claiming', '发牌后进入要地主阶段');
  assert(engine.landlord === null, '要地主前地主未定');
  assert(engine.playerNames.every(n => engine.hands[n].length === 31), '要地主前每家31张');
  assert(engine.bottomCards.length === 7, '底牌7张暂存');
  assert(engine.claimState.claimant === engine.claimState.original, '明牌持有者优先决策');
  assert(engine.initialHandsSnapshot === null, '要地主前无开局快照');

  const original = engine.claimState.original;

  // 非决策人不能操作
  const other = engine.playerNames.find(n => n !== original);
  assert(!engine.claimLandlord(other).success, '非决策人不能要地主');
  assert(!engine.declineLandlord(other).success, '非决策人不能不要地主');

  // 决策状态下发
  const claimState = engine.getStateForPlayer(original).claim;
  assert(claimState && claimState.isMyDecision === true, '决策人收到 isMyDecision');
  assert(engine.getStateForPlayer(other).claim.isMyDecision === false, '非决策人 isMyDecision 为 false');

  // 依次不要，轮完一圈回到原点必须接受
  let claimant = original;
  for (let i = 0; i < 5; i++) {
    const r = engine.declineLandlord(claimant);
    assert(r.success, `第${i + 1}家可以不要地主`);
    claimant = r.nextClaimant;
  }
  assert(claimant === original, '轮完一圈回到原点');
  assert(engine.claimState.mustTake === true, '回到原点后必须接受');
  assert(!engine.declineLandlord(original).success, '必须接受时不能不要');

  // 要地主：拿底牌、生成快照、进入公示
  const claimed = engine.claimLandlord(original);
  assert(claimed.success, '必须接受时可以要地主');
  assert(engine.landlord === original, '要地主后地主确定');
  assert(engine.hands[original].length === 38, '地主38张牌');
  assert(engine.phase === 'bottomReveal', '要地主后进入底牌公示');
  assert(claimed.bottomCards.length === 7, '公示底牌7张');
  assert(engine.initialHandsSnapshot[original].length === 38, '开局快照含底牌');
  const revealState = engine.getStateForPlayer(other).bottomReveal;
  assert(revealState && revealState.cards.length === 7, '公示阶段所有人可见底牌');
  assert(engine.getStateForSpectator().bottomReveal.cards.length === 7, '观战者可见底牌');

  // 公示结束进入选明牌
  const finished = engine.finishBottomReveal();
  assert(finished.success && engine.phase === 'selectingMarked', '公示结束进入选明牌');
  assert(engine.getStateForPlayer(original).markedCardOptions !== undefined, '地主收到明牌选项');

  // 中途要地主：第二家直接要
  const engine2 = new GameEngine(['A', 'B', 'C', 'D', 'E'], { landlordClaim: true });
  engine2.deal();
  const first = engine2.claimState.claimant;
  engine2.declineLandlord(first);
  const second = engine2.claimState.claimant;
  assert(second !== first && engine2.claimState.mustTake === false, '传给下家');
  assert(engine2.claimLandlord(second).success, '下家可以要地主');
  assert(engine2.landlord === second, '地主为第二家');
  assert(engine2.hands[second].length === 38, '第二家拿到底牌');

  // 旧流程（未开启 landlordClaim）不受影响
  const legacy = new GameEngine(['A', 'B', 'C', 'D', 'E']);
  legacy.deal();
  assert(legacy.phase === 'selectingMarked', '旧流程直接进入选明牌');
  assert(legacy.landlord !== null, '旧流程发牌即定地主');
  assert(legacy.hands[legacy.landlord].length === 38, '旧流程地主直接拿底牌');
}

// ============ Summary ============
console.log('\n' + '='.repeat(40));
console.log(`测试完成: ${testsPassed} 通过, ${testsFailed} 失败`);
if (failures.length > 0) {
  console.log('失败的测试:');
  failures.forEach(f => console.log(`  - ${f}`));
}
console.log('='.repeat(40));

process.exit(testsFailed > 0 ? 1 : 0);
