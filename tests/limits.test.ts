// 방장이 정하는 길·마을·도시 개수와 발전 카드 종류별 장수
import { describe, expect, it } from 'vitest';
import { DEV_DECK, PIECE_LIMIT, devDeckFor, emptyBundle, normalizeDevMix, normalizePieceLimits } from '../src/shared/constants';
import { boardOf } from '../src/shared/board';
import { applyAction, autoPlay, buildableRoads, createGame, currentPlayer, pieceLimit, upgradableVillages } from '../src/shared/rules';
import { RoomManager } from '../src/server/rooms';
import { restoreRooms, snapshotRooms } from '../src/server/persist';
import { buildRoomView } from '../src/server/view';

function seeded(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

describe('값 확인', () => {
  it('길·마을·도시 개수는 정해진 범위 안의 정수만 받는다', () => {
    expect(normalizePieceLimits({ road: 20, village: 6, city: 5 })).toEqual({ road: 20, village: 6, city: 5 });
    expect(normalizePieceLimits({ road: 4, village: 5, city: 4 })).toBeNull();
    expect(normalizePieceLimits({ road: 15, village: 16, city: 4 })).toBeNull();
    expect(normalizePieceLimits({ road: 15, village: 5, city: 0 })).toBeNull();
    expect(normalizePieceLimits({ road: 15, village: 5 })).toBeNull();
    expect(normalizePieceLimits({ road: 15.5, village: 5, city: 4 })).toBeNull();
  });

  it('발전 카드는 종류마다 0~30장, 모두 합쳐 1~50장이다', () => {
    expect(normalizeDevMix({ ...DEV_DECK, knight: 0 })).toEqual({ ...DEV_DECK, knight: 0 });
    expect(normalizeDevMix({ knight: 0, victory: 0, road_building: 0, year_of_plenty: 0, monopoly: 0 })).toBeNull();
    expect(normalizeDevMix({ ...DEV_DECK, knight: 31 })).toBeNull();
    expect(normalizeDevMix({ knight: 30, victory: 21, road_building: 0, year_of_plenty: 0, monopoly: 0 })).toBeNull();
    expect(normalizeDevMix({ ...DEV_DECK, monopoly: -1 })).toBeNull();
  });
});

describe('게임 규칙', () => {
  it('정한 길·도시 개수를 넘으면 지을 수 없다', () => {
    const s = createGame(['a', 'b'], seeded(7), { rollForOrder: false, pieceLimits: { road: 5, village: 2, city: 1 } });
    for (let i = 0; i < 20 && s.phase === 'placement'; i++) autoPlay(s, seeded(i + 1));
    expect(s.phase).toBe('playing');
    s.step = 'main';
    const p = currentPlayer(s)!;
    expect(pieceLimit(s, 'road')).toBe(5);
    s.players[p].resources = { ...emptyBundle(), wood: 20, brick: 20, grain: 20, stone: 20 };
    // 시작 배치로 길 2개가 있으니 3개 더 지을 수 있다.
    for (let i = 0; i < 3; i++) {
      const edge = buildableRoads(boardOf(s), s.buildings, s.roads, p)[0];
      expect(applyAction(s, p, { type: 'build_road', edgeId: edge }).ok).toBe(true);
    }
    const more = buildableRoads(boardOf(s), s.buildings, s.roads, p)[0];
    const r = applyAction(s, p, { type: 'build_road', edgeId: more });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('LIMIT');
      expect(r.message).toContain('최대 5개');
    }
    // 도시는 1개까지
    const villages = upgradableVillages(s.buildings, p);
    expect(applyAction(s, p, { type: 'build_city', vertexId: villages[0] }).ok).toBe(true);
    const again = applyAction(s, p, { type: 'build_city', vertexId: upgradableVillages(s.buildings, p)[0] });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('LIMIT');
  });

  it('종류별 장수를 주면 그 구성으로 발전 카드 더미를 만든다', () => {
    const mix = { knight: 0, victory: 3, road_building: 0, year_of_plenty: 1, monopoly: 0 };
    const s = createGame(['a', 'b'], seeded(3), { devMix: mix });
    expect(s.devDeck).toHaveLength(4);
    expect(s.devDeck.filter((k) => k === 'victory')).toHaveLength(3);
    expect(s.devDeck.filter((k) => k === 'year_of_plenty')).toHaveLength(1);
    expect(s.devDeck.includes('knight')).toBe(false);
    expect(() => createGame(['a', 'b'], seeded(3), { devMix: { ...mix, victory: 0, year_of_plenty: 0 } })).toThrow();
    expect(() => createGame(['a', 'b'], seeded(3), { pieceLimits: { road: 3, village: 5, city: 4 } })).toThrow();
  });

  it('정하지 않으면 기본 개수다', () => {
    const s = createGame(['a', 'b'], seeded(5));
    expect(s.pieceLimits).toEqual(PIECE_LIMIT);
    expect(pieceLimit(s, 'village')).toBe(5);
    expect(pieceLimit({ unlimited: true, pieceLimits: { road: 5, village: 2, city: 1 } }, 'road')).toBe(Infinity);
  });
});

