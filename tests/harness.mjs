import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert';

// === GAME LOADER ===

const SNAKE_HTML = new URL('../app/index.html', import.meta.url);

function extractGameScript() {
    const html = readFileSync(SNAKE_HTML, 'utf8');
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    if (blocks.length !== 1) {
        throw new Error(`tests/harness.mjs expected exactly one <script> block in app/index.html, found ${blocks.length}`);
    }
    return blocks[0][1];
}

const GAME_SCRIPT = extractGameScript();

const API_SRC = `
globalThis.__t = {
  tick: () => gameLoop(),
  press: (code, key) => {
    const event = { code, key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    __keydown(event);
    return event;
  },
  now: () => __now.value,
  setNow: v => { __now.value = v; },
  setVisibility: state => __fireVisibility(state),
  updateScale: () => updateGameScale(),
  touch: (type, x, y) => {
    const handler = __touchHandlers[type];
    if (!handler) throw new Error('no ' + type + ' handler registered');
    const event = { changedTouches: [{ clientX: x, clientY: y }], defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    handler(event);
    return event;
  },
  version: () => GAME_VERSION,
  state: () => gameState,
  setState: v => { gameState = v; },
  snake: () => snake.map(s => ({...s})),
  setSnake: v => { snake = v; },
  dx: () => dx, dy: () => dy, setDx: v => { dx = v; }, setDy: v => { dy = v; },
  level: () => level, setLevel: v => { level = v; },
  totalScore: () => totalScore, setTotalScore: v => { totalScore = v; },
  timeScore: () => timeScore, setFoodScore: v => { foodScore = v; },
  startTime: () => startTime, setStartTime: v => { startTime = v; },
  monsters: () => monsters.map(m => ({...m})), setMonsters: v => { monsters = v; },
  portal: () => portal ? JSON.parse(JSON.stringify(portal)) : null,
  setPortal: v => { portal = v; },
  portalTimer: () => portalTimer, setPortalTimer: v => { portalTimer = v; },
  food: () => food ? {...food} : null, setFood: v => { food = v; },
  specialFood: () => specialFood ? {...specialFood} : null, setSpecialFood: v => { specialFood = v; },
  iceFood: () => iceFood ? {...iceFood} : null, setIceFood: v => { iceFood = v; },
  spawnSpecialFood, spawnIceFood, spawnMonsterSwarm, activatePortal, enterPortal, gameOver, resetGame, startGame, generateFood,
  getPortalThreshold, getWaveInterval, checkPortalActivation, checkHighScore, loadHighScores, displayHighScores, addHighScore,
  updateSpecialFood, updateMonsters, updateGame, updateTimer, updatePortalTimer, updateUnifiedMessage, updateFlash,
  setMonsterSpawnTimer: v => { monsterSpawnTimer = v; waveDeadline = 0; },
  monsterSpawnTimer: () => monsterSpawnTimer,
  monstersAreFast: () => monstersAreFast,
  monstersAreFrozen: () => monstersAreFrozen,
  startSquares: () => startSquares.map(s => ({...s})),
  gameOverAnimation: () => gameOverAnimation,
  animatedSquares: () => animatedSquares.map(s => ({...s})),
  highScores: () => JSON.parse(JSON.stringify(highScores)),
  setHighScores: v => { highScores = v; },
  triggerFlash, triggerLevelUpFlash, flash: () => ({ flashEffect, flashTimer }),
  movementHistoryLen: () => movementHistory.length,
  recordMovement
};
`;

// === STUB DOM ===

const REAL_IDS = [
    'foodScore', 'gameCanvas', 'highScores', 'highScoresList', 'legend',
    'levelAnnouncement', 'nameEntryDiv', 'nameInput', 'timeDisplay', 'tipContent',
    'tips', 'totalScore', 'unifiedMessage', 'versionDisplay'
];

