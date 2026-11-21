// 주사위 두 개의 굴림을 던지는 순간 끝까지 미리 계산한다 (강체 충돌 + 마찰, 고정 시간 간격).
// 화면은 이 기록을 시간에 맞춰 재생만 한다. 같은 입력이면 늘 같은 궤적이 나온다.
//
// 윗면 맞추기: 정육면체는 90° 단위로 돌려도 모양이 같다. 그래서 계산이 끝난 뒤 윗면 눈이 서버 값과 다르면
// 주사위 몸체는 그대로 두고 "눈을 그린 방향"만 정육면체 대칭 회전 r 로 바꿔 붙이면 된다 (화면 자세 = 계산 자세 × r).
// 값이 던진 뒤에 도착하면 r 을 공중에 떠 있는(아무것도 닿지 않는) 짧은 구간에서 서서히 섞는다.
import { Matrix4, Quaternion, Vector3 } from 'three';

/** 주사위 한 변 (세계 단위) */
export const DIE_SIZE = 1;
export const DIE_HALF = DIE_SIZE / 2;
/** 모서리를 둥글린 반지름 */
export const DIE_ROUND = 0.13;
/** 꼭짓점 구의 중심 (안쪽 상자의 반 변) */
const CORE = DIE_HALF - DIE_ROUND;
/** 중심에서 꼭짓점까지 (이만큼 떨어져 있으면 어떻게 돌아도 닿지 않는다) */
export const DIE_HALF_DIAG = Math.sqrt(3) * DIE_HALF;

/** 면 순서는 BoxGeometry 재질 묶음 순서와 같다: +x, -x, +y, -y, +z, -z */
export const FACE_NORMALS: readonly Vector3[] = [
  new Vector3(1, 0, 0),
  new Vector3(-1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, -1, 0),
  new Vector3(0, 0, 1),
  new Vector3(0, 0, -1),
];
/** 면마다 그린 눈 (마주 보는 면의 합이 7) */
export const FACE_VALUE: readonly number[] = [2, 5, 1, 6, 3, 4];

const UP = new Vector3(0, 1, 0);

/** 벽·바닥: n·p ≥ d 쪽이 안쪽 */
export interface Wall {
  n: Vector3;
  d: number;
  /** 튀는 정도 */
  bounce: number;
  /** 마찰 */
  friction: number;
}

export interface BodyStart {
  pos: Vector3;
  quat: Quaternion;
  vel: Vector3;
  /** 세계 좌표 각속도 (rad/s) */
  spin: Vector3;
}

export interface Impact {
  t: number;
  die: number;
  /** 부딪힌 속도 */
  speed: number;
}

export interface Recording {
  /** 기록 간격 (초) */
  dt: number;
  count: number;
  dice: number;
  /** 프레임 × 주사위 × (x, y, z, qx, qy, qz, qw) */
  poses: Float32Array;
  /** 프레임 × 주사위: 1 이면 그 순간 아무 데도 닿지 않을 만큼 떠 있다 (눈 방향을 바꿔도 티가 나지 않는다) */
  free: Uint8Array;
  impacts: Impact[];
  /** 계산대로 멈췄을 때 위를 보는 면 (FACE_NORMALS 순번) */
  top: number[];
  /** 마지막 자세까지 걸린 시간 (초) */
  duration: number;
}

export const GRAVITY = 44;
const STEP = 1 / 240;
const RECORD_EVERY = 2;
const ITERATIONS = 10;
const MAX_TIME = 5;
const SLOP = 0.004;
/** 이 속도보다 느리게 닿으면 튀지 않는다 (떨림 방지) */
const BOUNCE_MIN = 0.9;
const INV_MASS = 1;
/** 정육면체 관성 모멘트 m·s²/6 의 역수 */
const INV_INERTIA = 6 / (DIE_SIZE * DIE_SIZE);
/** 주사위끼리 */
const PAIR_BOUNCE = 0.45;
const PAIR_FRICTION = 0.25;
/** 마지막 자세로 맞추는 시간 */
const SNAP_TIME = 0.1;

const CORNERS: Vector3[] = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) CORNERS.push(new Vector3(x * CORE, y * CORE, z * CORE));

interface Body {
  pos: Vector3;
  quat: Quaternion;
  vel: Vector3;
  spin: Vector3;
  asleep: boolean;
  calm: number;
  grounded: boolean;
  lastImpact: number;
}

interface Contact {
  a: Body;
  b: Body | null;
  n: Vector3;
  ra: Vector3;
  rb: Vector3 | null;
  kn: number;
  bias: number;
  friction: number;
  jn: number;
  jt: Vector3;
}

