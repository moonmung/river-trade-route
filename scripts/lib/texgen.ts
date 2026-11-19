// 이어 붙여도 이음매가 보이지 않는(타일링) 절차적 텍스처 생성기.
// 임시 에셋용이며, 최종 텍스처는 Blender/Substance 등에서 만든 KTX2 로 교체한다.

export type RGB = [number, number, number];

export class Img {
  readonly data: Float32Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Float32Array(w * h * 4);
  }

  set(x: number, y: number, c: RGB, a = 1): void {
    const i = (y * this.w + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
  }

  /** 0~1 실수 → 8비트 RGBA */
  toRGBA8(): Uint8Array {
    const out = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(this.data[i] * 255)));
    return out;
  }
}

export function hex(h: string): RGB {
  const n = parseInt(h.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const mod = (a: number, n: number) => ((a % n) + n) % n;
const frac = (x: number) => x - Math.floor(x);

export function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 주기 px, py (격자 칸 수) 로 반복되는 값 노이즈 */
export function noise(x: number, y: number, px: number, py: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const ax = mod(x0, px);
  const bx = mod(x0 + 1, px);
  const ay = mod(y0, py);
  const by = mod(y0 + 1, py);
  const a = hash2(ax, ay, seed);
  const b = hash2(bx, ay, seed);
  const c = hash2(ax, by, seed);
  const d = hash2(bx, by, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** u, v ∈ [0,1) 에서 이음매 없이 반복되는 fBm. 가로·세로 주기를 따로 줄 수 있다. */
export function fbm(u: number, v: number, periodX: number, periodY: number, octaves: number, seed: number, gain = 0.5): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let px = periodX;
  let py = periodY;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(u * px, v * py, px, py, seed + o * 31);
    norm += amp;
    amp *= gain;
    px *= 2;
    py *= 2;
  }
  return sum / norm;
}

export interface Voronoi {
  f1: number;
  f2: number;
  id: number;
  /** 가장 가까운 점 기준 상대 위치 */
  dx: number;
  dy: number;
}

/** 이음매 없는 보로노이 (n×n 칸마다 점 하나) */
export function voronoi(u: number, v: number, n: number, seed: number, jitter = 0.85): Voronoi {
  const x = u * n;
  const y = v * n;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  let dx = 0;
  let dy = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox;
      const gy = cy + oy;
      const wx = mod(gx, n);
      const wy = mod(gy, n);
      const px = gx + 0.5 + (hash2(wx, wy, seed) - 0.5) * jitter;
      const py = gy + 0.5 + (hash2(wx, wy, seed + 7) - 0.5) * jitter;
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = wy * n + wx;
        dx = x - px;
        dy = y - py;
      } else if (d < f2) f2 = d;
    }
  }
  return { f1, f2, id, dx, dy };
}

export interface Layers {
  color: Img;
  height: Float32Array;
  rough: Float32Array;
}

export function newLayers(size: number): Layers {
  return { color: new Img(size, size), height: new Float32Array(size * size), rough: new Float32Array(size * size).fill(0.8) };
}

/** 높이 맵 → 탄젠트 공간 노멀 맵 (OpenGL/glTF 방식, 이음매 없이 감싸서 계산) */
export function heightToNormal(height: Float32Array, size: number, strength: number): Img {
  const out = new Img(size, size);
  const at = (x: number, y: number) => height[mod(y, size) * size + mod(x, size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      out.set(x, y, [(-dx / len) * 0.5 + 0.5, (dy / len) * 0.5 + 0.5, (1 / len) * 0.5 + 0.5]);
    }
  }
  return out;
}

/** glTF metallicRoughness: G = 거칠기, B = 금속성 (여기서는 0) */
export function roughToImg(rough: Float32Array, size: number): Img {
  const out = new Img(size, size);
  for (let i = 0; i < size * size; i++) out.set(i % size, Math.floor(i / size), [1, clamp01(rough[i]), 0]);
  return out;
}

function each(size: number, fn: (u: number, v: number, x: number, y: number, i: number) => void): void {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) fn(x / size, y / size, x, y, y * size + x);
}

// ───────────────────────── 소품 텍스처 ─────────────────────────