describe('방 설정', () => {
  function room() {
    const m = new RoomManager();
    const made = m.create('방장');
    if ('error' in made) throw new Error(made.error);
    const j = m.join(made.room.code, '손님');
    if ('error' in j) throw new Error(j.error);
    return { m, room: made.room, host: made.player };
  }

  it('방장이 개수와 종류별 장수를 바꾸고, 게임에 그대로 들어간다', () => {
    const { m, room: r, host } = room();
    expect(r.pieceLimits).toEqual(PIECE_LIMIT);
    expect(r.devMix).toBeNull();
    let v = buildRoomView(r, host.id);
    expect(v.devMix).toEqual(devDeckFor(r.devCards));
    expect(v.devMixCustom).toBe(false);

    expect(m.setSettings(r, host.id, { pieceLimits: { road: 4, village: 5, city: 4 } })).not.toBeNull();
    expect(m.setSettings(r, host.id, { pieceLimits: { road: 20, village: 7, city: 6 } })).toBeNull();
    const mix = { knight: 10, victory: 4, road_building: 3, year_of_plenty: 3, monopoly: 0 };
    expect(m.setSettings(r, host.id, { devMix: { ...mix, knight: 40 } })).not.toBeNull();
    expect(m.setSettings(r, host.id, { devMix: mix })).toBeNull();
    v = buildRoomView(r, host.id);
    expect(v.pieceLimits).toEqual({ road: 20, village: 7, city: 6 });
    expect(v.devMix).toEqual(mix);
    expect(v.devMixCustom).toBe(true);
    expect(v.devCards).toBe(20);

    for (const p of r.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(r, host.id)).toBeNull();
    const g = r.game!;
    expect(g.pieceLimits).toEqual({ road: 20, village: 7, city: 6 });
    expect(g.devDeck).toHaveLength(20);
    expect(g.devDeck.includes('monopoly')).toBe(false);
    m.stopAllClocks();
  });

  it('총 장수를 바꾸면 종류별로 정한 것이 풀리고 기본 비율로 나눈다', () => {
    const { m, room: r, host } = room();
    expect(m.setSettings(r, host.id, { devMix: { knight: 1, victory: 1, road_building: 1, year_of_plenty: 1, monopoly: 1 } })).toBeNull();
    expect(m.setSettings(r, host.id, { devCards: 30 })).toBeNull();
    expect(r.devMix).toBeNull();
    expect(buildRoomView(r, host.id).devMix).toEqual(devDeckFor(30));
  });

  it('저장했다 되살려도 남고, 예전 파일은 기본값으로 되살린다', () => {
    const { m, room: r, host } = room();
    expect(m.setSettings(r, host.id, { pieceLimits: { road: 10, village: 3, city: 2 }, devMix: { ...DEV_DECK, knight: 5 } })).toBeNull();
    for (const p of r.players) {
      p.connected = true;
      p.ready = true;
    }
    expect(m.start(r, host.id)).toBeNull();
    m.stopAllClocks();
    const data = JSON.parse(snapshotRooms(m.rooms.values()));
    const back = restoreRooms(JSON.stringify(data)).rooms[0];
    expect(back.pieceLimits).toEqual({ road: 10, village: 3, city: 2 });
    expect(back.devMix).toEqual({ ...DEV_DECK, knight: 5 });
    expect(back.game!.pieceLimits).toEqual({ road: 10, village: 3, city: 2 });
    delete data.rooms[0].pieceLimits;
    delete data.rooms[0].devMix;
    delete data.rooms[0].game.pieceLimits;
    const old = restoreRooms(JSON.stringify(data)).rooms[0];
    expect(old.pieceLimits).toEqual(PIECE_LIMIT);
    expect(old.devMix).toBeNull();
    expect(old.game!.pieceLimits).toEqual(PIECE_LIMIT);
  });
});