const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpC = new Vector3();
const tmpQ = new Quaternion();

function invMassOf(b: Body | null): number {
  return b && !b.asleep ? INV_MASS : 0;
}

function invInertiaOf(b: Body | null): number {
  return b && !b.asleep ? INV_INERTIA : 0;
}

/** 접점에서 a 가 b 에 대해 움직이는 속도 */
function relativeVelocity(c: Contact, out: Vector3): Vector3 {
  out.copy(c.a.spin).cross(c.ra).add(c.a.vel);
  if (c.b && c.rb) {
    tmpC.copy(c.b.spin).cross(c.rb).add(c.b.vel);
    out.sub(tmpC);
  }
  return out;
}

function applyImpulse(c: Contact, j: Vector3): void {
  const a = c.a;
  if (!a.asleep) {
    a.vel.addScaledVector(j, INV_MASS);
    tmpC.copy(c.ra).cross(j);
    a.spin.addScaledVector(tmpC, INV_INERTIA);
  }
  if (c.b && c.rb && !c.b.asleep) {
    c.b.vel.addScaledVector(j, -INV_MASS);
    tmpC.copy(c.rb).cross(j);
    c.b.spin.addScaledVector(tmpC, -INV_INERTIA);
  }
}

/** n 방향으로 밀 때 접점이 느끼는 유효 질량의 역수 */
function effectiveInverse(a: Body, ra: Vector3, b: Body | null, rb: Vector3 | null, n: Vector3): number {
  let k = invMassOf(a) + tmpC.copy(ra).cross(n).lengthSq() * invInertiaOf(a);
  if (b && rb) k += invMassOf(b) + tmpC.copy(rb).cross(n).lengthSq() * invInertiaOf(b);
  return k;
}

function cornerWorld(b: Body, i: number, out: Vector3): Vector3 {
  return out.copy(CORNERS[i]).applyQuaternion(b.quat).add(b.pos);
}

/** a 의 꼭짓점 구가 b 의 둥근 상자에 닿는지. 닿으면 b → a 방향 법선과 접점, 겹친 깊이를 돌려준다. */
function cornerAgainstBox(a: Body, i: number, b: Body): { n: Vector3; p: Vector3; depth: number } | null {
  const corner = cornerWorld(a, i, new Vector3());
  tmpQ.copy(b.quat).invert();
  const local = tmpA.copy(corner).sub(b.pos).applyQuaternion(tmpQ);
  const clamped = tmpB.set(
    Math.max(-CORE, Math.min(CORE, local.x)),
    Math.max(-CORE, Math.min(CORE, local.y)),
    Math.max(-CORE, Math.min(CORE, local.z)),
  );
  const delta = local.clone().sub(clamped);
  let dist = delta.length();
  if (dist > 2 * DIE_ROUND + SLOP) return null;
  let n: Vector3;
  if (dist < 1e-5) {
    // 꼭짓점이 안쪽 상자 안까지 들어왔다: 가장 얕은 축으로 밀어낸다.
    const ax = CORE - Math.abs(local.x);
    const ay = CORE - Math.abs(local.y);
    const az = CORE - Math.abs(local.z);
    if (ax <= ay && ax <= az) n = new Vector3(Math.sign(local.x) || 1, 0, 0);
    else if (ay <= az) n = new Vector3(0, Math.sign(local.y) || 1, 0);
    else n = new Vector3(0, 0, Math.sign(local.z) || 1);
    dist = -Math.min(ax, ay, az);
  } else {
    n = delta.divideScalar(dist);
  }
  n.applyQuaternion(b.quat);
  const depth = 2 * DIE_ROUND - dist;
  const p = corner.addScaledVector(n, -(DIE_ROUND - depth / 2));
  return { n, p, depth };
}

/** 정육면체를 제 모양으로 돌리는 회전 24가지 */
export const CUBE_ROTATIONS: readonly Quaternion[] = (() => {
  const axes = FACE_NORMALS;
  const out: Quaternion[] = [];
  const m = new Matrix4();
  for (const a of axes) {
    for (const b of axes) {
      if (Math.abs(a.dot(b)) > 0.5) continue;
      const c = new Vector3().crossVectors(a, b);
      m.makeBasis(a, b, c);
      out.push(new Quaternion().setFromRotationMatrix(m));
    }
  }
  return out;
})();

