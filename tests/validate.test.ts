import { describe, expect, it } from 'vitest';
import { normalizeNickname, normalizeRoomCode, parseAction } from '../src/shared/validate';

// 보이지 않는 글자는 소스에 그대로 쓰지 않고 코드 포인트로 만든다.
const ch = (...cps: number[]) => String.fromCodePoint(...cps);

describe('닉네임 정리', () => {
  it('앞뒤 공백과 연속 공백을 정리하고 1~12자만 받는다', () => {
    expect(normalizeNickname('  강  나루  ')).toBe('강 나루');
    expect(normalizeNickname('')).toBeNull();
    expect(normalizeNickname('   ')).toBeNull();
    expect(normalizeNickname('가'.repeat(12))).toBe('가'.repeat(12));
    expect(normalizeNickname('가'.repeat(13))).toBeNull();
    expect(normalizeNickname(42)).toBeNull();
  });

  it('한글 채움 문자처럼 보이지 않는 글자만으로 된 이름은 받지 않는다', () => {
    for (const cp of [0x3164, 0x115f, 0x1160, 0xffa0, 0x2800, 0x00ad, 0x180e, 0x200b, 0xfeff, 0x2028]) {
      expect(normalizeNickname(ch(cp)), `U+${cp.toString(16)}`).toBeNull();
      expect(normalizeNickname(ch(cp, cp, cp)), `U+${cp.toString(16)} x3`).toBeNull();
    }
  });

  it('보이지 않는 글자를 붙여 같은 이름처럼 보이게 만들 수 없다', () => {
    expect(normalizeNickname(`강나루${ch(0x00ad)}`)).toBe('강나루');
    expect(normalizeNickname(`강${ch(0x200b)}나루${ch(0x3164)}`)).toBe('강나루');
    expect(normalizeNickname(`강나루${ch(0xfe0f)}`)).toBe('강나루');
  });

  it('조합형(NFD) 한글도 완성형과 같은 이름이 된다', () => {
    const nfd = '강나루'.normalize('NFD');
    expect(nfd).not.toBe('강나루');
    expect(normalizeNickname(nfd)).toBe('강나루');
  });
});

describe('입력 형식 검사', () => {
  it('방 코드는 헷갈리는 글자 없이 4자리', () => {
    expect(normalizeRoomCode(' 6qk8 ')).toBe('6QK8');
    expect(normalizeRoomCode('6QK')).toBeNull();
    expect(normalizeRoomCode('6QK0')).toBeNull(); // 0 은 쓰지 않는다
    expect(normalizeRoomCode(null)).toBeNull();
  });

  it('행동 요청의 형식이 틀리면 null', () => {
    expect(parseAction({ type: 'build_village', vertexId: 'v1' })).toEqual({ type: 'build_village', vertexId: 'v1' });
    expect(parseAction({ type: 'build_road', edgeId: 'e1', extra: 1 })).toEqual({ type: 'build_road', edgeId: 'e1' });
    expect(parseAction({ type: 'place', vertexId: 'v1' })).toBeNull(); // 시작 배치는 마을과 길을 함께 보낸다
    expect(parseAction({ type: 'build_city', vertexId: 'constructor' })).toBeNull();
    expect(parseAction({ type: 'deliver', contractId: '__proto__' })).toBeNull();
    expect(parseAction({ type: 'market', give: 'gold', get: 'wood' })).toBeNull();
    expect(parseAction({ type: 'trade_propose', to: 'x', give: { wood: 1.5 }, get: { grain: 1 } })).toBeNull();
    expect(parseAction({ type: 'trade_accept', tradeId: -1 })).toBeNull();
    // 모두에게 제안(to 없음), 확정, 은행 묶음 교환
    expect(parseAction({ type: 'trade_propose', give: { wood: 1 }, get: { grain: 1 } })).toEqual({
      type: 'trade_propose',
      give: { wood: 1, grain: 0, wool: 0, brick: 0, stone: 0 },
      get: { wood: 0, grain: 1, wool: 0, brick: 0, stone: 0 },
    });
    expect(parseAction({ type: 'trade_propose', to: 7, give: { wood: 1 }, get: { grain: 1 } })).toBeNull();
    expect(parseAction({ type: 'trade_confirm', tradeId: 3, with: 'p2' })).toEqual({ type: 'trade_confirm', tradeId: 3, with: 'p2' });
    expect(parseAction({ type: 'trade_confirm', tradeId: 3 })).toBeNull();
    expect(parseAction({ type: 'bank_trade', give: 'wood', get: 'stone' })).toBeNull();
    expect(parseAction({ type: 'bank_trade', give: { wood: 8 }, get: { stone: 2 } })).toMatchObject({ type: 'bank_trade', give: { wood: 8 }, get: { stone: 2 } });
    expect(parseAction({ type: 'nope' })).toBeNull();
    expect(parseAction([1, 2])).toBeNull();
  });
});
