// 최강 기사단 사열의 박자 (3D 보드 움직임과 효과음이 같이 쓴다)
import { describe, expect, it } from 'vitest';
import { PARADE_LOWER_MS, paradeTiming } from '../src/client/board/parade';

describe('광장 사열 박자', () => {
  it('줄이 다 들어선 뒤 경례하고, 칼을 내리고 제자리걸음을 한 뒤 사라진다', () => {
    for (const golden of [false, true]) {
      const t = paradeTiming(golden);
      const lastRank = t.start + (t.ranks - 1) * t.gap;
      expect(t.salute).toBeGreaterThan(lastRank + 280);
      expect(t.lower).toBeGreaterThan(t.salute + 320);
      expect(t.fade).toBeGreaterThanOrEqual(t.lower + PARADE_LOWER_MS + t.step * 2);
      expect(t.end).toBeGreaterThan(t.fade);
      expect(t.ranks * t.files).toBe(12);
    }
  });

  it('황금 기사단은 경례를 더 오래 하고, 둘 다 5초 안에 끝난다', () => {
    const plain = paradeTiming(false);
    const golden = paradeTiming(true);
    expect(golden.lower - golden.salute).toBeGreaterThan(plain.lower - plain.salute);
    expect(plain.end).toBeLessThanOrEqual(5000);
    expect(golden.end).toBeLessThanOrEqual(5000);
  });
});
