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

// ───────────────────────── 수채화 바닥 텍스처 ─────────────────────────
// 넓게 번진 물감 농담 위에, 마르며 얼룩 테두리에 고인 물감(블룸), 어두운 물감일수록 도드라지는 알갱이,
// 짧은 붓 자국을 겹쳐 칠한다. 사진 같은 질감 대신 손으로 칠한 삽화처럼 보이게 하는 것이 목적이다.

/** 물감 얼룩: 얼룩 안쪽(0~1)과, 물감이 고여 진해진 얼룩 테두리(0~1) */
function bloom(u: number, v: number, period: number, seed: number, threshold = 0.55): { inside: number; rim: number } {
  const t = fbm(u, v, period, period, 5, seed);
  return {
    inside: smooth(threshold - 0.02, threshold + 0.03, t),
    rim: 1 - smooth(0.0, 0.028, Math.abs(t - threshold)),
  };
}

/** 어두운 물감일수록 도드라지는 알갱이 */
function granulate(c: RGB, u: number, v: number, seed: number, amount = 0.14): RGB {
  const g = fbm(u, v, 128, 128, 2, seed);
  const lum = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
  return scale(c, 1 - (g - 0.5) * amount * (1.4 - lum));
}

/** 한 방향으로 길쭉한 붓 자국 (0 = 가로, 1 = 세로, 2·3 = 대각선). density 가 클수록 자국이 많다. */
function strokes(u: number, v: number, dir: 0 | 1 | 2 | 3, density: number, seed: number): number {
  const [x, y] = dir === 0 ? [u, v] : dir === 1 ? [v, u] : dir === 2 ? [u + v, u - v] : [u - v, u + v];
  const s = fbm(x, y, 5, 44, 2, seed);
  return smooth(1 - density, 1 - density + 0.07, s);
}

/** 타일 사이 흙길과 받침: 따뜻한 시에나 물감, 군데군데 진한 얼룩과 잔돌 점 */
export function groundDirt(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    let c = mix(hex('#c8a679'), hex('#e3cba2'), fbm(u, v, 3, 3, 4, 181));
    const b = bloom(u, v, 5, 183, 0.58);
    c = mix(c, hex('#ae8a5f'), b.inside * 0.35);
    c = scale(c, 1 - b.rim * 0.16);
    const dot = voronoi(u, v, 28, 185, 0.9);
    if (hash2(dot.id, 1, 187) > 0.62) c = mix(c, hex('#977654'), (1 - smooth(0.05, 0.16, dot.f1)) * 0.4);
    img.set(x, y, granulate(c, u, v, 189));
  });
  return img;
}

/** 숲 바닥: 맑은 풀색 물감, 진한 초록 얼룩, 사선으로 짧게 그은 풀 붓 자국과 누런 낙엽 점 */
export function groundForest(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    let c = mix(hex('#557f42'), hex('#7ea060'), fbm(u, v, 3, 3, 4, 121));
    const b = bloom(u, v, 4, 123, 0.57);
    c = mix(c, hex('#41683a'), b.inside * 0.5);
    c = scale(c, 1 - b.rim * 0.22);
    const grass = Math.max(strokes(u, v, 2, 0.11, 125), strokes(u, v, 3, 0.09, 127));
    c = mix(c, hex('#30542b'), grass * 0.45);
    c = mix(c, hex('#c79d55'), strokes(u, v, 0, 0.035, 129) * 0.5);
    img.set(x, y, granulate(c, u, v, 131));
  });
  return img;
}

/** 밭: 황토색 물감, 밀 줄과 같은 가로 방향 고랑, 밝게 남긴 붓 자국 */
export function groundField(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    let c = mix(hex('#dbb265'), hex('#f0d592'), fbm(u, v, 3, 3, 4, 141));
    const furrow = Math.sin((v * 10 + (fbm(u, v, 4, 2, 2, 143) - 0.5) * 0.3) * Math.PI * 2) * 0.5 + 0.5;
    c = mix(c, hex('#bf8e47'), smooth(0.55, 0.95, furrow) * 0.35);
    c = mix(c, hex('#f7e5ad'), strokes(u, v, 0, 0.18, 145) * 0.45);
    const b = bloom(u, v, 3, 147, 0.6);
    c = scale(c, 1 - b.rim * 0.12);
    img.set(x, y, granulate(c, u, v, 149, 0.1));
  });
  return img;
}