function loadGame({ now = 1700000000000, storage = {}, storageThrows = false, reducedMotion = false, layout = null } = {}) {
    const clock = { value: now };
    const logs = [];
    const elements = {};
    const store = { ...storage };
    const intervals = [];
    const timeouts = [];
    const listeners = {};
    const mainLayoutElement = layout
        ? { style: {}, offsetWidth: layout.width, offsetHeight: layout.height }
        : { style: {} };

    const drawCalls = [];
    const RECORDED_OPS = ['fillRect', 'strokeRect', 'fill', 'arc', 'moveTo', 'lineTo'];
    const ctx = new Proxy({}, {
        get(t, p) {
            if (p === 'fillStyle' || p === 'strokeStyle' || p === 'lineWidth') return t[p];
            return (...args) => {
                if (RECORDED_OPS.includes(p)) {
                    drawCalls.push({ op: p, args, fillStyle: t.fillStyle, strokeStyle: t.strokeStyle });
                }
            };
        },
        set(t, p, v) { t[p] = v; return true; }
    });

    function makeElement(tagName) {
        return {
            tagName, style: {}, className: '', children: [], innerHTML: '',
            _text: '',
            get textContent() { return this._text; },
            set textContent(value) { this._text = String(value); this.children = []; },
            appendChild(child) { this.children.push(child); return child; },
            replaceChildren(...nodes) { this.children = nodes; },
            addEventListener(type, fn) {
                if (type.startsWith('touch')) sandbox.__touchHandlers[type] = fn;
                else listeners[type] = fn;
            },
            offsetHeight: 0, width: 800, height: 800,
            getContext: () => ctx
        };
    }

    function el(id) {
        if (!REAL_IDS.includes(id)) return null;
        if (!elements[id]) {
            elements[id] = makeElement(id);
            elements[id].id = id;
        }
        return elements[id];
    }

    const FakeDate = class extends Date {
        constructor(...args) {
            if (args.length === 0) super(clock.value);
            else super(...args);
        }
        static now() { return clock.value; }
    };

    const sandbox = {
        console: {
            log: (...a) => logs.push(a.map(String).join(' ')),
            warn: (...a) => logs.push('[warn] ' + a.map(String).join(' ')),
            error: (...a) => logs.push('[error] ' + a.map(String).join(' '))
        },
        Math, Date: FakeDate, JSON, Object, Array, String, Number, Boolean, Error,
        parseInt, parseFloat, isNaN,
        __now: clock,
        document: {
            visibilityState: 'visible',
            getElementById: el,
            createElement: tag => makeElement(String(tag).toUpperCase()),
            querySelector: () => mainLayoutElement,
            addEventListener: (type, fn) => {
                listeners[type] = fn;
                if (type === 'keydown') sandbox.__keydown = fn;
            },
            body: { style: {} }
        },
        window: {
            innerWidth: 1400, innerHeight: 1000,
            addEventListener: () => {},
            matchMedia: query => ({
                matches: reducedMotion && query.includes('prefers-reduced-motion'),
                media: query,
                addEventListener: () => {},
                removeEventListener: () => {}
            }),
            AudioContext: undefined,
            webkitAudioContext: undefined
        },
        localStorage: {
            getItem: k => {
                if (storageThrows) throw new Error('SecurityError: storage disabled');
                return k in store ? store[k] : null;
            },
            setItem: (k, v) => {
                if (storageThrows) throw new Error('SecurityError: storage disabled');
                store[k] = String(v);
            },
            removeItem: k => {
                if (storageThrows) throw new Error('SecurityError: storage disabled');
                delete store[k];
            }
        },
        setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
        clearInterval: () => {},
        setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
        clearTimeout: () => {}
    };
    sandbox.globalThis = sandbox;
    sandbox.window.document = sandbox.document;
    sandbox.__fireVisibility = state => {
        sandbox.document.visibilityState = state;
        if (listeners.visibilitychange) listeners.visibilitychange();
    };
    sandbox.__touchHandlers = {};

    const context = createContext(sandbox);
    runInContext(GAME_SCRIPT + API_SRC, context, { filename: 'app/index.html<script>' });

    return { t: sandbox.__t, sandbox, logs, elements, store, intervals, timeouts, drawCalls, mainLayout: mainLayoutElement };
}

// === TEST HELPERS ===

function freshPlaying(g) {
    g.t.setHighScores([
        { name: 'CARLOS', score: 142500 }, { name: 'JAKA', score: 95000 },
        { name: 'ALEX', score: 85000 }, { name: 'GAMER', score: 42000 },
        { name: 'SNAKE', score: 28000 }
    ]);
    g.t.resetGame();
}

function withRandom(fn, body) {
    const original = Math.random;
    Math.random = fn;
    try { return body(); } finally { Math.random = original; }
}