/** 자세 q 에서 위를 보는 면 */
export function topFace(q: Quaternion): number {
  let best = 0;
  let bestDot = -Infinity;
  FACE_NORMALS.forEach((n, i) => {
    const d = tmpA.copy(n).applyQuaternion(q).y;
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  });
  return best;
}

/** 위를 보는 면 쪽 축을 정확히 위로 세운 자세 (수평 방향 돌림은 그대로) */
export function levelled(q: Quaternion): Quaternion {
  const face = topFace(q);
  const up = FACE_NORMALS[face].clone().applyQuaternion(q);
  return new Quaternion().setFromUnitVectors(up, UP).multiply(q);
}

/**
 * 계산상 윗면이 simTop 인 주사위가 value 를 보이게 하는 눈 방향 회전 (가장 덜 도는 것).
 * 화면 자세 = 계산 자세 × 이 회전.
 */
export function faceCorrection(simTop: number, value: number): Quaternion {
  const want = FACE_VALUE.indexOf(value);
  if (want < 0 || want === simTop) return new Quaternion();
  const from = FACE_NORMALS[want];
  const to = FACE_NORMALS[simTop];
  let best: Quaternion | null = null;
  for (const r of CUBE_ROTATIONS) {
    if (tmpA.copy(from).applyQuaternion(r).distanceToSquared(to) > 1e-6) continue;
    if (!best || Math.abs(r.w) > Math.abs(best.w)) best = r;
  }
  return (best ?? new Quaternion()).clone();
}

/** 주사위가 벽·바닥·서로에게서 얼마나 떨어져 있어야 눈 방향을 바꿔도 되는지 */
const FREE_MARGIN = 0.06;