/** 채석장: 서늘한 회색 물감, 보랏빛 그늘 얼룩, 군데군데 끊긴 먹선 금, 자갈 점 */
export function groundQuarry(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    let c = mix(hex('#b6b0a6'), hex('#dbd4c7'), fbm(u, v, 3, 3, 4, 151));
    const b = bloom(u, v, 4, 153, 0.55);
    c = mix(c, hex('#9b94a3'), b.inside * 0.4);
    c = scale(c, 1 - b.rim * 0.2);
    const rock = voronoi(u, v, 5, 155, 0.9);
    const crack = 1 - smooth(0.0, 0.03, rock.f2 - rock.f1);
    c = mix(c, hex('#6a6158'), crack * (fbm(u, v, 8, 8, 2, 157) > 0.45 ? 0.5 : 0.1));
    const gravel = voronoi(u, v, 40, 159, 0.9);
    const patch = smooth(0.5, 0.7, fbm(u, v, 3, 3, 3, 161));
    c = scale(c, 1 - (1 - smooth(0, 0.12, gravel.f2 - gravel.f1)) * 0.14 * patch);
    img.set(x, y, granulate(c, u, v, 163, 0.18));
  });
  return img;
}

/** 시장 바닥: 크림색 물감 위에 펜으로 대충 그은 둥근 돌 (테두리가 군데군데 끊긴다) */
export function groundCobble(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    const vo = voronoi(u, v, 10, 171, 0.7);
    let c = mix(hex('#dccbab'), hex('#f0e4c9'), fbm(u, v, 3, 3, 4, 173));
    const tone = hash2(vo.id, 4, 175);
    c = mix(c, tone > 0.66 ? hex('#cbb390') : tone > 0.33 ? hex('#dac6a3') : hex('#c4b9a8'), 0.5);
    // 돌마다 왼쪽 위는 밝고 오른쪽 아래는 그늘지게 한 번 더 칠한다.
    c = scale(c, 1 + (-vo.dx - vo.dy) * 0.16);
    const pen = (1 - smooth(0.015, 0.05, vo.f2 - vo.f1)) * (fbm(u, v, 16, 16, 2, 177) > 0.35 ? 1 : 0.3);
    c = mix(c, hex('#7b6249'), pen * 0.6);
    img.set(x, y, granulate(c, u, v, 179));
  });
  return img;
}

/** 목초지: 숲보다 밝고 노르스름한 풀색 물감, 세로·사선 풀 붓 자국, 흰 토끼풀과 노란 들꽃 점 */
export function groundPasture(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    let c = mix(hex('#cfe0a0'), hex('#e8efc6'), fbm(u, v, 3, 3, 4, 191));
    const b = bloom(u, v, 4, 193, 0.58);
    c = mix(c, hex('#bfd68f'), b.inside * 0.35);
    c = scale(c, 1 - b.rim * 0.1);
    const grass = Math.max(strokes(u, v, 1, 0.08, 195), strokes(u, v, 2, 0.06, 197));
    c = mix(c, hex('#a3c272'), grass * 0.3);
    const dot = voronoi(u, v, 22, 199, 0.9);
    const h = hash2(dot.id, 3, 201);
    if (h > 0.8) c = mix(c, h > 0.9 ? hex('#f6f1dc') : hex('#f2d25e'), (1 - smooth(0.08, 0.17, dot.f1)) * 0.85);
    img.set(x, y, granulate(c, u, v, 203, 0.1));
  });
  return img;
}

/** 점토 구덩이: 황토빛 점토 물감, 물기 먹은 짙은 웅덩이, 마르며 갈라진 먹선, 삽으로 떠낸 밝은 자국 */
export function groundClay(size = 512): Img {
  const img = new Img(size, size);
  each(size, (u, v, x, y) => {
    let c = mix(hex('#d09062'), hex('#e6b083'), fbm(u, v, 3, 3, 4, 211));
    const b = bloom(u, v, 4, 213, 0.56);
    c = mix(c, hex('#bf7f52'), b.inside * 0.42);
    c = scale(c, 1 - b.rim * 0.18);
    const wet = smooth(0.62, 0.7, fbm(u, v, 3, 3, 3, 215));
    c = mix(c, hex('#9a5a3a'), wet * 0.38);
    const cell = voronoi(u, v, 7, 217, 0.85);
    const crack = 1 - smooth(0.0, 0.025, cell.f2 - cell.f1);
    c = mix(c, hex('#6b3d28'), crack * (fbm(u, v, 6, 6, 2, 219) > 0.5 ? 0.45 : 0.08));
    c = mix(c, hex('#ebbd90'), strokes(u, v, 3, 0.07, 221) * 0.35);
    img.set(x, y, granulate(c, u, v, 223, 0.16));
  });
  return img;
}