function seededSequence(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function quietPlaying(g) {
    freshPlaying(g);
    g.t.setStartTime(g.t.now() - 1000);
    g.t.setFood({ x: 0, y: 0 });
    g.t.setSpecialFood(null);
    g.t.setIceFood(null);
}

const tests = [];
function test(name, opts, fn) {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    tests.push({ name, fn, knownFailure: opts.knownFailure || null });
}

// === CONFIGURATION ===

test('T1 wave intervals and portal thresholds match config', ({ loadGame }) => {
    const { t } = loadGame();
    const intervals = [];
    for (let l = 1; l <= 6; l++) { t.setLevel(l); intervals.push(t.getWaveInterval()); }
    assert.deepEqual(intervals, [30000, 25000, 20000, 15000, 10000, 10000], 'wave intervals L1-L6');
    const thresholds = [];
    for (let l = 1; l <= 5; l++) thresholds.push(t.getPortalThreshold(l));
    assert.deepEqual(thresholds, [35000, 80000, 135000, 200000, 275000], 'portal thresholds L1-L5');
});

// === MONSTERS ===

test('T2 a level-4 wave starts at normal speed', ({ loadGame }) => {
    const g = loadGame(); freshPlaying(g);
    const { t } = g;
    t.setLevel(4);
    t.setStartTime(t.now() - 1000);
    t.setMonsterSpawnTimer(t.getWaveInterval());
    t.setMonsters([{ x: 30, y: 30, dx: 1, dy: 1, moveCounter: 0 }]);
    t.updateMonsters();
    assert.equal(t.monstersAreFast(), false, 'level-4 wave is already FAST from the first tick');
});

test('T2b the FAST phase is the last half of each wave, and the message agrees', ({ loadGame }) => {
    const g = loadGame(); freshPlaying(g);
    const { t } = g;
    for (const level of [1, 4]) {
        t.setLevel(level);
        const interval = t.getWaveInterval();
        t.setStartTime(t.now() - 1000);
        t.setMonsters([{ x: 30, y: 30, dx: 1, dy: 1, moveCounter: 0 }]);
        t.setMonsterSpawnTimer(interval);
        t.updateMonsters();
        t.updateUnifiedMessage();
        assert.equal(t.monstersAreFast(), false, `L${level} wave starts FAST`);
        assert.ok(!g.elements.unifiedMessage.textContent.includes('FAST'),
            `L${level} message shows FAST at the start of the wave`);
        t.setMonsterSpawnTimer(interval / 2);
        t.updateMonsters();
        t.updateUnifiedMessage();
        assert.equal(t.monstersAreFast(), true, `L${level} did not enter FAST in the last half`);
        assert.ok(g.elements.unifiedMessage.textContent.includes('FAST'),
            `L${level} message does not show FAST in the last half`);
    }
});

test('T9 a monster moving onto the head kills (no phase-through)', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    t.setSnake([{ x: 6, y: 5 }]);
    t.setDx(-1); t.setDy(0);
    t.setMonsterSpawnTimer(30000);
    t.setMonsters([{ x: 4, y: 5, dx: 1, dy: 0, moveCounter: 2 }]);
    withRandom(() => 0.99, () => {
        t.tick();
        const head = t.snake()[0];
        const overlapping = t.monsters().some(m => m.x === head.x && m.y === head.y);
        assert.ok(!overlapping || t.state() === 'gameOver',
            `monster occupies the head cell (${head.x},${head.y}) while state is ${t.state()}`);
    });
});

test('T19 late-wave escalation decelerates after 16 monsters', ({ loadGame }) => {
    const g = loadGame(); freshPlaying(g);
    const { t } = g;
    const place = count => {
        const m = [];
        for (let i = 0; i < count; i++) m.push({ x: i % 40, y: Math.floor(i / 40), dx: 1, dy: 1, moveCounter: 0 });
        t.setMonsters(m);
    };
    place(0);
    t.spawnMonsterSwarm();
    assert.equal(t.monsters().length, 2, 'first wave should be 2 monsters');
    place(8);
    t.spawnMonsterSwarm();
    assert.equal(t.monsters().length, 16, '8 monsters should double to 16');
    place(16);
    t.spawnMonsterSwarm();
    assert.equal(t.monsters().length, 24, '16 monsters should grow by 8, not double');
    place(64);
    const started = Date.now();
    t.spawnMonsterSwarm();
    const elapsed = Date.now() - started;
    assert.equal(t.monsters().length, 72, '64 monsters should grow by 8');
    assert.ok(elapsed < 500, `spawning 8 monsters took ${elapsed}ms and blocks the 120ms loop`);
});

// === FOOD ===

test('T3 spawnSpecialFood tolerates a null food apple', ({ loadGame }) => {
    const g = loadGame(); freshPlaying(g);
    g.t.setFood(null);
    assert.doesNotThrow(() => g.t.spawnSpecialFood(), 'spawnSpecialFood dereferenced food.x while food is null');
});

test('T16 generateFood never places the red apple on a monster', ({ loadGame }) => {
    const g = loadGame(); freshPlaying(g);
    const { t } = g;
    withRandom(() => 0.5, () => {
        t.setSnake([{ x: 1, y: 1 }]);
        t.setFood(null);
        t.setMonsters([{ x: 20, y: 20, dx: 1, dy: 1, moveCounter: 0 }]);
        t.generateFood();
    });
    const food = t.food();
    assert.ok(food === null || !(food.x === 20 && food.y === 20),
        `red apple placed on top of a monster at (20,20): ${JSON.stringify(food)}`);
});

test('T16b generateFood terminates on a full board', ({ loadGame }) => {
    const g = loadGame(); freshPlaying(g);
    const { t } = g;
    const board = [];
    for (let x = 0; x < 40; x++) for (let y = 0; y < 40; y++) board.push({ x, y });
    t.setSnake(board);
    assert.doesNotThrow(() => t.generateFood(), 'generateFood did not terminate on a full board');
    const food = t.food();
    assert.ok(food === null || !board.some(segment => segment.x === food.x && segment.y === food.y),
        'food was placed on the snake');
});