export function simulate(starts: readonly BodyStart[], walls: readonly Wall[]): Recording {
  const bodies: Body[] = starts.map((s) => ({
    pos: s.pos.clone(),
    quat: s.quat.clone().normalize(),
    vel: s.vel.clone(),
    spin: s.spin.clone(),
    asleep: false,
    calm: 0,
    grounded: false,
    lastImpact: -1,
  }));
  const dice = bodies.length;
  const frames: number[] = [];
  const free: number[] = [];
  const impacts: Impact[] = [];
  const record = () => {
    for (let i = 0; i < dice; i++) {
      const b = bodies[i];
      frames.push(b.pos.x, b.pos.y, b.pos.z, b.quat.x, b.quat.y, b.quat.z, b.quat.w);
      let ok = walls.every((w) => w.n.dot(b.pos) - w.d >= DIE_HALF_DIAG + FREE_MARGIN);
      for (let j = 0; ok && j < dice; j++) if (j !== i && bodies[j].pos.distanceTo(b.pos) < 2 * DIE_HALF_DIAG + FREE_MARGIN) ok = false;
      free.push(ok ? 1 : 0);
    }
  };

  record();
  let t = 0;
  let step = 0;
  const point = new Vector3();
  const rel = new Vector3();
  while (t < MAX_TIME) {
    for (const b of bodies) {
      if (!b.asleep) b.vel.y -= GRAVITY * STEP;
      b.grounded = false;
    }

    // 닿은 곳 찾기
    const contacts: Contact[] = [];
    const push = (a: Body, b: Body | null, n: Vector3, p: Vector3, bounce: number, friction: number, ai: number) => {
      const ra = p.clone().sub(a.pos);
      const rb = b ? p.clone().sub(b.pos) : null;
      const c: Contact = { a, b, n, ra, rb, kn: 0, bias: 0, friction, jn: 0, jt: new Vector3() };
      c.kn = effectiveInverse(a, ra, b, rb, n);
      if (c.kn <= 0) return;
      const vn = relativeVelocity(c, rel).dot(n);
      c.bias = vn < -BOUNCE_MIN ? -bounce * vn : 0;
      if (vn < -2.2 && t - a.lastImpact > 0.06) {
        impacts.push({ t, die: ai, speed: -vn });
        a.lastImpact = t;
      }
      contacts.push(c);
    };
    bodies.forEach((b, bi) => {
      if (b.asleep) return;
      for (const w of walls) {
        for (let i = 0; i < CORNERS.length; i++) {
          cornerWorld(b, i, point);
          const dist = w.n.dot(point) - w.d - DIE_ROUND;
          if (dist > SLOP) continue;
          if (w.n.y > 0.5) b.grounded = true;
          push(b, null, w.n, point.clone().addScaledVector(w.n, -DIE_ROUND), w.bounce, w.friction, bi);
        }
      }
    });
    for (let i = 0; i < dice; i++) {
      for (let j = i + 1; j < dice; j++) {
        const a = bodies[i];
        const b = bodies[j];
        if (a.pos.distanceTo(b.pos) > 2 * DIE_HALF_DIAG + 0.05) continue;
        const hits: { a: Body; b: Body; ai: number; hit: { n: Vector3; p: Vector3 } }[] = [];
        for (let k = 0; k < CORNERS.length; k++) {
          const h1 = cornerAgainstBox(a, k, b);
          if (h1) hits.push({ a, b, ai: i, hit: h1 });
          const h2 = cornerAgainstBox(b, k, a);
          if (h2) hits.push({ a: b, b: a, ai: j, hit: h2 });
        }
        if (!hits.length && a.pos.distanceTo(b.pos) < DIE_SIZE * 0.98) {
          // 모서리끼리 엇갈려 꼭짓점이 닿지 않았는데 깊이 겹쳤다: 중심끼리 민다.
          const n = a.pos.clone().sub(b.pos).normalize();
          hits.push({ a, b, ai: i, hit: { n, p: a.pos.clone().add(b.pos).multiplyScalar(0.5) } });
        }
        for (const h of hits) {
          // 잠든 주사위도 세게 부딪히면 깨운다.
          const vn = tmpA.copy(h.a.vel).sub(h.b.vel).dot(h.hit.n);
          if (vn < -0.4) for (const x of [h.a, h.b]) if (x.asleep) Object.assign(x, { asleep: false, calm: 0 });
          push(h.a, h.b, h.hit.n, h.hit.p, PAIR_BOUNCE, PAIR_FRICTION, h.ai);
        }
      }
    }

    // 충격량 풀기 (쌓아 가며 고친다)
    for (let it = 0; it < ITERATIONS; it++) {
      for (const c of contacts) {
        const vn = relativeVelocity(c, rel).dot(c.n);
        const dj = (c.bias - vn) / c.kn;
        const jn = Math.max(c.jn + dj, 0);
        applyImpulse(c, tmpA.copy(c.n).multiplyScalar(jn - c.jn));
        c.jn = jn;

        relativeVelocity(c, rel);
        const tangent = rel.addScaledVector(c.n, -rel.dot(c.n));
        const speed = tangent.length();
        if (speed < 1e-6) continue;
        const dir = tmpB.copy(tangent).divideScalar(speed);
        const kt = effectiveInverse(c.a, c.ra, c.b, c.rb, dir);
        const next = c.jt.clone().addScaledVector(dir, -speed / kt);
        const limit = c.friction * c.jn;
        if (next.length() > limit) next.setLength(limit);
        applyImpulse(c, next.clone().sub(c.jt));
        c.jt.copy(next);
      }
    }

    // 움직이기
    for (const b of bodies) {
      if (b.asleep) continue;
      b.pos.addScaledVector(b.vel, STEP);
      const w = b.spin;
      tmpQ.set(w.x * STEP * 0.5, w.y * STEP * 0.5, w.z * STEP * 0.5, 0).multiply(b.quat);
      b.quat.set(b.quat.x + tmpQ.x, b.quat.y + tmpQ.y, b.quat.z + tmpQ.z, b.quat.w + tmpQ.w).normalize();
      // 바닥에 닿아 구르는 동안은 조금씩 힘이 빠진다 (탁자 천의 저항).
      if (b.grounded) {
        b.spin.multiplyScalar(1 - 1.6 * STEP);
        b.vel.x *= 1 - 0.9 * STEP;
        b.vel.z *= 1 - 0.9 * STEP;
      } else b.spin.multiplyScalar(1 - 0.08 * STEP);
    }

    // 파고든 만큼 밀어내기
    for (const b of bodies) {
      if (b.asleep) continue;
      for (const w of walls) {
        let deepest = 0;
        for (let i = 0; i < CORNERS.length; i++) {
          const dist = w.n.dot(cornerWorld(b, i, point)) - w.d - DIE_ROUND;
          deepest = Math.min(deepest, dist);
        }
        if (deepest < -SLOP) b.pos.addScaledVector(w.n, -(deepest + SLOP) * 0.9);
      }
    }
    for (let i = 0; i < dice; i++) {
      for (let j = i + 1; j < dice; j++) {
        const a = bodies[i];
        const b = bodies[j];
        let worst: { n: Vector3; depth: number } | null = null;
        for (let k = 0; k < CORNERS.length; k++) {
          for (const [x, y, sign] of [[a, b, 1], [b, a, -1]] as const) {
            const h = cornerAgainstBox(x, k, y);
            if (h && h.depth > SLOP && (!worst || h.depth > worst.depth)) worst = { n: h.n.clone().multiplyScalar(sign), depth: h.depth };
          }
        }
        if (!worst) continue;
        const share = (worst.depth - SLOP) * 0.45;
        const wa = a.asleep ? 0 : b.asleep ? 2 : 1;
        const wb = b.asleep ? 0 : a.asleep ? 2 : 1;
        a.pos.addScaledVector(worst.n, share * wa);
        b.pos.addScaledVector(worst.n, -share * wb);
      }
    }

    // 잠들기: 바닥에 면을 대고 거의 멈춘 채로 잠깐 있으면 멈춘 것으로 본다.
    for (const b of bodies) {
      if (b.asleep) continue;
      const flat = tmpA.copy(FACE_NORMALS[topFace(b.quat)]).applyQuaternion(b.quat).y;
      if (b.grounded && b.vel.length() < 0.14 && b.spin.length() < 0.6 && flat > 0.995) b.calm += STEP;
      else b.calm = 0;
      if (b.calm > 0.1) {
        b.asleep = true;
        b.vel.set(0, 0, 0);
        b.spin.set(0, 0, 0);
      }
    }

    t += STEP;
    step++;
    if (step % RECORD_EVERY === 0) record();
    if (bodies.every((b) => b.asleep)) break;
  }

  // 마지막: 기울기가 조금 남았으면 면을 바닥에 딱 붙인 자세로 짧게 옮긴다.
  const finals = bodies.map((b) => ({ pos: new Vector3(b.pos.x, DIE_HALF, b.pos.z), quat: levelled(b.quat) }));
  const starts2 = bodies.map((b) => ({ pos: b.pos.clone(), quat: b.quat.clone() }));
  const dt = STEP * RECORD_EVERY;
  const snapFrames = Math.ceil(SNAP_TIME / dt);
  for (let f = 1; f <= snapFrames; f++) {
    const s = f / snapFrames;
    const e = s * s * (3 - 2 * s);
    for (let i = 0; i < dice; i++) {
      const p = starts2[i].pos.clone().lerp(finals[i].pos, e);
      const q = starts2[i].quat.clone().slerp(finals[i].quat, e);
      frames.push(p.x, p.y, p.z, q.x, q.y, q.z, q.w);
      free.push(0);
    }
  }
  const count = frames.length / (7 * dice);
  return {
    dt,
    count,
    dice,
    poses: new Float32Array(frames),
    free: new Uint8Array(free),
    impacts,
    top: finals.map((f) => topFace(f.quat)),
    duration: (count - 1) * dt,
  };
}

