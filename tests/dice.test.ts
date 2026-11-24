// 주사위 굴림 계산: 어떻게 던져도 상자 안에서 면을 바닥에 대고 멈추고, 눈 방향을 바꾸면 원하는 값이 위로 온다.
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  CUBE_ROTATIONS,
  DIE_HALF,
  FACE_NORMALS,
  FACE_VALUE,
  faceCorrection,
  planBlends,
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
    // 너무 오래 구르지 않는다: 평균 2초 안, 가장 길어도 2.7초 안 (던진 뒤 서버 값을 기다리는 틈을 더해도 3초 안에 합계가 보인다).
    expect(total / N).toBeLessThan(2.2);
    expect(longest).toBeLessThan(2.7);
  });

  it('값을 알고 던지면 자리 위에서 던져도 던진 직후에 눈 방향을 다 맞추고, 멈춘 뒤 뒤집지 않는다', () => {
    const rand = rng(11);
    let needed = 0;
    for (let k = 0; k < 60; k++) {
      // 반은 던지기 자리 바닥에서(버튼·시간 끝), 반은 들어 올린 높이에서 던진다.
      const starts = randomThrow(rand);
      if (k % 2) for (const s of starts) s.pos.y = DIE_HALF;
      const rec = simulate(starts, walls);
      const values = [1 + Math.floor(rand() * 6), 1 + Math.floor(rand() * 6)];
      const fixes = values.map((v, d) => faceCorrection(rec.top[d], v));
      const plan = planBlends(rec, fixes, 0.02, walls);
      for (let d = 0; d < 2; d++) {
        const win = plan[d];
        if (Math.abs(fixes[d].w) > 0.9999) {
          expect(win).toBeNull();
          continue;
        }
        needed++;
        expect(win).not.toBe('none');
        // 바닥에 닿아 구르기 전, 던진 직후에 끝난다.
        expect((win as [number, number])[1]).toBeLessThan(0.6);
        // 섞기가 끝난 뒤 멈춘 자세에서 서버 값이 위를 본다.
        const p = new Vector3();
        const q = new Quaternion();
        sampleRecording(rec, d, rec.duration, p, q);
        expect(FACE_VALUE[topFace(q.multiply(fixes[d]))]).toBe(values[d]);
      }
    }
    expect(needed).toBeGreaterThan(60);
  });

  it('값이 조금 늦게 와도(던지고 0.15초 뒤) 아직 구르는 동안 맞출 구간을 찾는다', () => {
    const rand = rng(23);
    let needed = 0;
    let late = 0;
    for (let k = 0; k < 40; k++) {
      const rec = simulate(randomThrow(rand), walls);
      const fixes = [0, 1].map((d) => faceCorrection(rec.top[d], ((rec.top[d] + 2) % 6) + 1));
      const plan = planBlends(rec, fixes, 0.15, walls);
      for (let d = 0; d < 2; d++) {
        if (Math.abs(fixes[d].w) > 0.9999) continue;
        needed++;
        if (plan[d] === 'none') late++;
      }
    }
    expect(needed).toBeGreaterThan(40);
    expect(late).toBeLessThanOrEqual(1);
  });
});