test('T16c monster spawns avoid food and other items', ({ loadGame, withRandom }) => {
    const g = loadGame(); freshPlaying(g);
    const { t } = g;
    t.setFood({ x: 20, y: 5 });
    t.setSpecialFood(null);
    t.setIceFood(null);
    t.setMonsters([]);
    const values = [0.5, 0.125, 0.9, 0.9, 0.5, 0.5, 0.9, 0.9, 0.3, 0.3, 0.9, 0.9];
    let next = 0;
    withRandom(() => values[Math.min(next++, values.length - 1)], () => {
        t.spawnMonsterSwarm();
    });
    const stacked = t.monsters().filter(m => m.x === 20 && m.y === 5);
    assert.equal(stacked.length, 0, 'a monster spawned on top of the red apple');
});

// === PORTAL ===

test('T4 entering the portal resets direction and holds the countdown (STATE2)', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    t.setLevel(1);
    t.setDx(1); t.setDy(0);
    const head = t.snake()[0];
    t.setStartTime(t.now() - 5000);
    t.updateTimer();
    const scoreBefore = t.timeScore();
    assert.ok(scoreBefore >= 500, `timer did not score before the portal: ${scoreBefore}`);
    t.setPortal({
        wallBlocks: [{ x: 0, y: 0 }, { x: 39, y: 39 }],
        gatewayBlocks: [{ x: (head.x + 1) % 40, y: head.y }],
        side: 0
    });
    t.updateGame();
    assert.equal(t.level(), 2, 'entering the gateway did not advance the level');
    assert.deepEqual([t.dx(), t.dy()], [0, 0], 'direction was not reset for the static pre-game state');
    const headAtPortal = t.snake()[0];
    t.updateGame();
    assert.deepEqual(t.snake()[0], headAtPortal, 'snake moved again without player input');
    const waveTimer = t.monsterSpawnTimer();
    t.updateMonsters();
    assert.equal(t.monsterSpawnTimer(), waveTimer, 'wave countdown ran before the first player input');
    t.press('ArrowRight', 'ArrowRight');
    assert.deepEqual([t.dx(), t.dy()], [1, 0], 'the first arrow key did not set direction');
    t.updateGame();
    t.updateTimer();
    assert.ok(t.timeScore() >= scoreBefore, `time score dropped across the portal: ${scoreBefore} -> ${t.timeScore()}`);
});

test('T8 banked score cannot re-open a portal the tick after entering one', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    t.setLevel(1);
    t.setTotalScore(0);
    t.setFoodScore(100000);
    t.updateTimer();
    assert.ok(t.portal(), 'level-1 portal did not activate at the 35k threshold');
    const head = t.snake()[0];
    t.setDx(1); t.setDy(0);
    t.setPortal({
        wallBlocks: [{ x: 0, y: 0 }],
        gatewayBlocks: [{ x: (head.x + 1) % 40, y: head.y }],
        side: 0
    });
    t.updateGame();
    assert.equal(t.level(), 2, 'portal entry did not advance to level 2');
    t.setStartTime(t.now() - 5000);
    t.updateTimer();
    assert.equal(t.portal(), null, 'banked score re-activated a portal immediately at level 2');
    t.setFoodScore(145000);
    t.updateTimer();
    assert.ok(t.portal(), 'a newly earned increment did not re-open the portal');
});

test('T11 a portal wall never spawns on a snake segment', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    withRandom(() => 0, () => {
        t.setSnake([{ x: 10, y: 0 }]);
        t.setDx(1); t.setDy(0);
        t.activatePortal();
    });
    const portal = t.portal();
    assert.ok(portal, 'portal was not created');
    const onWall = t.snake().filter(segment =>
        portal.wallBlocks.some(block => block.x === segment.x && block.y === segment.y) &&
        !portal.gatewayBlocks.some(gateway => gateway.x === segment.x && gateway.y === segment.y));
    assert.equal(onWall.length, 0, `snake segment(s) under a non-gateway wall block: ${JSON.stringify(onWall)}`);
});

test('T11b left/right portal gateways are not confined to the bottom half', ({ loadGame }) => {
    const { t } = loadGame();
    const half = 20;
    for (const side of [1, 3]) {
        const mins = [];
        for (let sample = 0; sample < 25; sample++) {
            const rng = seededSequence(sample + 1);
            let call = 0;
            withRandom(() => (call++ === 0 ? (side === 1 ? 0.3 : 0.8) : rng()), () => {
                t.activatePortal();
            });
            const portal = t.portal();
            assert.equal(portal.side, side, `expected side ${side}`);
            mins.push(Math.min(...portal.gatewayBlocks.map(b => b.y)));
        }
        assert.ok(Math.min(...mins) < half,
            `side ${side}: 25 samples all placed the gateway in y >= ${half} (min ${Math.min(...mins)})`);
    }
});