/** 판자: 나뭇결, 갈라진 결, 판자 틈, 철제 못 (Poly Haven 'medieval_wood' 의 표현을 참고) */
export function woodPlanks(size = 256): Layers {
  const L = newLayers(size);
  const planks = 4;
  each(size, (u, v, x, y, i) => {
    const pu = u * planks;
    const p = Math.floor(pu);
    const fu = pu - p;
    const pr = hash2(p, 0, 11);
    const base = mix(hex('#8e5c33'), hex('#bb8650'), pr);
    const grain = fbm(u, v, 48, 3, 3, 5 + p);
    const rings = Math.sin((fu * 5 + grain * 2.4 + pr * 9) * Math.PI * 2) * 0.5 + 0.5;
    const fine = fbm(u, v, 96, 12, 2, 9);
    let c = scale(base, 0.8 + 0.2 * rings);
    c = scale(c, 0.9 + 0.18 * fine);
    let h = rings * 0.18 + fine * 0.1;
    let r = 0.68 + 0.2 * (1 - rings) + 0.08 * fine;
    // 판자 끝 이음매 (판자마다 높이가 다르다)
    const joint = hash2(p, 1, 13);
    const dj = Math.abs(frac(v - joint + 0.5) - 0.5);
    const seam = fu < 0.035 || fu > 0.965;
    if (seam || dj < 0.006) {
      c = scale(c, 0.32);
      h = -1;
      r = 0.95;
    }
    // 갈라진 나뭇결 (일부 판자)
    if (pr > 0.45) {
      const crackX = 0.5 + 0.18 * Math.sin(v * Math.PI * 2 * 2 + p * 1.7) + 0.05 * (fbm(u, v, 4, 8, 2, 21 + p) - 0.5);
      const segment = fbm(0, v, 1, 6, 2, 31 + p) > 0.55;
      if (segment && Math.abs(fu - crackX) < 0.012) {
        c = scale(c, 0.45);
        h = -0.6;
        r = 0.92;
      }
    }
    // 철제 못: 이음매 위아래로 두 개씩
    for (const side of [-1, 1]) {
      for (const nx of [0.28, 0.72]) {
        const ny = frac(joint + side * 0.035);
        const ddx = (fu - nx) * (size / planks);
        let ddy = (v - ny) * size;
        if (ddy > size / 2) ddy -= size;
        if (ddy < -size / 2) ddy += size;
        const d = Math.hypot(ddx, ddy);
        if (d < 3) {
          const dome = 1 - d / 3;
          c = mix(hex('#3b3631'), hex('#8a8580'), dome * 0.6);
          h = 0.5 + dome * 0.6;
          r = 0.38;
        } else if (d < 4) {
          c = scale(c, 0.6); // 못 주변 녹 자국
        }
      }
    }
    L.color.set(x, y, c);
    L.height[i] = h;
    L.rough[i] = r;
  });
  return L;
}

export function bark(size = 256): Layers {
  const L = newLayers(size);
  each(size, (u, v, x, y, i) => {
    const warp = fbm(u, v, 4, 6, 3, 41) * 0.5;
    const ridge = Math.pow(Math.abs(Math.sin((u * 7 + warp) * Math.PI)), 0.55);
    const breaks = fbm(u, v, 14, 10, 2, 43);
    const h = ridge * (0.7 + 0.3 * breaks);
    const c = mix(hex('#3e2b1d'), hex('#8d6c4c'), clamp01(h * 0.9 + (fbm(u, v, 16, 16, 2, 47) - 0.5) * 0.3));
    L.color.set(x, y, c);
    L.height[i] = h;
    L.rough[i] = 0.9;
  });
  return L;
}

/** 각진 돌: 면마다 다른 회색, 돌 틈, 이끼 */
export function stone(size = 256): Layers {
  const L = newLayers(size);
  each(size, (u, v, x, y, i) => {
    const vo = voronoi(u, v, 6, 51);
    const edge = vo.f2 - vo.f1;
    const cellTone = hash2(vo.id, 3, 53);
    const n = fbm(u, v, 8, 8, 4, 55);
    let c = mix(hex('#7f8389'), hex('#b9b5ab'), cellTone * 0.7 + n * 0.3);
    const lichen = smooth(0.62, 0.78, fbm(u, v, 3, 3, 3, 57));
    c = mix(c, hex('#a3a46a'), lichen * 0.35);
    const crack = 1 - smooth(0.0, 0.07, edge);
    c = scale(c, 1 - crack * 0.6);
    L.color.set(x, y, c);
    L.height[i] = (1 - vo.f1) * 0.35 + n * 0.35 - crack * 1.1;
    L.rough[i] = 0.82 + n * 0.1 + crack * 0.08 - lichen * 0.05;
  });
  return L;
}

