// 고르게 굴리는 주사위 (src/shared/fairDice.ts)
import { describe, expect, it } from 'vitest';
import { numberPips } from '../src/shared/constants';
import { RESHUFFLE_AT, drawFairDice, newFairDice, recordProduction } from '../src/shared/fairDice';
import { autoPlay, createGame } from '../src/shared/rules';
import { RoomManager } from '../src/server/rooms';
import { restoreRooms, snapshotRooms } from '../src/server/persist';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLAYERS = ['a', 'b', 'c', 'd'];
const nobody = () => [] as string[];

/** 그냥 굴리기 */
function plainRoll(random: () => number): number {
  return 2 + Math.floor(random() * 6) + Math.floor(random() * 6);
}

describe('고르게 굴리는 주사위', () => {
  it('숫자마다 나오는 횟수가 확률(점 개수)에 가깝다', () => {
    const st = newFairDice(PLAYERS);
    const random = seeded(1);
    const count: Record<number, number> = {};
    const n = 3600;
    for (let i = 0; i < n; i++) {
      const [a, b] = drawFairDice(st, PLAYERS[i % 4], PLAYERS, nobody, random);
      expect(a >= 1 && a <= 6 && b >= 1 && b <= 6).toBe(true);
      count[a + b] = (count[a + b] ?? 0) + 1;
      recordProduction(st, PLAYERS, () => true);
    }
    for (let t = 2; t <= 12; t++) {
      const want = (n * numberPips(t)) / 36;
      expect(Math.abs(count[t] - want)).toBeLessThan(want * 0.15 + 8);
    }
  });

  it('짧은 판에서도 고르다: 30번 굴리면 숫자마다 확률에서 많이 벗어나지 않는다 (그냥 굴리기보다 고르다)', () => {
    let fairErr = 0;
    let plainErr = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const st = newFairDice(PLAYERS);
      const r1 = seeded(seed);
      const r2 = seeded(seed + 1000);
      const fair: Record<number, number> = {};
      const plain: Record<number, number> = {};
      for (let i = 0; i < 30; i++) {
        const [a, b] = drawFairDice(st, PLAYERS[i % 4], PLAYERS, nobody, r1);
        fair[a + b] = (fair[a + b] ?? 0) + 1;
        const p = plainRoll(r2);
        plain[p] = (plain[p] ?? 0) + 1;
        recordProduction(st, PLAYERS, () => true);
      }
      for (let t = 2; t <= 12; t++) {
        const want = (30 * numberPips(t)) / 36;
        fairErr += Math.abs((fair[t] ?? 0) - want);
        plainErr += Math.abs((plain[t] ?? 0) - want);
      }
    }
    expect(fairErr).toBeLessThan(plainErr * 0.75);
  });

  it('같은 숫자가 바로 이어서 나오는 일이 그냥 굴리기보다 적다', () => {
    const st = newFairDice(PLAYERS);
    const r1 = seeded(7);
    const r2 = seeded(8);
    let fairRepeat = 0;
    let plainRepeat = 0;
    let lastF = 0;
    let lastP = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const [a, b] = drawFairDice(st, PLAYERS[i % 4], PLAYERS, nobody, r1);
      if (a + b === lastF) fairRepeat++;
      lastF = a + b;
      const p = plainRoll(r2);
      if (p === lastP) plainRepeat++;
      lastP = p;
      recordProduction(st, PLAYERS, () => true);
    }
    expect(fairRepeat).toBeLessThan(plainRepeat * 0.7);
  });

  it('7 이 한 사람에게 몰리지 않는다: 사람마다 굴린 7 의 차가 그냥 굴리기보다 작다', () => {
    let fairSpread = 0;
    let plainSpread = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const st = newFairDice(PLAYERS);
      const r1 = seeded(seed);
      const r2 = seeded(seed + 500);
      const plain: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
      for (let i = 0; i < 80; i++) {
        const who = PLAYERS[i % 4];
        drawFairDice(st, who, PLAYERS, nobody, r1);
        recordProduction(st, PLAYERS, () => true);
        if (plainRoll(r2) === 7) plain[who] += 1;
      }
      const spread = (m: Record<string, number>) => Math.max(...PLAYERS.map((p) => m[p])) - Math.min(...PLAYERS.map((p) => m[p]));
      fairSpread += spread(st.sevens);
      plainSpread += spread(plain);
    }
    expect(fairSpread).toBeLessThan(plainSpread * 0.75);
  });

  it('오래 자원을 못 받은 사람의 숫자가 조금 더 잘 나온다 (가장 긴 가뭄이 줄어든다)', () => {
    // d 는 2·12 칸에만 마을이 있다고 친다. 나머지는 모든 숫자에서 받는다.
    const producers = (t: number) => (t === 2 || t === 12 ? ['a', 'b', 'c', 'd'] : ['a', 'b', 'c']);
    let fairLongest = 0;
    let plainLongest = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const st = newFairDice(PLAYERS);
      const r1 = seeded(seed);
      const r2 = seeded(seed + 900);
      let dryF = 0;
      let dryP = 0;
      let maxF = 0;
      let maxP = 0;
      for (let i = 0; i < 120; i++) {
        const [a, b] = drawFairDice(st, PLAYERS[i % 4], PLAYERS, producers, r1);
        const got = producers(a + b);
        recordProduction(st, PLAYERS, (id) => a + b !== 7 && got.includes(id));
        dryF = got.includes('d') && a + b !== 7 ? 0 : dryF + 1;
        maxF = Math.max(maxF, dryF);
        const p = plainRoll(r2);
        dryP = p === 2 || p === 12 ? 0 : dryP + 1;
        maxP = Math.max(maxP, dryP);
      }
      fairLongest += maxF;
      plainLongest += maxP;
    }
    expect(fairLongest).toBeLessThan(plainLongest * 0.9);
  });

  it('남은 카드가 정한 장수(RESHUFFLE_AT)보다 적어지면 새 벌로 바꾼다', () => {
    const st = newFairDice(PLAYERS);
    const random = seeded(3);
    for (let i = 0; i < 36 - RESHUFFLE_AT + 1; i++) drawFairDice(st, 'a', PLAYERS, nobody, random);
    expect(st.deck.length).toBe(RESHUFFLE_AT - 1);
    drawFairDice(st, 'a', PLAYERS, nobody, random);
    expect(st.deck.length).toBe(35);
  });
});