// === ANIMATIONS ===

test('T6 start-screen squares keep moving', ({ loadGame }) => {
    const g = loadGame();
    const { t } = g;
    t.setState('start');
    assert.ok(t.startSquares().length > 0, 'no start-screen squares exist');
    for (let i = 0; i < 20000; i++) t.tick();
    const before = t.startSquares();
    for (let i = 0; i < 50; i++) t.tick();
    const after = t.startSquares();
    const moved = after.filter((s, i) => Math.abs(s.y - before[i].y) >= 2).length;
    assert.ok(moved > 0, `none of the ${after.length} start-screen squares moved vertically over 50 ticks`);
});

test('T7 game-over squares keep moving', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    withRandom(() => 0.5, () => t.gameOver());
    assert.ok(t.animatedSquares().length > 0, 'no game-over squares exist');
    for (let i = 0; i < 4000; i++) t.tick();
    const before = t.animatedSquares();
    for (let i = 0; i < 50; i++) t.tick();
    const after = t.animatedSquares();
    const moved = after.filter((s, i) => Math.abs(s.y - before[i].y) >= 2).length;
    assert.ok(moved > 0, `none of the ${after.length} game-over squares moved vertically over 50 ticks`);
});

// === RENDERING ===

test('T20 the game-over screen still draws the hazard that killed you', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    const monster = { x: 7, y: 7, dx: 1, dy: 1, moveCounter: 0 };
    t.setSnake([{ x: 7, y: 6 }]);
    t.setDx(0); t.setDy(1);
    t.setMonsters([monster]);
    t.updateGame();
    assert.equal(t.state(), 'gameOver', 'the head moving onto a monster did not kill the snake');
    g.drawCalls.length = 0;
    t.tick();
    const centerX = monster.x * 20 + 10;
    const centerY = monster.y * 20 + 10;
    const painted = g.drawCalls.some(c => c.op === 'moveTo' && c.fillStyle === '#800080' &&
        Math.abs(c.args[0] - centerX) <= 20 && Math.abs(c.args[1] - centerY) <= 20);
    assert.ok(painted, 'the monster that killed the snake was not drawn on the game-over screen');
});

test('T25 reduced motion skips the full-canvas flashes', ({ loadGame }) => {
    const normal = loadGame();
    quietPlaying(normal);
    normal.t.triggerFlash('white');
    assert.equal(normal.t.flash().flashEffect, true, 'white flash did not trigger with motion allowed');
    const reduced = loadGame({ reducedMotion: true });
    quietPlaying(reduced);
    reduced.t.triggerFlash('white');
    assert.equal(reduced.t.flash().flashEffect, false, 'white flash triggered under reduced motion');
    reduced.t.triggerLevelUpFlash();
    assert.equal(reduced.t.flash().flashEffect, false, 'gold flash triggered under reduced motion');
});

test('T25b scaling measures the real layout instead of a hardcoded size', ({ loadGame }) => {
    const g = loadGame({ layout: { width: 2000, height: 1000 } });
    g.t.updateScale();
    const transform = g.mainLayout.style.transform;
    assert.ok(typeof transform === 'string' && transform.startsWith('scale('), `no scale transform was applied: ${transform}`);
    const scale = parseFloat(transform.slice('scale('.length));
    const expected = Math.min((1400 - 20) / 2000, (1000 - 30) / 1000, 1);
    assert.ok(Math.abs(scale - expected) < 0.0001, `scale ${scale} does not match the measured layout (${expected})`);
});

// === HIGH SCORES ===

test('T10 corrupted localStorage does not crash the high-score check', ({ loadGame }) => {
    const g = loadGame({ storage: { snake_high_scores: '{}' } });
    const { t } = g;
    assert.doesNotThrow(() => t.checkHighScore(1000), 'checkHighScore threw on a non-array payload');
    assert.equal(typeof t.checkHighScore(1000), 'boolean', 'checkHighScore did not return a boolean');
});

test('T10b legacy snakeHighScores migrates to snake_high_scores', ({ loadGame }) => {
    const legacy = JSON.stringify([{ name: 'OLD', score: 12345 }]);
    const g = loadGame({ storage: { snakeHighScores: legacy } });
    assert.ok(g.store['snake_high_scores'], 'the namespaced key was not written');
    assert.deepEqual(g.t.highScores(), [{ name: 'OLD', score: 12345 }]);
    assert.equal('snakeHighScores' in g.store, false, 'the legacy key was not removed after migration');
});

test('T10c a storage-disabled context still loads and scores', ({ loadGame }) => {
    const g = loadGame({ storageThrows: true });
    assert.equal(g.t.state(), 'start', 'the game did not reach the start screen');
    assert.equal(typeof g.t.checkHighScore(1000), 'boolean', 'checkHighScore did not return a boolean');
});