/** 평직 천 (천막·포대) */
export function cloth(size = 256): Layers {
  const L = newLayers(size);
  const threads = 48;
  each(size, (u, v, x, y, i) => {
    const iu = Math.floor(u * threads);
    const iv = Math.floor(v * threads);
    const wu = u * threads - iu;
    const wv = v * threads - iv;
    const over = (iu + iv) % 2 === 0;
    const bulge = over ? Math.sin(Math.PI * wu) : Math.sin(Math.PI * wv);
    const slub = fbm(u, v, 32, 2, 2, 61);
    const stain = smooth(0.66, 0.8, fbm(u, v, 3, 3, 4, 63));
    let c = scale(hex('#e6d9bb'), 0.86 + 0.12 * bulge + 0.06 * (slub - 0.5));
    c = mix(c, hex('#b49a72'), stain * 0.35);
    L.color.set(x, y, c);
    L.height[i] = bulge * 0.8 + slub * 0.2;
    L.rough[i] = 0.95;
  });
  return L;
}

/** 회벽 (Kingdom Come 의 사용감 있는 벽: 얼룩과 거친 표면) */
export function plaster(size = 256): Layers {
  const L = newLayers(size);
  each(size, (u, v, x, y, i) => {
    const big = fbm(u, v, 3, 3, 4, 71);
    const fine = fbm(u, v, 48, 48, 2, 73);
    const stain = smooth(0.6, 0.85, fbm(u, v, 2, 4, 3, 75));
    let c = scale(hex('#eee5d1'), 0.9 + 0.12 * big + 0.05 * fine);
    c = mix(c, hex('#cdbb94'), stain * 0.3);
    L.color.set(x, y, c);
    L.height[i] = fine * 0.3 + big * 0.2;
    L.rough[i] = 0.95;
  });
  return L;
}

/** 나무 지붕널. 플레이어 색을 곱해 쓰므로 밝은 무채색으로 만든다. */
export function shingles(size = 256): Layers {
  const L = newLayers(size);
  const rows = 8;
  const per = 6;
  each(size, (u, v, x, y, i) => {
    const row = Math.floor(v * rows);
    const sv = v * rows - row;
    const off = row % 2 === 0 ? 0 : 0.5;
    const su0 = u * per + off;
    const col = Math.floor(su0);
    const su = su0 - col;
    const tone = hash2(mod(col, per), row, 81);
    const grain = fbm(u, v, 40, 4, 2, 83);
    let c = scale(hex('#efe9df'), 0.8 + 0.14 * tone + 0.08 * grain);
    let h = sv * 0.7 + grain * 0.15;
    if (sv > 0.88) c = scale(c, 0.62);
    if (su < 0.04 || su > 0.96) {
      c = scale(c, 0.55);
      h -= 0.4;
    }
    L.color.set(x, y, c);
    L.height[i] = h;
    L.rough[i] = 0.85;
  });
  return L;
}

export function foliage(size: number, dark: string, light: string, seed: number): Layers {
  const L = newLayers(size);
  each(size, (u, v, x, y, i) => {
    const clusters = fbm(u, v, 6, 6, 3, seed);
    const needles = fbm(u, v, 40, 40, 2, seed + 5);
    const t = clamp01(clusters * 0.9 + (needles - 0.5) * 0.5);
    L.color.set(x, y, mix(hex(dark), hex(light), t));
    L.height[i] = t;
  });
  return L;
}

// ───────────────────────── 바닥 텍스처 ─────────────────────────

export function groundGrass(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    const patch = fbm(u, v, 3, 3, 4, 101);
    const blades = fbm(u, v, 64, 24, 2, 103);
    const dry = smooth(0.58, 0.75, fbm(u, v, 2, 2, 3, 105));
    let c = mix(hex('#6c9443'), hex('#97ba5c'), patch * 0.8 + blades * 0.3);
    c = mix(c, hex('#b9b468'), dry * 0.35);
    const flower = hash2(x, y, 107);
    if (flower > 0.9993) c = flower > 0.99965 ? hex('#f3f0d0') : hex('#e8c94a');
    img.set(x, y, c);
  });
  return img;
}

export function groundDirt(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    const patch = fbm(u, v, 4, 4, 4, 111);
    const pebble = voronoi(u, v, 36, 113, 0.9);
    let c = mix(hex('#a2865e'), hex('#cbb187'), patch);
    if (pebble.f1 < 0.18) c = mix(c, hash2(pebble.id, 1, 115) > 0.5 ? hex('#e0d2b6') : hex('#7d6446'), 0.5 * (1 - pebble.f1 / 0.18));
    img.set(x, y, c);
  });
  return img;
}

