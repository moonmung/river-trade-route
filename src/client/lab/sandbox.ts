// 실험실 모의 게임: 서버 없이 브라우저 안에서 규칙 엔진(shared/rules)을 그대로 돌린다.
// 화면 정보는 서버와 같은 함수(shared/gameView)로 만들어 실제 게임 화면(Game.tsx)에 그대로 넘긴다.
// 다른 자리는 봇이 두고, 보는 자리를 바꾸면 그 사람이 되어 직접 둘 수 있다. 차례 시간도 서버처럼 잰다.
import { DEV_CARDS, DISCARD_LIMIT, MIN_PLAYERS, RESOURCE_CARDS, TURN_SECONDS, WIN_POINTS } from '../../shared/constants';
import { buildGameView } from '../../shared/gameView';
import { DEFAULT_MAP, mapCardDefaults, maxPlayersFor } from '../../shared/maps';
import type { AckResult, ChatBrag, ChatEmote, ChatMessage, ChatPing, RoomView } from '../../shared/protocol';
import { applyAction, autoPlay, clockKey, createGame, currentPlayer, placementPlayer, type GameState } from '../../shared/rules';
import type { GameAction, MapConfig } from '../../shared/types';
import type { DiceMode } from '../../shared/fairDice';
import { botSideAction, botTurnAction } from '../../shared/bot';

export const LAB_CODE = 'LAB1';
const NAMES = ['나', '버들', '물레', '나루', '솔이', '바위', '여울', '한별'];
/** 화면 연출이 끝났는지 다시 보는 간격과, 아무리 길어도 이만큼 지나면 봇이 두는 시간 */
const BUSY_POLL_MS = 150;
const BUSY_MAX_MS = 10_000;

export interface LabPlayer {
  id: string;
  nickname: string;
  colorIndex: number;
}

export interface SandboxOptions {
  players: number;
  winPoints?: number;
  handLimit?: number;
  turnSeconds?: number;
  rollForOrder?: boolean;
  map?: MapConfig;
  resourceCards?: number;
  devCards?: number;
  /** 개수 제한 없음 (길·마을·도시·발전 카드) */
  unlimited?: boolean;
  /** 주사위 방식 (실험실 기본은 무작위. 주사위 정하기는 어느 방식에서나 그 눈이 나온다) */
  diceMode?: DiceMode;
  /** 7 버리기 (기본 있음) */
  sevenDiscard?: boolean;
}

type Listener = () => void;

export class Sandbox {
  state!: GameState;
  players: LabPlayer[] = [];
  you = 'p0';
  gameNumber = 0;
  turnSeconds = TURN_SECONDS;
  map: MapConfig = { ...DEFAULT_MAP };
  devCards = DEV_CARDS;
  /** 다른 자리를 봇이 둔다 */
  bots = true;
  /** 봇이 한 수를 두기까지 기다리는 시간 */
  botDelay = 750;
  /** 내 자리 비움(자동): 서버처럼 내 차례도 봇이 대신 둔다. 직접 두면 꺼진다. */
  autoYou = false;
  /**
   * 화면이 아직 주사위·생산·동상 연출을 보여 주는 중인지 (실험실 화면이 game/pace.ts 로 정한다).
   * 그동안 봇은 다음 수를 미루고, 끝나면 botDelay 만큼 더 쉬었다가 둔다. 사람 화면의 버튼이 열리는 때와 같은 차례다.
   */
  busy: (() => boolean) | null = null;
  private busySince = 0;
  private clock: { key: string; deadline: number } | null = null;
  private clockPaused = false;
  private readonly listeners = new Set<Listener>();
  private botTimer = 0;
  private tickTimer = 0;
  private chatSeq = 0;
  private snapshot: RoomView | null = null;
  /** 바깥(모의 채팅)으로 보내는 대화·이모티콘 */
  onChat: ((m: ChatMessage) => void) | null = null;
  onEmote: ((e: ChatEmote) => void) | null = null;
  onPing: ((p: ChatPing) => void) | null = null;
  onBrag: ((b: ChatBrag) => void) | null = null;
  private pingSeq = 0;