test('T10d malformed high-score entries are dropped', ({ loadGame }) => {
    const payload = JSON.stringify([
        { name: 'OK', score: 500 },
        null, 42, 'nope',
        { name: 'NONAME' },
        { score: 900 },
        { name: 'TXT', score: 'high' },
        { name: 'OLD', time: 123.4 }
    ]);
    const g = loadGame({ storage: { snake_high_scores: payload } });
    const scores = g.t.highScores();
    assert.ok(scores.every(e => typeof e.name === 'string' && Number.isFinite(e.score)),
        `invalid entries survived: ${JSON.stringify(scores)}`);
    assert.deepEqual(scores.map(e => e.name), ['OLD', 'OK'], 'entries should sort by score after conversion');
});

test('T12 a tie with the lowest score qualifies, and the newer entry wins it', ({ loadGame }) => {
    const g = loadGame();
    const { t } = g;
    t.setHighScores([
        { name: 'A', score: 100 }, { name: 'B', score: 90 }, { name: 'C', score: 80 },
        { name: 'D', score: 70 }, { name: 'E', score: 60 }
    ]);
    assert.equal(t.checkHighScore(60), true, 'a tie with 5th place did not qualify');
    assert.equal(t.checkHighScore(59), false, 'a score below 5th place qualified');
    t.addHighScore('NEW', 60);
    const names = t.highScores().map(entry => entry.name);
    assert.deepEqual(names, ['A', 'B', 'C', 'D', 'NEW'], `newer tie entry should replace the older one: ${JSON.stringify(names)}`);
});

test('T21 high-score names cannot inject DOM elements', ({ loadGame }) => {
    const g = loadGame({ storage: { snake_high_scores: JSON.stringify([{ name: '<b>X</b>', score: 9999 }]) } });
    const list = g.elements.highScoresList;
    const injected = (list.innerHTML || '').includes('<b>') || list.children.some(child => child.tagName === 'B');
    assert.equal(injected, false, `high-score name was parsed as HTML: ${JSON.stringify(list.innerHTML)}`);
});

test('T17 name entry can be declined with Space', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    t.setFoodScore(999999);
    withRandom(() => 0.5, () => t.gameOver());
    assert.equal(t.state(), 'nameEntry', 'high score did not route to name entry');
    const before = t.highScores();
    t.press('Space', ' ');
    assert.equal(t.state(), 'gameOver', 'Space did not decline name entry');
    assert.deepEqual(t.highScores(), before, 'declining still modified the high scores');
});

test('T17b name entry accepts non-Latin characters', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    t.setFoodScore(999999);
    withRandom(() => 0.5, () => t.gameOver());
    assert.equal(t.state(), 'nameEntry', 'high score did not route to name entry');
    t.press('KeyД', 'д');
    t.press('Digit1', '1');
    t.press('Enter', 'Enter');
    assert.equal(t.state(), 'gameOver', 'a typed name did not complete the entry');
    const names = t.highScores().map(entry => entry.name);
    assert.ok(names.includes('Д1'), `non-Latin name missing from the list: ${JSON.stringify(names)}`);
});

// === LOGGING ===

test('T22 the load log reports the current GAME_VERSION', ({ loadGame }) => {
    const g = loadGame();
    const version = g.t.version();
    assert.ok(g.logs.some(line => line.includes(version)), `no load log line contains ${version}`);
    assert.ok(!g.logs.some(line => line.includes('v1.200825')), 'the stale v1.200825 string is still logged');
});

test('T24 quiet play does not log every tick or keypress', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    withRandom(() => 0.5, () => t.triggerFlash('white'));
    let before = g.logs.length;
    t.tick();
    assert.deepEqual(g.logs.slice(before), [], `a tick with an active flash logged: ${JSON.stringify(g.logs.slice(before))}`);
    before = g.logs.length;
    t.press('ArrowUp', 'ArrowUp');
    assert.deepEqual(g.logs.slice(before), [], `a key press logged: ${JSON.stringify(g.logs.slice(before))}`);
    before = g.logs.length;
    t.setDx(1); t.setDy(0);
    t.setMonsters([{ x: t.snake()[0].x + 1, y: t.snake()[0].y, dx: 1, dy: 1, moveCounter: 0 }]);
    t.tick();
    assert.equal(t.state(), 'gameOver', 'the forced head collision did not end the game');
    assert.ok(g.logs.slice(before).some(line => line.includes('Game Over')), 'the death transition was not logged');
});

// === INPUT ===

test('T23 gameplay keys do not scroll the page', ({ loadGame }) => {
    const g = loadGame();
    const { t } = g;
    const keys = [
        ['ArrowUp', 'ArrowUp'], ['ArrowDown', 'ArrowDown'],
        ['ArrowLeft', 'ArrowLeft'], ['ArrowRight', 'ArrowRight'],
        ['Space', ' '], ['Enter', 'Enter']
    ];
    for (const [code, key] of keys) {
        const event = t.press(code, key);
        assert.equal(event.defaultPrevented, true, `${code} was not default-prevented`);
    }
});

