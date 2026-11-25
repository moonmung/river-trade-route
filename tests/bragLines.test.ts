// 자랑하기 한마디: 종류마다 10가지, 누를 때마다 다른 줄이 나온다
import { describe, expect, it } from 'vitest';
import { BRAG_LINE_COUNT } from '../src/shared/constants';
import { BRAG_LINES, bragLine, nextBragLine } from '../src/client/ui/bragLines';

describe('자랑 한마디', () => {
  it('승리·최장 교역로·최강 기사단마다 서로 다른 한마디가 10가지씩 있다', () => {
    for (const lines of Object.values(BRAG_LINES)) {
      expect(lines).toHaveLength(BRAG_LINE_COUNT);
      expect(new Set(lines).size).toBe(BRAG_LINE_COUNT);
    }
    expect(bragLine('victory', 99)).toBe(BRAG_LINES.victory[0]);
  });

  it('누를 때마다 바로 앞과 다른 줄이 나오고, 열 번 안에 열 가지가 모두 나온다', () => {
    let prev = -1;
    for (let round = 0; round < 5; round++) {
      const seen = new Set<number>();
      for (let i = 0; i < BRAG_LINE_COUNT; i++) {
        const line = nextBragLine('largest_army');
        expect(line).not.toBe(prev);
        expect(line).toBeGreaterThanOrEqual(0);
        expect(line).toBeLessThan(BRAG_LINE_COUNT);
        seen.add(line);
        prev = line;
      }
      expect(seen.size).toBe(BRAG_LINE_COUNT);
    }
  });
});
