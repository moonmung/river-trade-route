// 주사위 굴림 계산: 어떻게 던져도 상자 안에서 면을 바닥에 대고 멈추고, 눈 방향을 바꾸면 원하는 값이 위로 온다.
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  CUBE_ROTATIONS,
  DIE_HALF,
  FACE_NORMALS,
  FACE_VALUE,
  faceCorrection,
  freeWindow,
  sampleRecording,
  simulate,
  topFace,
  type BodyStart,
  type Wall,
} from '../src/client/dice/physics';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const box = { left: -3.6, right: 3.6, far: -4.5, near: 2.6 };
const walls: Wall[] = [
  { n: new Vector3(0, 1, 0), d: 0, bounce: 0.35, friction: 0.55 },
  { n: new Vector3(1, 0, 0), d: box.left, bounce: 0.5, friction: 0.2 },
  { n: new Vector3(-1, 0, 0), d: -box.right, bounce: 0.5, friction: 0.2 },
  { n: new Vector3(0, 0, 1), d: box.far, bounce: 0.5, friction: 0.2 },
  { n: new Vector3(0, 0, -1), d: -box.near, bounce: 0.5, friction: 0.2 },
];

function randomThrow(rand: () => number): BodyStart[] {
  const angle = (rand() - 0.5) * 1.2;
  const dir = new Vector3(Math.sin(angle), 0, -Math.cos(angle));
  return [-0.9, 0.9].map((x) => {
    const speed = 7 + rand() * 10;
    const axis = new Vector3(0, 1, 0).cross(dir).normalize();
    const spin = axis.multiplyScalar(12 + rand() * 10).add(new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(14));
    const q = new Quaternion().setFromAxisAngle(new Vector3(rand(), rand(), rand()).normalize(), rand() * Math.PI * 2);
    return { pos: new Vector3(x, 1.1, 1.6), quat: q, vel: dir.clone().multiplyScalar(speed).setY(3.5 + rand() * 2.5).add(new Vector3(x * 0.8, 0, 0)), spin };
  });
}

describe('주사위 굴림 계산', () => {
  it('정육면체 대칭 회전은 24가지다', () => {
    expect(CUBE_ROTATIONS.length).toBe(24);
  });

  it('눈 방향 회전을 붙이면 원하는 값이 위로 온다', () => {
    for (let top = 0; top < 6; top++) {
      for (let value = 1; value <= 6; value++) {
        const r = faceCorrection(top, value);
        // 계산 자세가 top 면을 위로 둔다면, 화면 자세(계산 × r)에서 value 면이 위를 본다.
        const sim = new Quaternion().setFromUnitVectors(FACE_NORMALS[top], new Vector3(0, 1, 0));
        const shown = sim.clone().multiply(r);
        expect(FACE_VALUE[topFace(shown)]).toBe(value);
      }
    }
  });

  it('어떻게 던져도 상자 안에서 면을 대고 멈춘다', () => {
    const rand = rng(7);
    let longest = 0;
    let total = 0;
    const N = 80;
    for (let k = 0; k < N; k++) {
      const rec = simulate(randomThrow(rand), walls);
      longest = Math.max(longest, rec.duration);
      total += rec.duration;
      const p = new Vector3();
      const q = new Quaternion();
      const ends: Vector3[] = [];
      for (let d = 0; d < 2; d++) {
        sampleRecording(rec, d, rec.duration, p, q);
        expect(p.y).toBeCloseTo(DIE_HALF, 3);
        expect(p.x).toBeGreaterThan(box.left);
        expect(p.x).toBeLessThan(box.right);
        expect(p.z).toBeGreaterThan(box.far);
        expect(p.z).toBeLessThan(box.near);
        const up = FACE_NORMALS[topFace(q)].clone().applyQuaternion(q);
        expect(up.y).toBeGreaterThan(0.9999);
        expect(rec.top[d]).toBe(topFace(q));
        ends.push(p.clone());
      }
      // 두 주사위가 겹쳐 멈추지 않는다.
      expect(ends[0].distanceTo(ends[1])).toBeGreaterThan(0.97);
    }
    // 너무 오래 구르지 않는다 (평균 3초 안, 가장 길어도 5초 안).
    expect(total / N).toBeLessThan(3);
    expect(longest).toBeLessThan(5.2);
  });

  it('던진 직후 공중에 뜬 구간이 있어 늦게 온 값도 섞을 수 있다', () => {
    const rand = rng(11);
    let found = 0;
    for (let k = 0; k < 40; k++) {
      const rec = simulate(randomThrow(rand), walls);
      for (let d = 0; d < 2; d++) if (freeWindow(rec, d, 0.05)) found++;
    }
    expect(found).toBeGreaterThan(70);
  });
});