// === TOUCH INPUT ===

test('T26 swipe steers and tap starts/restarts/declines', ({ loadGame }) => {
    const g = loadGame();
    const { t } = g;
    t.setState('start');
    t.touch('touchstart', 100, 100);
    t.touch('touchend', 102, 100);
    assert.equal(t.state(), 'playing', 'a tap on the start screen did not start the game');
    t.touch('touchstart', 100, 100);
    t.touch('touchend', 200, 100);
    assert.deepEqual([t.dx(), t.dy()], [1, 0], 'a right swipe did not steer right');
    t.updateGame();
    t.touch('touchstart', 100, 100);
    t.touch('touchend', 100, 160);
    assert.deepEqual([t.dx(), t.dy()], [0, 1], 'a down swipe did not steer down');
    t.gameOver();
    assert.equal(t.state(), 'gameOver', 'the game did not reach the game-over state');
    t.touch('touchstart', 100, 100);
    t.touch('touchend', 101, 100);
    assert.equal(t.state(), 'playing', 'a tap on the game-over screen did not restart');
    t.setState('nameEntry');
    t.touch('touchstart', 100, 100);
    t.touch('touchend', 101, 100);
    assert.equal(t.state(), 'gameOver', 'a tap during name entry did not decline');
});

// === TIMERS ===

test('T15b hidden time neither scores nor ages the portal timer', ({ loadGame, withRandom }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    t.setNow(1000000);
    t.setStartTime(1000000);
    t.updateTimer();
    const scoreBefore = t.timeScore();
    withRandom(() => 0.5, () => t.activatePortal());
    const portalBefore = t.portalTimer();
    t.setVisibility('hidden');
    t.setNow(1060000);
    t.tick();
    t.setVisibility('visible');
    t.updateTimer();
    t.updatePortalTimer();
    assert.equal(t.timeScore(), scoreBefore, `score advanced while hidden: ${scoreBefore} -> ${t.timeScore()}`);
    assert.equal(t.portalTimer(), portalBefore, `portal timer aged while hidden: ${portalBefore} -> ${t.portalTimer()}`);
});

test('T15d the yellow apple lifetime tracks wall clock', ({ loadGame, withRandom }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    t.setNow(2000000);
    t.setStartTime(1999000);
    withRandom(() => 0.5, () => t.spawnSpecialFood());
    assert.ok(t.specialFood(), 'the yellow apple did not spawn');
    t.setNow(2010000);
    t.updateSpecialFood();
    assert.equal(t.specialFood(), null, 'the yellow apple outlived its 2-6 second wall-clock lifetime');
});

test('T15c the wave countdown tracks wall clock', ({ loadGame }) => {
    const g = loadGame(); freshPlaying(g);
    const { t } = g;
    t.setNow(1000000);
    t.setStartTime(999000);
    t.setMonsterSpawnTimer(30000);
    t.updateMonsters();
    assert.equal(t.monsterSpawnTimer(), 30000, 'the countdown did not start from the set value');
    t.setNow(1005000);
    t.updateMonsters();
    assert.equal(t.monsterSpawnTimer(), 25000, `5 wall-clock seconds advanced but the timer reads ${t.monsterSpawnTimer()}ms`);
});

test('T15 the portal countdown tracks wall clock, not ticks', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    t.setNow(1000000);
    t.setStartTime(999000);
    withRandom(() => 0.5, () => t.activatePortal());
    assert.ok(t.portalTimer() > 0, 'portal countdown did not start');
    t.setNow(1010000);
    t.updatePortalTimer();
    assert.ok(t.portalTimer() <= 5000,
        `10 wall-clock seconds advanced but portalTimer is ${t.portalTimer()}ms`);
});

// === CORE GAME LOGIC ===

test('T5 moving into the current tail cell is death (current behavior; tail-vacate undecided)', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    t.setSnake([{ x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }, { x: 1, y: 1 }]);
    t.setDx(-1); t.setDy(0);
    t.updateGame();
    assert.equal(t.state(), 'gameOver', 'moving into the vacating tail cell survived');
});

test('T18c normal movement still drops the tail', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    t.setSnake([{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }]);
    t.setDx(1); t.setDy(0);
    t.updateGame();
    const snake = t.snake();
    assert.equal(snake.length, 3, `normal movement changed length to ${snake.length}`);
    assert.deepEqual(snake[0], { x: 6, y: 5 }, 'head did not advance');
    assert.deepEqual(snake[2], { x: 4, y: 5 }, 'tail did not drop');
});