describe('게임과 방', () => {
  it('고르게 굴리기로 여러 턴을 진행해도 규칙대로 흘러가고 기록이 쌓인다', () => {
    const random = seeded(11);
    const s = createGame(['a', 'b', 'c'], random, { diceMode: 'balanced' });
    expect(s.fairDice?.deck).toHaveLength(36);
    for (let i = 0; i < 600 && s.phase !== 'finished'; i++) autoPlay(s, random);
    expect(s.turn).toBeGreaterThan(20);
    const rolls = s.events.filter((e) => e.kind === 'roll');
    expect(rolls.length).toBeGreaterThan(10);
    expect(Object.values(s.fairDice!.sevens).reduce((n, x) => n + x, 0)).toBe(rolls.filter((e) => e.kind === 'roll' && e.dice[0] + e.dice[1] === 7).length);
    // 그냥 굴리기는 기록을 두지 않는다
    expect(createGame(['a', 'b'], random).fairDice).toBeNull();
  });

  it('방은 기본이 고르게이고 방장이 바꿀 수 있으며, 예전 저장 게임은 그냥 굴리기로 이어 간다', () => {
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const { room, player } = made;
    expect(room.diceMode).toBe('balanced');
    expect(m.setSettings(room, player.id, { diceMode: 'loaded' as never })).not.toBeNull();
    expect(m.setSettings(room, player.id, { diceMode: 'random' })).toBeNull();
    expect(room.diceMode).toBe('random');
    expect(m.setSettings(room, player.id, { diceMode: 'balanced' })).toBeNull();
    const joined = m.join(room.code, '손님');
    if ('error' in joined) throw new Error(joined.error);
    for (const p of room.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(room, player.id)).toBeNull();
    expect(room.game!.diceMode).toBe('balanced');
    m.stopAllClocks();
    const data = JSON.parse(snapshotRooms(m.rooms.values()));
    expect(restoreRooms(JSON.stringify(data)).rooms[0].game!.fairDice?.deck).toHaveLength(36);
    delete data.rooms[0].diceMode;
    delete data.rooms[0].game.diceMode;
    delete data.rooms[0].game.fairDice;
    const back = restoreRooms(JSON.stringify(data)).rooms[0];
    expect(back.diceMode).toBe('balanced');
    expect(back.game!.diceMode).toBe('random');
    expect(back.game!.fairDice).toBeNull();
  });
});