  constructor(opts: SandboxOptions) {
    this.reset(opts);
  }

  /** 차례 시계와 봇을 돌린다 (화면에 붙을 때). stop 한 뒤 다시 start 해도 된다. */
  start(): void {
    window.clearInterval(this.tickTimer);
    this.tickTimer = window.setInterval(() => this.tick(), 200);
    this.scheduleBot();
  }

  stop(): void {
    window.clearInterval(this.tickTimer);
    window.clearTimeout(this.botTimer);
    this.tickTimer = 0;
  }

  reset(opts: SandboxOptions): void {
    this.map = { ...(opts.map ?? this.map) };
    const n = Math.min(maxPlayersFor(this.map.shape), Math.max(MIN_PLAYERS, opts.players));
    this.players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, nickname: NAMES[i], colorIndex: i }));
    this.you = 'p0';
    this.turnSeconds = opts.turnSeconds ?? TURN_SECONDS;
    const cards = mapCardDefaults(this.map.shape);
    this.devCards = opts.devCards ?? cards.devCards;
    this.state = createGame(
      this.players.map((p) => p.id),
      Math.random,
      {
        winPoints: opts.winPoints ?? WIN_POINTS,
        handLimit: opts.handLimit ?? DISCARD_LIMIT,
        rollForOrder: opts.rollForOrder ?? true,
        map: this.map,
        resourceCards: opts.resourceCards ?? cards.resourceCards,
        devCards: this.devCards,
        unlimited: !!opts.unlimited,
        diceMode: opts.diceMode ?? 'random',
        sevenDiscard: opts.sevenDiscard !== false,
      },
    );
    this.gameNumber += 1;
    this.clock = null;
    this.changed();
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getView = (): RoomView => {
    if (!this.snapshot) this.snapshot = this.viewFor(this.you);
    return this.snapshot;
  };

  /** 이 사람이 보는 화면 정보 (서버가 보내는 것과 같은 모양) */
  viewFor(id: string): RoomView {
    return {
      code: LAB_CODE,
      phase: 'game',
      hostId: 'p0',
      you: id,
      players: this.players.map((p) => ({
        id: p.id,
        nickname: p.nickname,
        colorIndex: p.colorIndex,
        isHost: p.id === 'p0',
        ready: true,
        auto: p.id === this.you && this.autoYou,
        connected: true,
      })),
      game: buildGameView(this.state, id, { turnSeconds: this.turnSeconds, deadline: this.clockPaused ? null : (this.clock?.deadline ?? null) }),
      gameNumber: this.gameNumber,
      minPlayers: MIN_PLAYERS,
      maxPlayers: maxPlayersFor(this.map.shape),
      winPoints: this.state.winPoints,
      handLimit: this.state.handLimit,
      turnSeconds: this.turnSeconds,
      map: { ...this.map },
      resourceCards: this.state.bankSize ?? RESOURCE_CARDS,
      devCards: this.devCards,
      unlimited: !!this.state.unlimited,
      diceMode: this.state.diceMode ?? 'random',
      sevenDiscard: this.state.sevenDiscard !== false,
    };
  }

  private changed(): void {
    this.syncClock();
    this.snapshot = null;
    for (const fn of this.listeners) fn();
    this.scheduleBot();
  }

  /** 다음 주사위 굴림을 이 값으로 정한다 (누가 굴리든 한 번) */
  nextDice: [number, number] | null = null;
  private idle = 0;

  /** 정해 둔 다음 주사위가 있으면 그 값을 내는 난수, 없으면 Math.random */
  diceRandom(): () => number {
    const d = this.nextDice;
    if (!d) return Math.random;
    this.nextDice = null;
    const vals = [(d[0] - 1) / 6 + 0.01, (d[1] - 1) / 6 + 0.01];
    let i = 0;
    return () => (i < 2 ? vals[i++] : Math.random());
  }

  /** 내가 둔 행동 (화면 버튼). 굴리기는 정해 둔 주사위 값을 쓴다. 자리 비움이었으면 서버처럼 꺼진다. */
  actMine(action: GameAction): AckResult {
    const res = action.type === 'roll' ? this.roll(this.you, action) : this.act(this.you, action, Math.random);
    if (res.ok && this.autoYou) this.setAuto(false);
    return res;
  }

  /** 내 자리 비움(자동)을 켜고 끈다 (서버의 room:auto 와 같다) */
  setAuto(on: boolean): AckResult {
    if (on && this.state.phase === 'finished') return { ok: false, error: '게임 중에만 자리 비움을 켤 수 있습니다.' };
    if (this.autoYou === on) return { ok: true };
    this.autoYou = on;
    this.changed();
    return { ok: true };
  }

  /** 주사위 굴리기. 정해 둔 눈이 있으면 고르게 굴리기여도 그 눈이 나오게 이번 한 번만 그냥 굴린다. */
  private roll(playerId: string, action: GameAction): AckResult {
    const forced = !!this.nextDice;
    const mode = this.state.diceMode;
    if (forced) this.state.diceMode = 'random';
    try {
      return this.act(playerId, action, this.diceRandom());
    } finally {
      this.state.diceMode = mode;
    }
  }

  /** 행동을 규칙 엔진에 넣는다. random 을 넘기면 주사위·빼앗기 값을 정할 수 있다. */
  act(playerId: string, action: GameAction, random: () => number = Math.random): AckResult {
    const before = this.state.version;
    const r = applyAction(this.state, playerId, action, random);
    if (this.state.version !== before) this.changed();
    return r.ok ? { ok: true } : { ok: false, error: r.message, code: r.code };
  }

  /** 상태를 직접 고친다 (실험용 치트). 고친 뒤 화면을 다시 그린다. */
  cheat(fn: (s: GameState) => void): void {
    fn(this.state);
    this.state.version += 1;
    this.changed();
  }

  setYou(id: string): void {
    this.you = id;
    this.changed();
  }

  setTurnSeconds(s: number): void {
    this.turnSeconds = s;
    this.clock = null;
    this.changed();
  }

  setPaused(paused: boolean): void {
    this.clockPaused = paused;
    if (!paused && this.clock) this.clock.deadline = Date.now() + this.turnSeconds * 1000;
    this.changed();
  }

  get paused(): boolean {
    return this.clockPaused;
  }

  /** 서버의 syncClock 과 같다: 재는 차례가 바뀌면 처음부터 잰다. */
  private syncClock(): void {
    const key = clockKey(this.state);
    if (!key || this.turnSeconds <= 0) {
      this.clock = null;
      return;
    }
    if (this.clock?.key === key) return;
    this.clock = { key, deadline: Date.now() + this.turnSeconds * 1000 };
  }

  private tick(): void {
    if (this.clockPaused || !this.clock || Date.now() < this.clock.deadline) return;
    this.clock = null;
    if (autoPlay(this.state)) this.changed();
    else this.syncClock();
  }

  /** 지금 무언가 해야 하는 봇이 있으면 잠시 뒤 한 수를 둔다 (한 번에 한 수씩, 연출이 보이게). */
  private scheduleBot(): void {
    window.clearTimeout(this.botTimer);
    this.busySince = 0;
    if (!this.tickTimer || !(this.bots || this.autoYou) || this.state.phase === 'finished') return;
    this.botTimer = window.setTimeout(() => this.botStep(), this.botDelay);
  }

  private botStep(): void {
    if (!this.bots && !this.autoYou) return;
    // 화면의 연출이 끝날 때까지 기다린다. 연출이 끝나지 않아도 BUSY_MAX_MS 가 지나면 그냥 둔다.
    if (this.busy?.()) {
      if (!this.busySince) this.busySince = Date.now();
      if (Date.now() - this.busySince < BUSY_MAX_MS) {
        this.botTimer = window.setTimeout(() => this.botStep(), BUSY_POLL_MS);
        return;
      }
    } else if (this.busySince) {
      // 연출이 막 끝났다: 사람처럼 결과를 한 번 보고 둔다.
      this.busySince = 0;
      this.botTimer = window.setTimeout(() => this.botStep(), this.botDelay);
      return;
    }
    const s = this.state;
    // 봇이 두는 자리: 다른 자리(봇을 켰을 때)와 자리 비운 나. 나는 서버의 자동처럼 교환을 하지 않는다.
    const bots = this.players.filter((p) => (p.id === this.you ? this.autoYou : this.bots));
    const optsFor = (id: string) => (id === this.you ? { trades: false } : {});
    // 차례와 상관없는 일 먼저 (순서 주사위, 7 버리기, 교환 응답)
    for (const p of bots) {
      const a = botSideAction(this.viewFor(p.id), Math.random, optsFor(p.id));
      if (a && this.act(p.id, a).ok) {
        this.maybeChat(p, a);
        return;
      }
    }
    const turnId = s.phase === 'placement' ? placementPlayer(s) : currentPlayer(s);
    if (!turnId || !bots.some((b) => b.id === turnId)) return;
    const p = this.players.find((x) => x.id === turnId)!;
    let a = botTurnAction(this.viewFor(turnId), s.order.indexOf(turnId), Math.random, optsFor(turnId));
    if (!a) {
      // 교환 제안에 사람이 답하기를 기다리는 중. 너무 오래 걸리면 턴을 넘긴다.
      this.idle += 1;
      if (this.idle < 10) return this.scheduleBot();
      a = { type: 'end_turn' };
    }
    this.idle = 0;
    const res = a.type === 'roll' ? this.roll(turnId, a) : this.act(turnId, a, Math.random);
    // 봇이 고른 수가 막히면 (규칙이 바뀌었을 때 등) 턴을 넘겨 멈추지 않게 한다.
    if (!res.ok && s.phase === 'playing' && s.step === 'main') this.act(turnId, { type: 'end_turn' });
    else this.maybeChat(p, a);
  }

  /** 봇이 가끔 이모티콘·한마디를 남긴다 (이름 옆 이모티콘, 채팅 목록 확인용) */
  private maybeChat(p: LabPlayer, a: GameAction): void {
    const roll = Math.random();
    if (a.type === 'trade_accept' && roll < 0.5) this.emote(p.id, '🤝');
    else if ((a.type === 'build_city' || a.type === 'build_village') && roll < 0.5) this.emote(p.id, '🎉');
    else if (a.type === 'move_robber' && roll < 0.4) this.say(p.id, '미안해요, 동상 좀 옮길게요.');
  }

  say(from: string, text: string): void {
    const p = this.players.find((x) => x.id === from)!;
    this.chatSeq += 1;
    this.onChat?.({ id: this.chatSeq, from, nickname: p.nickname, colorIndex: p.colorIndex, text, at: Date.now() });
  }

  emote(from: string, emote: string): void {
    this.onEmote?.({ from, emote, at: Date.now() });
  }

  ping(from: string, kind: ChatPing['kind'], target: string): void {
    this.pingSeq += 1;
    this.onPing?.({ id: this.pingSeq, from, kind, target, at: Date.now() });
  }

  /** 서버의 ChatHub.brag 처럼 가진 달성만 뽐낸다 (간격은 화면이 센다). */
  brag(from: string, award: ChatBrag['award']): AckResult {
    const held = award === 'longest_road' ? this.state.longestRoad : this.state.largestArmy;
    if (held.holder !== from) return { ok: false, error: '가지고 있는 달성만 자랑할 수 있습니다.', code: 'BRAG_NOT_HOLDER' };
    const size = 'length' in held ? held.length : held.size;
    this.onBrag?.({ from, award, size, at: Date.now() });
    return { ok: true };
  }
}