test('T18a a neck cut leaves the snake alive at length 1', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    t.setSnake([{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }]);
    t.setDx(1); t.setDy(0);
    t.setMonsters([{ x: 5, y: 5, dx: 9, dy: 9, moveCounter: 0 }]);
    t.updateGame();
    assert.equal(t.snake().length, 1, `neck cut left ${t.snake().length} segment(s)`);
    assert.equal(t.state(), 'playing', `neck cut ended the game: ${t.state()}`);
    t.updateGame();
    assert.equal(t.snake().length, 1, `snake died the tick after the neck cut: length ${t.snake().length}`);
    assert.equal(t.state(), 'playing', `state after the follow-up tick: ${t.state()}`);
});

test('T18b a mid-body cut keeps the documented segment count', ({ loadGame }) => {
    const g = loadGame();
    quietPlaying(g);
    const { t } = g;
    t.setSnake([{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }]);
    t.setDx(1); t.setDy(0);
    t.setMonsters([{ x: 3, y: 5, dx: 9, dy: 9, moveCounter: 0 }]);
    t.updateGame();
    assert.equal(t.snake().length, 3, `mid-body cut left ${t.snake().length} segments, documented result is 3`);
    assert.equal(t.state(), 'playing', `mid-body cut ended the game: ${t.state()}`);
});

test('T13 1000-tick random-input smoke test', ({ loadGame }) => {
    const g = loadGame();
    freshPlaying(g);
    const { t } = g;
    const rng = seededSequence(42);
    withRandom(rng, () => {
        const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];
        let deaths = 0;
        for (let i = 0; i < 1000; i++) {
            if (i % 7 === 0) {
                const code = keys[Math.floor(rng() * keys.length)];
                t.press(code, code.replace('Arrow', ''));
            }
            if (t.state() === 'gameOver' || t.state() === 'nameEntry') {
                deaths++;
                t.press('Space', ' ');
            } else {
                t.tick();
            }
        }
        assert.ok(['start', 'playing', 'gameOver', 'nameEntry'].includes(t.state()),
            `smoke test ended in invalid state ${t.state()}`);
        assert.ok(t.level() >= 1 && Number.isFinite(t.totalScore()),
            `smoke test ended at level ${t.level()} score ${t.totalScore()} after ${deaths} deaths`);
    });
});

// === RUNNER ===

const args = process.argv.slice(2);
if (args.includes('--help')) {
    console.log('usage: node tests/harness.mjs [--filter <text>] [--list] [--verbose]');
    console.log('  XFAIL  a known backlog defect (knownFailure: BL-xx) reproduced as expected');
    console.log('  XPASS  a marked defect no longer reproduces - promote the marker to a real assertion');
    process.exit(0);
}
const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1].toLowerCase() : null;
const listOnly = args.includes('--list');
const verbose = args.includes('--verbose');

if (listOnly) {
    for (const t of tests) console.log(`${t.knownFailure ? `[${t.knownFailure}] ` : ''}${t.name}`);
    process.exit(0);
}

const ctx = { loadGame, freshPlaying, withRandom, seededSequence, assert };
const results = [];
const originalRandom = Math.random;

for (const t of tests) {
    if (filter && !t.name.toLowerCase().includes(filter)) continue;
    Math.random = originalRandom;
    const started = Date.now();
    let error = null;
    let g = null;
    try {
        g = loadGame();
        t.fn(ctx);
    } catch (e) {
        error = e;
    } finally {
        Math.random = originalRandom;
    }
    results.push({
        name: t.name,
        knownFailure: t.knownFailure,
        error,
        logs: g ? g.logs : [],
        ms: Date.now() - started
    });
}

const pad = (s, n) => String(s).padEnd(n);
const oneLine = e => String(e.message).split('\n')[0];
let failed = 0, xpassed = 0;

for (const r of results) {
    if (!r.error) {
        if (r.knownFailure) {
            xpassed++;
            console.log(`[XPASS] ${r.name}\n        -> ${r.knownFailure} no longer reproduces; remove the knownFailure marker`);
        } else {
            console.log(`[PASS ] ${r.name} (${r.ms}ms)`);
        }
    } else if (r.knownFailure) {
        console.log(`[XFAIL] ${r.name} (${r.knownFailure})\n        -> ${oneLine(r.error)}`);
    } else {
        failed++;
        console.log(`[FAIL ] ${r.name}\n        -> ${r.error.constructor.name}: ${oneLine(r.error)}`);
        if (verbose || r.logs.length) {
            for (const line of r.logs.slice(-15)) console.log(`        | ${line}`);
        }
    }
}

const passed = results.filter(r => !r.error && !r.knownFailure).length;
const xfailed = results.filter(r => r.error && r.knownFailure).length;
const blamed = [...new Set(results.filter(r => r.knownFailure).map(r => r.knownFailure))].join(', ');
console.log('');
console.log(`${results.length} tests · ${passed} passed · ${failed} failed · ${xfailed} expected-fail (BL: ${blamed || 'none'}) · ${xpassed} unexpected-pass`);
process.exitCode = failed || xpassed ? 1 : 0;