/**
 * 타일 사이 중세 흙길: 가로(u)가 길 방향이고 세로(v)가 길 폭이다. 가로 512 × 세로 128 픽셀이 길 1칸 길이 × 길 폭.
 * 수레바퀴가 파 놓은 두 줄 자국(군데군데 물이 고임), 바퀴 사이 풀이 난 둔덕, 길가 풀섶, 박힌 잔돌을 물감으로 칠한다.
 * 가로로만 이어 붙여 쓴다 (세로는 길가에서 끝난다).
 */
export function groundRoad(w = 512, h = 128): Img {
  const img = new Img(w, h);
  const aspect = h / w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const va = v * aspect;
      // 바퀴 자국은 길을 따라 조금씩 구불거린다.
      const wob = (fbm(u, 0.5, 6, 1, 2, 301) - 0.5) * 0.1;
      let c = mix(hex('#b8946a'), hex('#d8bd90'), fbm(u, va, 10, 3, 4, 303));
      const b = bloom(u, va, 6, 305, 0.6);
      c = mix(c, hex('#a7845c'), b.inside * 0.25);
      c = scale(c, 1 - b.rim * 0.06);
      // 두 줄 수레바퀴 자국: 파인 곳은 진하고(길을 따라 진하기가 들쭉날쭉), 가장자리에 밀려난 흙은 밝다.
      const rut = (center: number) => {
        const d = Math.abs(v + wob - center);
        // 자국 폭도 길을 따라 들쭉날쭉하다.
        const wv = 0.045 + (fbm(u, center, 9, 1, 2, 329) - 0.5) * 0.03;
        return { core: 1 - smooth(wv * 0.4, wv + 0.035, d), lip: smooth(wv + 0.02, wv + 0.04, d) * (1 - smooth(wv + 0.04, wv + 0.08, d)) };
      };
      const r1 = rut(0.33);
      const r2 = rut(0.67);
      const core = Math.max(r1.core, r2.core);
      const lip = Math.max(r1.lip, r2.lip);
      const depth = 0.18 + 0.3 * fbm(u, va, 14, 3, 2, 323);
      c = mix(c, hex('#8a6a46'), core * depth);
      c = mix(c, hex('#e3cda2'), lip * 0.18);
      // 자국 안 짧은 물웅덩이: 흙탕물 빛
      const puddle = smooth(0.68, 0.73, fbm(u, va, 22, 4, 3, 307)) * core;
      c = mix(c, hex('#8f8b7a'), puddle * 0.5);
      // 바퀴 사이 둔덕: 밝은 흙에 잔풀이 듬성듬성
      const mid = 1 - smooth(0.04, 0.1, Math.abs(v + wob - 0.5));
      c = mix(c, hex('#ddc597'), mid * 0.3);
      const midGrass = smooth(0.7, 0.76, fbm(u, va, 56, 56, 2, 309)) * mid;
      c = mix(c, hex('#93ad62'), midGrass * 0.45);
      // 길가 풀섶: 양쪽 끝에서 들쭉날쭉 길 안으로 번진다.
      const edge = Math.min(v, 1 - v) + (fbm(u, va, 14, 14, 3, 311) - 0.5) * 0.16;
      const verge = 1 - smooth(0.08, 0.17, edge);
      c = mix(c, mix(hex('#6f9447'), hex('#9cbb68'), fbm(u, va, 30, 8, 2, 313)), verge * 0.85);
      // 박힌 잔돌: 작고 모난 돌이 드문드문, 먹선으로 테두리
      const vo = voronoi(u, va, 22, 315, 0.9);
      if (hash2(vo.id, 3, 317) > 0.86 - verge * 0.06) {
        const r = 0.13 + (fbm(u, va, 64, 16, 2, 325) - 0.5) * 0.08 + hash2(vo.id, 9, 327) * 0.06;
        const bodyMask = 1 - smooth(r - 0.03, r, vo.f1);
        const pen = smooth(r - 0.035, r - 0.005, vo.f1) * (1 - smooth(r, r + 0.03, vo.f1));
        const tone = hash2(vo.id, 5, 319) > 0.5 ? hex('#bdb29b') : hex('#a2977f');
        c = mix(c, scale(tone, 1 + (-vo.dx - vo.dy) * 0.4), bodyMask * 0.85);
        c = mix(c, hex('#5e4a36'), pen * 0.45);
      }
      img.set(x, y, granulate(c, u, v, 321));
    }
  }
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