/** 기록에서 t 초의 자세 (프레임 사이는 보간) */
export function sampleRecording(rec: Recording, die: number, t: number, pos: Vector3, quat: Quaternion): void {
  const f = Math.max(0, Math.min(rec.count - 1, t / rec.dt));
  const i0 = Math.floor(f);
  const i1 = Math.min(rec.count - 1, i0 + 1);
  const s = f - i0;
  const a = (i0 * rec.dice + die) * 7;
  const b = (i1 * rec.dice + die) * 7;
  const p = rec.poses;
  pos.set(p[a] + (p[b] - p[a]) * s, p[a + 1] + (p[b + 1] - p[a + 1]) * s, p[a + 2] + (p[b + 2] - p[a + 2]) * s);
  quat.set(p[a + 3], p[a + 4], p[a + 5], p[a + 6]);
  tmpQ.set(p[b + 3], p[b + 4], p[b + 5], p[b + 6]);
  quat.slerp(tmpQ, s);
}

/**
 * t 초 뒤에 눈 방향을 섞을 수 있는 공중 구간 [시작, 끝]. 그 주사위가 아무 데도 닿지 않는 프레임이 이어지는 구간 중
 * 남은 길이가 minLength 이상인 첫 구간을 고르고, 길이는 maxLength 까지만 쓴다. 없으면 null.
 */
export function freeWindow(rec: Recording, die: number, t: number, minLength = 0.06, maxLength = 0.2): [number, number] | null {
  let i = Math.max(0, Math.ceil(t / rec.dt));
  while (i < rec.count) {
    while (i < rec.count && !rec.free[i * rec.dice + die]) i++;
    let j = i;
    while (j < rec.count && rec.free[j * rec.dice + die]) j++;
    if (j > i) {
      const start = i * rec.dt;
      const end = (j - 1) * rec.dt;
      if (end - start >= minLength) return [start, Math.min(end, start + maxLength)];
    }
    i = j + 1;
  }
  return null;
}
