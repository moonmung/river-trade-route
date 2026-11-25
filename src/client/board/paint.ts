// 수채화·만화풍 그리기.
// 장면은 3D 로 만들지만 손으로 그린 삽화처럼 보이게 한다 (페이크 3D).
// - 재질: 빛을 몇 단계로만 나눠 칠하는 만화 음영. 볕 든 쪽은 따뜻하게, 그늘은 서늘하게 칠하고,
//   세계 좌표에 붙은 물감 얼룩을 섞어 같은 색 면도 붓으로 칠한 듯 농담이 생긴다.
// - 후처리: 장면을 화면 밖 버퍼에 그린 뒤 한 번에 먹선(깊이·색 경계), 흔들리는 가장자리,
//   물감 알갱이, 마르며 가장자리에 고인 물감, 종이 결을 입힌다.
import * as THREE from 'three';

// ───────────────────────── 공용 잡음 텍스처 ─────────────────────────

const NOISE_SIZE = 256;
let noiseTexture: THREE.DataTexture | null = null;

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 주기 period(격자 칸 수)로 이음매 없이 반복되는 값 잡음 */
function valueNoise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const ax = ((x0 % period) + period) % period;
  const ay = ((y0 % period) + period) % period;
  const bx = (ax + 1) % period;
  const by = (ay + 1) % period;
  const a = hash2(ax, ay, seed);
  const b = hash2(bx, ay, seed);
  const c = hash2(ax, by, seed);
  const d = hash2(bx, by, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(u: number, v: number, period: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(u * p, v * p, p, seed + o * 17) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  // 대비를 조금 늘려 0~1 을 고르게 쓰게 한다.
  return Math.min(1, Math.max(0, (sum / norm - 0.5) * 1.7 + 0.5));
}

/**
 * 붓·종이 표현에 쓰는 반복 잡음 (256×256, 한 번만 만든다).
 * R = 잔 알갱이(물감 알갱이·종이 결), G = 넓은 얼룩(물감 농담), B·A = 가장자리 흔들림 두 방향
 */
export function paintNoise(): THREE.DataTexture {
  if (noiseTexture) return noiseTexture;
  const n = NOISE_SIZE;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const v = y / n;
      const i = (y * n + x) * 4;
      data[i] = Math.round(fbm(u, v, 48, 3, 11) * 255);
      data[i + 1] = Math.round(fbm(u, v, 4, 4, 23) * 255);
      data[i + 2] = Math.round(fbm(u, v, 8, 2, 37) * 255);
      data[i + 3] = Math.round(fbm(u, v, 8, 2, 51) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  noiseTexture = tex;
  return tex;
}

// ───────────────────────── 만화 음영 재질 ─────────────────────────

let rampTexture: THREE.DataTexture | null = null;

/** 빛의 세기를 네 단계로 끊는 음영표 (그늘 → 반그늘 → 볕 → 정면 볕) */
function toonRamp(): THREE.DataTexture {
  if (rampTexture) return rampTexture;
  const levels = [70, 130, 205, 255];
  const data = new Uint8Array(levels.length * 4);
  levels.forEach((l, i) => data.set([l, l, l, 255], i * 4));
  const tex = new THREE.DataTexture(data, levels.length, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  rampTexture = tex;
  return tex;
}

/**
 * 칠한 색의 채도 배율. 재질 색 × 꼭짓점 색 × 텍스처 × 플레이어 색을 다 곱한 최종 색에 한 번 걸어서
 * 소품, 바닥, 수확 토큰이 같은 비율로 진해진다. 1 이면 materials.ts 와 텍스처 색 그대로다.
 * 보드 밖 물은 재질이 아니라 배경색이라 BoardRenderer 의 WATER_COLOR 를 같은 비율로 따로 맞춰 둔다.
 */
export const PAINT_SATURATION = 1.3;

/** 바람 흔들림에 쓰는 시간(초). BoardRenderer 가 움직임을 켜 둔 동안 매 프레임 올린다. 모든 재질이 같은 값을 본다. */
export const paintTime = { value: 0 };

/**
 * 기사단 동상이 선 칸. 이 육각형(꼭짓점이 앞뒤 ±z 를 향함) 안은 빛을 받은 뒤의 색에서 채도를 모두 빼 무채색으로 칠한다.
 * 모든 재질이 같은 값을 보며 BoardRenderer 가 동상을 옮길 때 바꾼다.
 * - center: 칸 중심 (세계 x, z), apothem: 중심에서 변까지 거리
 * - reach: 칸 중심에서 잿빛이 번진 반지름. 늘리면 가운데부터 색이 빠지고 줄이면 가장자리부터 색이 돌아온다.
 * - amount: 0 이면 잠긴 칸 없음
 */
export const paintLock = {
  center: { value: new THREE.Vector2() },
  apothem: { value: 1 },
  reach: { value: 0 },
  amount: { value: 0 },
};

/** 동시에 빛날 수 있는 칸 수 (한 번 굴려 내 자원이 나오는 칸은 대개 한두 칸이다) */
export const GLOW_SLOTS = 4;

/**
 * 내 자원이 나온 칸. 이 육각형 안(바닥·밀밭·나무·집 모두)은 빛을 받은 색을 잠깐 환하고 따뜻하게 올린다.
 * tiles 의 x, y 는 칸 중심 (세계 x, z), z 는 밝기 (0 이면 꺼짐). BoardRenderer.glowTiles 가 바꾼다.
 */
export const paintGlow = {
  tiles: { value: Array.from({ length: GLOW_SLOTS }, () => new THREE.Vector3()) },
  apothem: { value: 1 },
};

const LOCK_UNIFORMS = /* glsl */ `
uniform vec2 uLockCenter;
uniform float uLockApothem;
uniform float uLockReach;
uniform float uLockAmount;
uniform vec3 uGlowTiles[ ${GLOW_SLOTS} ];
uniform float uGlowApothem;
float paintHex( vec2 p ) {
  vec2 q = abs( p );
  return max( q.x, dot( q, vec2( 0.5, 0.8660254 ) ) );
}
float paintLockGrey( vec3 w ) {
  vec2 p = w.xz - uLockCenter;
  float inside = 1.0 - smoothstep( uLockApothem - 0.02, uLockApothem + 0.03, paintHex( p ) );
  float reach = 1.0 - smoothstep( uLockReach - 0.35, uLockReach, length( p ) );
  return uLockAmount * inside * reach;
}
float paintGlowAmount( vec3 w ) {
  float g = 0.0;
  for ( int i = 0; i < ${GLOW_SLOTS}; i++ ) {
    if ( uGlowTiles[ i ].z <= 0.0 ) continue;
    float inside = 1.0 - smoothstep( uGlowApothem - 0.06, uGlowApothem + 0.02, paintHex( w.xz - uGlowTiles[ i ].xy ) );
    g = max( g, uGlowTiles[ i ].z * inside );
  }
  return g;
}`;

/**
 * 빛까지 다 칠한 색을 밝기만 남긴 회색으로 바꾼다 (잠긴 칸이 또렷이 죽어 보이도록 조금 어둡게).
 * 내 자원이 나온 칸은 그 칸 안만 햇빛이 든 듯 환하고 따뜻하게 올린다.
 */
const LOCK_FRAGMENT = /* glsl */ `
  float lockGrey = paintLockGrey( vPaintWorld );
  outgoingLight = mix( outgoingLight, vec3( dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) ) * 0.93 ), lockGrey );
  float glowAmt = paintGlowAmount( vPaintWorld );
  outgoingLight = outgoingLight * ( 1.0 + 0.55 * glowAmt ) + vec3( 0.22, 0.17, 0.06 ) * glowAmt;
  #include <opaque_fragment>`;

const WORLD_VERTEX = /* glsl */ `#include <project_vertex>
  vec4 paintWorld = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    paintWorld = instanceMatrix * paintWorld;
  #endif
  vPaintWorld = ( modelMatrix * paintWorld ).xyz;`;

function bindLockUniforms(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.uLockCenter = paintLock.center;
  shader.uniforms.uLockApothem = paintLock.apothem;
  shader.uniforms.uLockReach = paintLock.reach;
  shader.uniforms.uLockAmount = paintLock.amount;
  shader.uniforms.uGlowTiles = paintGlow.tiles;
  shader.uniforms.uGlowApothem = paintGlow.apothem;
}

/**
 * 만화 음영이 아닌 재질(접촉 그림자, 타일 가장자리 그늘)도 잠긴 칸 안에서 무채색이 되게 한다.
 * 그림자가 보라빛 물감이라 그대로 두면 잿빛 칸 위에 색이 남는다.
 */
export function greyWhenLocked<T extends THREE.MeshBasicMaterial>(m: T): T {
  m.onBeforeCompile = (shader) => {
    bindLockUniforms(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPaintWorld;')
      .replace('#include <project_vertex>', WORLD_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vPaintWorld;${LOCK_UNIFORMS}`)
      .replace('#include <opaque_fragment>', LOCK_FRAGMENT);
  };
  m.customProgramCacheKey = () => 'paint-lock-basic';
  return m;
}

export interface PaintOptions {
  color?: THREE.ColorRepresentation;
  map?: THREE.Texture | null;
  vertexColors?: boolean;
  side?: THREE.Side;
  name?: string;
  /** 물감 얼룩 세기 (0 이면 고른 색) */
  wash?: number;
  /** 바람에 흔들리는 세기 (0 이면 고정). 소품 바닥은 그대로 두고 높이 올라갈수록 많이 흔들린다. */
  sway?: number;
  /**
   * 기사단 동상이 선 칸 안에서 무채색이 되는지 (기본 켬). 플레이어 조각, 동상·사슬·자물쇠, 길 위 교역인,
   * 날아가는 생산물처럼 칸 위에서도 제 색을 지켜야 하는 것은 끈다.
   */
  lock?: boolean;
}

const optionsOf = new WeakMap<THREE.Material, PaintOptions>();

/** paintMaterial 로 만든 재질을 옵션만 바꿔 새로 만든다 (같은 소품의 색 지키는 판 등). 다른 재질이면 그대로 돌려준다. */
export function paintVariant(m: THREE.Material, overrides: PaintOptions): THREE.Material {
  const o = optionsOf.get(m);
  return o ? paintMaterial({ ...o, ...overrides }) : m;
}

/** 만화 음영 + 물감 얼룩 재질. 인스턴싱·인스턴스 색(플레이어 색)·꼭짓점 색을 모두 쓸 수 있다. */
export function paintMaterial(o: PaintOptions = {}): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({
    name: o.name ?? '',
    color: o.color ?? '#ffffff',
    map: o.map ?? null,
    vertexColors: !!o.vertexColors,
    side: o.side ?? THREE.FrontSide,
    gradientMap: toonRamp(),
  });
  optionsOf.set(m, { ...o });
  const wash = o.wash ?? 1;
  const sway = o.sway ?? 0;
  const lock = o.lock ?? true;
  if (sway > 0) m.defines = { ...(m.defines ?? {}), PAINT_SWAY: '' };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uPaintNoise = { value: paintNoise() };
    shader.uniforms.uPaintWash = { value: wash };
    shader.uniforms.uPaintSaturation = { value: PAINT_SATURATION };
    shader.uniforms.uTime = paintTime;
    shader.uniforms.uSway = { value: sway };
    if (lock) bindLockUniforms(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPaintWorld;\nuniform float uTime;\nuniform float uSway;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  #ifdef PAINT_SWAY
    // 바람: 소품마다 위치로 박자를 어긋나게 하고, 높이의 제곱만큼 끝이 휘게 한다.
    vec4 swayRoot = vec4( 0.0, 0.0, 0.0, 1.0 );
    #ifdef USE_INSTANCING
      swayRoot = instanceMatrix * swayRoot;
    #endif
    vec3 swayAt = ( modelMatrix * swayRoot ).xyz;
    float swayPhase = uTime * 0.9 + swayAt.x * 1.3 + swayAt.z * 0.9;
    float swayBend = max( transformed.y, 0.0 ) * max( transformed.y, 0.0 ) * uSway;
    transformed.x += ( sin( swayPhase ) + 0.35 * sin( swayPhase * 2.3 + 1.1 ) ) * swayBend;
    transformed.z += cos( swayPhase * 0.83 + 0.7 ) * swayBend * 0.55;
  #endif`,
      )
      .replace('#include <project_vertex>', WORLD_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform sampler2D uPaintNoise;\nuniform float uPaintWash;\nuniform float uPaintSaturation;\nvarying vec3 vPaintWorld;${lock ? LOCK_UNIFORMS : ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  // 물감 얼룩: 넓게 번진 농담과 붓 자국 크기의 농담을 세계 좌표에 붙여 둔다 (보드를 움직여도 칠이 따라온다).
  vec2 paintUv = vPaintWorld.xz + vPaintWorld.y * vec2( 0.37, -0.29 );
  float washLow = texture2D( uPaintNoise, paintUv * 0.08 ).g;
  float washMid = texture2D( uPaintNoise, paintUv * 0.31 + 0.5 ).g;
  diffuseColor.rgb *= 1.0 + uPaintWash * ( ( washLow - 0.5 ) * 0.24 + ( washMid - 0.5 ) * 0.14 );
  // 채도: 밝기는 두고 색만 밝기 축에서 더 멀리 민다.
  float paintLuma = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  diffuseColor.rgb = max( mix( vec3( paintLuma ), diffuseColor.rgb, uPaintSaturation ), 0.0 );`,
      );
    if (lock) shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', LOCK_FRAGMENT);
  };
  const cacheKey = `paint-v4${sway > 0 ? '-sway' : ''}${lock ? '-lock' : ''}`;
  m.customProgramCacheKey = () => cacheKey;
  return m;
}

// ───────────────────────── 수채화 후처리 ─────────────────────────

/** 먹선 색 (짙은 세피아)과 종이 색 (누런 양피지) */
export const INK_COLOR = '#3a2a1f';
export const PAPER_COLOR = '#f2e6cc';

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNoise;
uniform vec2 uRes;
uniform float uDpr;
uniform float uDepthRange;
uniform float uPersp;
uniform float uNear;
uniform float uFar;
uniform vec3 uInk;
uniform vec3 uPaper;
varying vec2 vUv;

float lum( vec3 c ) { return dot( c, vec3( 0.299, 0.587, 0.114 ) ); }

// 원근 카메라의 깊이 버퍼 값을 카메라에서의 거리의 역수로 바꾼다. 평면 위에서는 화면 좌표에 대해 일차식이다.
float invDist( float d ) { return ( uFar - d * ( uFar - uNear ) ) / ( uNear * uFar ); }

void main() {
  vec2 px = 1.0 / uRes;
  // 기기 해상도와 관계없이 종이 결과 붓 자국 크기가 같도록 CSS 픽셀 좌표로 잡음을 읽는다.
  vec2 css = gl_FragCoord.xy / uDpr / 256.0;
  vec4 nWob = texture2D( tNoise, css * 0.6 );
  vec4 nFine = texture2D( tNoise, css * 1.7 );
  vec4 nWash = texture2D( tNoise, css * 0.11 );

  // 손으로 그린 듯 흔들리는 가장자리
  vec2 uv = vUv + ( nWob.ba - 0.5 ) * 2.4 * uDpr * px;
  vec3 col = texture2D( tColor, uv ).rgb;
  float d = texture2D( tDepth, uv ).x;

  // 이웃 픽셀과의 깊이·밝기 차이로 먹선을 찾는다.
  float o = max( 1.0, 0.85 * uDpr );
  vec2 dx = vec2( o * px.x, 0.0 );
  vec2 dy = vec2( 0.0, o * px.y );
  float d1 = texture2D( tDepth, uv + dx ).x;
  float d2 = texture2D( tDepth, uv - dx ).x;
  float d3 = texture2D( tDepth, uv + dy ).x;
  float d4 = texture2D( tDepth, uv - dy ).x;
  float depthInk;
  if ( uPersp > 0.5 ) {
    // 원근(승리 연출의 길 위 카메라): 깊이 차이 그대로 쓰면 멀리 비스듬한 땅이 온통 먹선이 된다.
    // 거리 역수는 평면 위에서 곧게 변하므로 그 굽음(이웃과의 2차 차분)이 큰 곳, 곧 윤곽과 꺾인 모서리에만 먹선을 긋는다.
    float w0 = invDist( d );
    float lap = max( abs( invDist( d1 ) + invDist( d2 ) - 2.0 * w0 ), abs( invDist( d3 ) + invDist( d4 ) - 2.0 * w0 ) ) / w0;
    depthInk = smoothstep( 0.05, 0.16, lap );
  } else {
    float dz = max( max( abs( d1 - d ), abs( d2 - d ) ), max( abs( d3 - d ), abs( d4 - d ) ) ) * uDepthRange;
    depthInk = smoothstep( 0.035, 0.12, dz );
  }

  float l = lum( col );
  float l1 = lum( texture2D( tColor, uv + dx ).rgb );
  float l2 = lum( texture2D( tColor, uv - dx ).rgb );
  float l3 = lum( texture2D( tColor, uv + dy ).rgb );
  float l4 = lum( texture2D( tColor, uv - dy ).rgb );
  float dl = max( max( abs( l1 - l ), abs( l2 - l ) ), max( abs( l3 - l ), abs( l4 - l ) ) );
  float edge = smoothstep( 0.05, 0.2, dl );

  // 물감 농담: 넓은 얼룩과, 어두운 물감일수록 잘 보이는 알갱이
  col *= 1.0 + ( nWash.g - 0.5 ) * 0.12;
  col *= 1.0 - ( nFine.r - 0.5 ) * 0.11 * ( 0.2 + ( 1.0 - l ) );
  // 물감이 마르면서 칠한 가장자리에 고인 진한 테두리
  col *= 1.0 - edge * 0.2;
  // 밝은 곳에는 종이색이 비친다.
  col = mix( col, uPaper, 0.06 + 0.1 * smoothstep( 0.55, 1.0, l ) );
  col *= 0.975 + 0.035 * texture2D( tNoise, css * 3.3 ).r;
  // 먹선: 마른 붓처럼 군데군데 옅어진다.
  float ink = max( depthInk, edge * 0.45 ) * ( 0.65 + 0.35 * nFine.b );
  col = mix( col, uInk, ink * 0.85 );
  // 오래된 종이처럼 바깥이 따뜻하게 어두워진다.
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot( q, q ) * 0.2;

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** 장면을 화면 밖 버퍼에 그린 뒤 수채화 후처리를 입혀 캔버스에 옮긴다. */
export class PaintedRenderer {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    samples = 4,
  ) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      samples,
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(1, 1),
    });
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        tNoise: { value: paintNoise() },
        uRes: { value: new THREE.Vector2(1, 1) },
        uDpr: { value: 1 },
        uDepthRange: { value: 1 },
        uPersp: { value: 0 },
        uNear: { value: 0.1 },
        uFar: { value: 100 },
        uInk: { value: new THREE.Color(INK_COLOR) },
        uPaper: { value: new THREE.Color(PAPER_COLOR) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(1, Math.round(width * pixelRatio));
    const h = Math.max(1, Math.round(height * pixelRatio));
    this.target.setSize(w, h);
    this.material.uniforms.uRes.value.set(w, h);
    this.material.uniforms.uDpr.value = pixelRatio;
  }

  /** 낮은 품질에서는 버퍼 다중 샘플링(계단 현상 줄이기)을 끈다. */
  setSamples(samples: number): void {
    if (this.target.samples === samples) return;
    this.target.samples = samples;
    this.target.dispose();
  }

  render(scene: THREE.Scene, camera: THREE.OrthographicCamera | THREE.PerspectiveCamera): void {
    const u = this.material.uniforms;
    u.uDepthRange.value = camera.far - camera.near;
    u.uPersp.value = camera instanceof THREE.PerspectiveCamera ? 1 : 0;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quad, this.quadCamera);
  }

  dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