export function groundForest(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    const moss = smooth(0.45, 0.7, fbm(u, v, 4, 4, 4, 121));
    const needlesA = fbm(u, v, 96, 8, 2, 123);
    const needlesB = fbm(u, v, 8, 96, 2, 125);
    const needle = Math.max(needlesA, needlesB);
    let c = mix(hex('#6e5a3b'), hex('#5f8a3f'), moss);
    c = mix(c, hex('#9a7d50'), smooth(0.68, 0.82, needle) * 0.6);
    c = scale(c, 0.92 + 0.2 * fbm(u, v, 16, 16, 2, 127));
    img.set(x, y, c);
  });
  return img;
}

/** 갈아 놓은 밭: 밀 줄과 같은 방향(가로)의 고랑 */
export function groundField(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    const furrow = Math.sin((v * 10 + (fbm(u, v, 4, 2, 2, 131) - 0.5) * 0.25) * Math.PI * 2) * 0.5 + 0.5;
    const n = fbm(u, v, 24, 24, 3, 133);
    let c = mix(hex('#8a6738'), hex('#c09a5c'), furrow * 0.7 + n * 0.3);
    if (hash2(x, y, 135) > 0.996) c = hex('#f0d27a');
    img.set(x, y, c);
  });
  return img;
}

export function groundQuarry(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    const gravel = voronoi(u, v, 48, 141, 0.95);
    const dust = fbm(u, v, 3, 3, 4, 143);
    const tone = hash2(gravel.id, 2, 145);
    let c = mix(hex('#a39f96'), hex('#dad6cc'), tone * 0.6 + dust * 0.4);
    c = scale(c, 1 - (1 - smooth(0, 0.12, gravel.f2 - gravel.f1)) * 0.35);
    img.set(x, y, c);
  });
  return img;
}

/** 시장 바닥 자갈 포장 (둥근 돌 + 모래 줄눈) */
export function groundCobble(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    const vo = voronoi(u, v, 12, 151, 0.7);
    const edge = vo.f2 - vo.f1;
    const tone = hash2(vo.id, 4, 153);
    const n = fbm(u, v, 32, 32, 2, 155);
    let c = mix(hex('#b0a48c'), hex('#dcd0b6'), tone * 0.7 + n * 0.3);
    // 햇빛 방향(왼쪽 위)으로 밝게, 반대쪽으로 어둡게 미리 칠해 돌이 둥글어 보이게 한다.
    c = scale(c, 1 + (-vo.dx - vo.dy) * 0.25);
    const mortar = 1 - smooth(0.04, 0.14, edge);
    c = mix(c, hex('#8a7a60'), mortar);
    img.set(x, y, c);
  });
  return img;
}

export function groundSand(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    const ripple = Math.sin((u * 6 + v * 14 + fbm(u, v, 3, 3, 2, 161) * 0.8) * Math.PI * 2) * 0.5 + 0.5;
    const wet = smooth(0.5, 0.75, fbm(u, v, 2, 2, 3, 163));
    let c = mix(hex('#c2a879'), hex('#dcc89e'), ripple * 0.35 + fbm(u, v, 24, 24, 2, 165) * 0.65);
    c = mix(c, hex('#8f7a58'), wet * 0.35);
    img.set(x, y, c);
  });
  return img;
}

export function waterNormal(size = 256): Img {
  const h = new Float32Array(size * size);
  const waves: [number, number, number][] = [
    [3, 1, 0.3],
    [1, 4, 1.7],
    [-2, 3, 2.9],
    [5, -2, 4.1],
    [7, 5, 0.9],
  ];
  each(size, (u, v, _x, _y, i) => {
    let s = 0;
    for (const [a, b, p] of waves) s += Math.sin((a * u + b * v) * Math.PI * 2 + p) / Math.hypot(a, b);
    h[i] = s * 0.6 + fbm(u, v, 16, 16, 2, 171) * 0.6;
  });
  return heightToNormal(h, size, 3.5);
}

/** 미리 구운 접촉 그림자 (가운데 진하고 가장자리 0). alphaMap 으로 쓴다. */
export function contactShadow(size = 128): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    const r = Math.hypot(u - 0.5 + 0.5 / size, v - 0.5 + 0.5 / size) / 0.5;
    const a = Math.pow(1 - smooth(0.0, 1.0, r), 1.5);
    img.set(x, y, [a, a, a]);
  });
  return img;
}
