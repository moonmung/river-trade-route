// 화면 전체를 덮는 투명한 캔버스에 3D 주사위 두 개를 그린다 (보드 렌더러와 따로 도는 작은 Three.js 장면).
// - 던지기 자리: 주사위가 자리 위에 놓여 있고, 누르면 들어 올려 흔들고, 끌면 손가락을 따라온다.
// - 던지면 physics.ts 가 끝까지 미리 계산한 궤적을 재생한다. 벽은 보드가 보이는 영역(위아래 HUD 사이)이다.
// - 만화 음영(볕은 따뜻하게, 그늘은 서늘하게) + 먹선 외곽 + 종이 위 물감 그림자로 수채화 보드와 맞춘다.
// - 움직이는 동안만 그리고, 쉬는 동안은 캔버스를 숨긴다.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { sfx } from '../sound/sfx';
import {
  DIE_HALF,
  DIE_HALF_DIAG,
  DIE_ROUND,
  FACE_NORMALS,
  FACE_VALUE,
  faceCorrection,
  levelled,
  planBlends,
  sampleRecording,
  simulate,
  type BodyStart,
  type Recording,
  type Wall,
} from './physics';

export type StageMode = 'off' | 'tray' | 'hold' | 'fly' | 'rest' | 'fade';

export interface StageResult {
  /** 두 주사위 가운데 위쪽의 화면 좌표 (합계를 띄울 자리) */
  x: number;
  y: number;
  /** 다 멈추기 전에 다음 연출이 끼어들어 끝났다 */
  interrupted: boolean;
}

export interface StageEvents {
  onMode: (mode: StageMode) => void;
}

/** 보드 쪽 조명과 같은 방향 (왼쪽 앞 위에서 비춘다) */
const LIGHT_DIR = new THREE.Vector3(-0.55, 1, 0.5).normalize();
const UP = new THREE.Vector3(0, 1, 0);
const INK = '#3a2a1f';
const ELEVATION = THREE.MathUtils.degToRad(68);
const FOV = 30;
/** 들어 올린 높이 */
const HOLD_HEIGHT = 1.2;
/** 두 주사위 사이 (중심 간 거리의 절반) */
const PAIR_GAP = 0.9;
/**
 * 내가 던질 때 서버가 정한 값을 이만큼까지 기다렸다가 날린다. 값을 알고 날려야 던진 직후 빙글빙글 도는 동안
 * 눈 방향을 몰래 맞출 수 있다 (같은 네트워크면 보통 수십 ms 라 손을 놓자마자 날아가는 것처럼 보인다).
 */
const THROW_WAIT_MS = 300;
/** 아주 늦게 온 값을 멈춘 뒤에 맞출 때: 한 번 더 톡 튀어 오르며 뒤집힌다 (거의 쓰지 않는 마지막 수단) */
const HOP_TIME = 0.42;
const HOP_HEIGHT = 0.95;
/** 멈춘 뒤 합계를 보여 주는 시간 */
export const REST_MS = 1700;
export const REST_SEVEN_MS = 2300;
const FADE_MS = 420;

const TABLE: Omit<Wall, 'n' | 'd'> = { bounce: 0.34, friction: 0.55 };
const SIDE: Omit<Wall, 'n' | 'd'> = { bounce: 0.5, friction: 0.18 };

function smooth(s: number): number {
  const x = Math.min(1, Math.max(0, s));
  return x * x * (3 - 2 * x);
}

// ───────────────────────── 그림 재료 ─────────────────────────

/** 눈 자리 (0~1 면 좌표). 둥근 모서리 안쪽 평평한 곳에 들어가게 0.27~0.73 에 둔다. */
const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
  6: [[0.28, 0.26], [0.72, 0.26], [0.28, 0.5], [0.72, 0.5], [0.28, 0.74], [0.72, 0.74]],
};

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 상아 몸체 위에 먹으로 찍은 눈 한 면 (종이 결과 물감 농담을 조금 넣는다) */
function faceTexture(value: number): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const rand = seeded(value * 977);
  const wash = g.createRadialGradient(size * 0.42, size * 0.38, size * 0.05, size * 0.5, size * 0.5, size * 0.75);
  wash.addColorStop(0, '#fbf3df');
  wash.addColorStop(0.65, '#f2e5c6');
  wash.addColorStop(1, '#e6d4ad');
  g.fillStyle = wash;
  g.fillRect(0, 0, size, size);
  // 물감 얼룩: 크고 옅은 점 몇 개
  for (let i = 0; i < 9; i++) {
    g.fillStyle = `rgba(${150 + rand() * 40}, ${110 + rand() * 30}, 60, ${0.035 + rand() * 0.04})`;
    g.beginPath();
    g.arc(rand() * size, rand() * size, 20 + rand() * 50, 0, Math.PI * 2);
    g.fill();
  }
  // 종이 결: 잔 알갱이
  for (let i = 0; i < 900; i++) {
    g.fillStyle = rand() < 0.5 ? `rgba(90, 64, 34, ${0.05 + rand() * 0.07})` : `rgba(255, 250, 235, ${0.08 + rand() * 0.1})`;
    g.fillRect(rand() * size, rand() * size, 1 + rand() * 1.4, 1 + rand() * 1.4);
  }
  const one = value === 1;
  for (const [u, v] of PIPS[value]) {
    const r = size * (one ? 0.135 : 0.083);
    const cx = u * size;
    const cy = v * size;
    // 붓으로 찍은 듯 둥근 테가 조금씩 흔들리는 점
    g.beginPath();
    const steps = 28;
    const phase = rand() * Math.PI * 2;
    for (let k = 0; k <= steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const rr = r * (1 + 0.035 * Math.sin(a * 3 + phase) + 0.02 * Math.sin(a * 5 + phase * 2));
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    const ink = g.createRadialGradient(cx - r * 0.25, cy - r * 0.3, r * 0.1, cx, cy, r);
    if (one) {
      ink.addColorStop(0, '#c0583f');
      ink.addColorStop(1, '#8f3322');
    } else {
      ink.addColorStop(0, '#4a3828');
      ink.addColorStop(1, '#221810');
    }
    g.fillStyle = ink;
    g.fill();
    // 마르며 가장자리에 고인 먹
    g.lineWidth = size * 0.012;
    g.strokeStyle = one ? 'rgba(90, 24, 14, 0.55)' : 'rgba(14, 9, 5, 0.6)';
    g.stroke();
    // 오목한 눈의 아래쪽에 비치는 옅은 빛
    g.beginPath();
    g.arc(cx, cy, r * 0.68, Math.PI * 0.15, Math.PI * 0.85);
    g.lineWidth = size * 0.01;
    g.strokeStyle = 'rgba(255, 240, 215, 0.22)';
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/** 만화 음영: 그늘·반그늘·볕 세 단계. 그늘은 보랏빛으로 서늘하게, 볕은 살짝 따뜻하게 칠한다. 색 계산은 물감처럼 sRGB 그대로 한다. */
function dieMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      lightDir: { value: LIGHT_DIR },
      cool: { value: new THREE.Color(0.7, 0.68, 0.83) },
      halfShade: { value: new THREE.Color(0.9, 0.87, 0.88) },
      warm: { value: new THREE.Color(1.04, 1.0, 0.94) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vView;
      void main() {
        vUv = uv;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec3 lightDir;
      uniform vec3 cool;
      uniform vec3 halfShade;
      uniform vec3 warm;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vView;
      void main() {
        vec3 base = texture2D(map, vUv).rgb;
        vec3 n = normalize(vNormalW);
        float ndl = dot(n, lightDir);
        float a = smoothstep(-0.08, 0.04, ndl);
        float b = smoothstep(0.5, 0.6, ndl);
        vec3 shade = mix(mix(cool, halfShade, a), warm, b);
        vec3 col = base * shade;
        // 비스듬한 가장자리는 물감이 고인 듯 조금 짙게
        float rim = pow(1.0 - max(dot(n, normalize(vView)), 0.0), 3.0);
        col *= 1.0 - rim * 0.2;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

/** 바닥에 번진 물감 그림자 (가운데 짙고 가장자리로 풀린다) */
function shadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ───────────────────────── 장면 ─────────────────────────

interface DieView {
  group: THREE.Group;
  shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** 지금 그린 자세 (던질 때 이어 받는다) */
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  /** 손에 들고 흔들 때 도는 속도 */
  shake: THREE.Vector3;
  shakeAt: number;
}

interface Flight {
  rec: Recording;
  start: number;
  mine: boolean;
  /** 눈 방향 회전 (값이 오면 정한다) */
  fix: (THREE.Quaternion | null)[];
  /** 그 회전을 섞는 공중 구간. null 이면 처음부터 붙인다 */
  blend: ([number, number] | null)[];
  /** 멈춘 뒤 한 번 더 튀며 맞춰야 하는 주사위 */
  hop: boolean[];
  /** 그 튀기를 시작하는 시각 (던진 뒤 초) */
  hopAt: number;
  /** 진동을 낸 마지막 부딪힘 순번 */
  impactIndex: number;
  /** 소리를 낸 마지막 부딪힘 순번 */
  soundIndex: number;
  values: [number, number] | null;
}

interface PointerSample {
  x: number;
  y: number;
  t: number;
}

export class DiceStage {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400);
  private raycaster = new THREE.Raycaster();
  private dice: DieView[] = [];
  private mode: StageMode = 'off';
  private width = 1;
  private height = 1;
  /** 바닥 높이에서 주사위 한 변이 차지하는 화면 픽셀 */
  private unitPx = 60;
  private walls: Wall[] = [];
  private tray: HTMLElement | null = null;
  private trayHidden = false;
  private flight: Flight | null = null;
  private frame = 0;
  private holdStart = 0;
  private pointer: PointerSample[] = [];
  private holdTarget = new THREE.Vector3();
  private restTimer = 0;
  private fadeTimer = 0;
  private settleTimer = 0;
  /** 흔드는 달그락 소리를 마지막으로 낸 때 */
  private shakeSoundAt = 0;
  private settleResolve: ((interrupted: boolean) => void) | null = null;
  /** 손을 놓았지만 서버 값을 기다리느라 아직 날리지 않은 내 굴림 */
  private queued: { dir: THREE.Vector3; speed: number; lift: number; rand: () => number; timer: number } | null = null;
  private readonly onResize = () => this.resize();

  constructor(private events: StageEvents) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dice-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.appendChild(this.canvas);

    const geometry = new RoundedBoxGeometry(1, 1, 1, 4, DIE_ROUND);
    const materials = FACE_VALUE.map((v) => dieMaterial(faceTexture(v)));
    const outline = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
    const shadowMap = shadowTexture();
    for (let i = 0; i < 2; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(geometry, materials);
      const hull = new THREE.Mesh(geometry, outline);
      hull.scale.setScalar(1.06);
      group.add(hull, body);
      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: shadowMap, color: '#2e2442', transparent: true, depthWrite: false, opacity: 0.4 }),
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.renderOrder = -1;
      this.scene.add(shadow, group);
      this.dice.push({ group, shadow, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), shake: new THREE.Vector3(), shakeAt: 0 });
    }
    window.addEventListener('resize', this.onResize);
    this.resize();
    this.setVisible(false);
  }

  dispose(): void {
    this.dropQueued();
    window.removeEventListener('resize', this.onResize);
    cancelAnimationFrame(this.frame);
    this.renderer.dispose();
    this.canvas.remove();
  }

  get currentMode(): StageMode {
    return this.mode;
  }

  // ───────── 던지기 자리 ─────────

  /** 던지기 자리를 보여 준다. 주사위가 그 위로 모여 놓인다. */
  showTray(el: HTMLElement, faces: [number, number]): void {
    this.tray = el;
    this.trayHidden = false;
    this.finishShow();
    if (this.mode === 'off') {
      // 처음 나타날 때는 자리 위에 바로 놓는다.
      const spots = this.traySpots(0);
      this.dice.forEach((d, i) => {
        d.pos.copy(spots[i]);
        d.quat.copy(this.restingQuat(faces[i], i === 0 ? -0.25 : 0.2));
      });
    } else {
      // 지난 굴림이 남아 있으면 자리로 굴러 모이게 한다.
      this.dice.forEach((d, i) => d.quat.copy(levelled(d.quat)));
    }
    this.flight = null;
    this.setMode('tray');
  }

  /** 던지기 자리를 치운다 (단계가 바뀌거나 화면을 떠날 때). 던지는 중이면 그대로 둔다. */
  hideTray(): void {
    this.tray = null;
    if (this.mode === 'tray' || this.mode === 'hold') this.setMode('off');
  }

  /** 다른 창(발전 카드)이 열린 동안 자리 위 주사위를 숨긴다 */
  setTrayHidden(hidden: boolean): void {
    this.trayHidden = hidden;
    if (this.mode === 'hold' && hidden) this.setMode('tray');
    this.kick();
  }

  grab(x: number, y: number): void {
    if (this.mode !== 'tray') return;
    this.holdStart = performance.now();
    this.pointer = [{ x, y, t: this.holdStart }];
    this.holdTarget.copy(this.groundAt(x, y, HOLD_HEIGHT));
    this.setMode('hold');
  }

  drag(x: number, y: number): void {
    if (this.mode !== 'hold') return;
    const t = performance.now();
    this.pointer.push({ x, y, t });
    while (this.pointer.length > 2 && t - this.pointer[0].t > 140) this.pointer.shift();
    this.holdTarget.copy(this.groundAt(x, y, HOLD_HEIGHT));
  }

  /** 손을 놓았지만 던지지 않는다 (터치가 취소된 때) */
  drop(): void {
    if (this.mode === 'hold') this.setMode('tray');
  }

  // ───────── 던지기 ─────────

  /**
   * 내가 던진다. 들고 있었다면 손을 놓는 빠르기와 방향으로, 아니면(버튼·시간 끝) 보드 가운데 쪽으로 던진다.
   * 던질 방향과 세기는 지금 정해 두고, 서버 값이 reveal 로 오면(늦어도 THROW_WAIT_MS 뒤에는) 날린다.
   */
  throwMine(): void {
    const holding = this.mode === 'hold';
    if (this.mode !== 'tray' && this.mode !== 'hold') {
      this.finishShow();
      const spots = this.traySpots(0);
      this.dice.forEach((d, i) => {
        d.pos.copy(spots[i]);
        d.quat.copy(this.restingQuat(1 + i * 3, 0));
      });
    }
    this.updateWalls();
    const seed = (performance.now() * 1000) >>> 0;
    const rand = seeded(seed);
    let dir: THREE.Vector3;
    let speed: number;
    let lift = 0;
    const strength = holding ? Math.min(1, Math.max(0.35, (performance.now() - this.holdStart) / 800)) : 0.6;
    const flick = holding ? this.flickVelocity() : null;
    if (flick && flick.length() > 3.2) {
      speed = THREE.MathUtils.clamp(flick.length() * 0.85, 7.5, 17);
      dir = flick.setY(0).normalize();
      lift = THREE.MathUtils.clamp(flick.length() * 0.04, 0, 1);
    } else {
      dir = this.towardBoard(rand);
      speed = 8.5 + strength * 5 + rand() * 1.5;
    }
    this.dropQueued();
    // 손에서 놓은 자리에 잠깐 멈춰 있다가 값이 오면 날아간다. 'fly' 로 두어야 던지기 자리가 닫혀도 사라지지 않는다.
    this.flight = null;
    this.setMode('fly');
    const timer = window.setTimeout(() => this.launchQueued(), THROW_WAIT_MS);
    this.queued = { dir, speed, lift, rand, timer };
  }

  /** 기다리던 내 굴림을 날린다. 값이 이미 왔으면 그 값으로 멈추게 붙인다. */
  private launchQueued(values?: [number, number]): void {
    const q = this.queued;
    if (!q) return;
    this.dropQueued();
    this.launch(q.dir, q.speed, q.lift, q.rand, true);
    if (values) this.attachValues(values, false);
  }

  private dropQueued(): void {
    if (this.queued) window.clearTimeout(this.queued.timer);
    this.queued = null;
  }

  /** 아직 값이 없는 내 굴림을 거둔다 (서버가 거절한 때) */
  cancel(): void {
    if (this.queued) {
      this.dropQueued();
      this.fadeOut();
    } else if (this.flight?.mine && !this.flight.values) {
      this.flight = null;
      this.fadeOut();
    }
  }

  /** 던졌지만 아직 서버 값을 받지 못한 내 굴림이 있는지 */
  get waiting(): boolean {
    return !!this.queued || (!!this.flight?.mine && !this.flight.values);
  }

  /**
   * 서버가 정한 값을 받는다. 내가 던진 굴림이 날고 있으면 그 굴림에 붙이고, 아니면 from 쪽에서 새로 던진다.
   * 주사위가 다 멈추면(합계를 띄울 때) resolve 한다.
   */
  reveal(values: [number, number], from: 'near' | 'far' | null): Promise<StageResult> {
    if (this.queued && from === null) {
      this.launchQueued(values);
    } else if (!this.flight || !this.flight.mine || this.flight.values) {
      this.finishShow();
      const rand = seeded(values[0] * 7 + values[1] * 131 + ((performance.now() * 10) >>> 0));
      this.updateWalls();
      this.placeForRemote(from ?? 'far', rand);
      const dir = from === 'near' ? this.towardBoard(rand) : this.towardViewer(rand);
      this.launch(dir, 8 + rand() * 3, 0, rand, false);
      this.attachValues(values, true);
    } else {
      this.attachValues(values, false);
    }
    return new Promise<StageResult>((resolve) => {
      this.settleResolve = (interrupted) => resolve({ ...this.restSpot(), interrupted });
      this.scheduleSettle();
    });
  }

  private launch(dir: THREE.Vector3, speed: number, lift: number, rand: () => number, mine: boolean): void {
    const side = new THREE.Vector3().crossVectors(UP, dir).normalize();
    const mid = this.dice[0].pos.clone().add(this.dice[1].pos).multiplyScalar(0.5);
    const starts: BodyStart[] = this.dice.map((d, i) => {
      const spread = d.pos.clone().sub(mid).setY(0);
      const pos = this.insideWalls(d.pos.clone());
      // 기운 채로 들고 있었으면 가장 낮은 꼭짓점이 바닥 위에 오도록 올린다.
      let low = 0;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const c = new THREE.Vector3(sx, sy, sz).multiplyScalar(DIE_HALF - DIE_ROUND).applyQuaternion(d.quat);
        low = Math.max(low, -c.y + DIE_ROUND);
      }
      pos.y = Math.max(pos.y, low + 0.01);
      const turn = (rand() - 0.5) * 0.18;
      const heading = dir.clone().applyAxisAngle(UP, turn);
      const vel = heading.multiplyScalar(speed * (0.93 + rand() * 0.14));
      vel.addScaledVector(spread.lengthSq() > 1e-4 ? spread.normalize() : side.clone().multiplyScalar(i ? 1 : -1), 0.9);
      vel.y = 3.6 + rand() * 1.8 + lift * 2;
      // 앞으로 구르는 회전 + 제멋대로 도는 회전
      const roll = new THREE.Vector3().crossVectors(UP, heading).normalize().multiplyScalar(12 + rand() * 9);
      const wild = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(16);
      const spin = roll.add(wild).addScaledVector(d.shake, 0.3);
      return { pos, quat: d.quat.clone(), vel, spin };
    });
    const rec = simulate(starts, this.walls);
    window.clearTimeout(this.settleTimer);
    this.flight = { rec, start: performance.now(), mine, fix: [null, null], blend: [null, null], hop: [false, false], hopAt: rec.duration, impactIndex: 0, soundIndex: 0, values: null };
    this.setMode('fly');
    sfx.diceThrow();
  }

  private attachValues(values: [number, number], fromStart: boolean): void {
    const f = this.flight;
    if (!f) return;
    f.values = values;
    const now = (performance.now() - f.start) / 1000;
    const fixes = values.map((v, i) => faceCorrection(f.rec.top[i], v));
    // 남의 굴림은 주사위가 처음 나타날 때부터 붙여 둔다. 내 굴림은 지금 이후로 섞어도 티 나지 않는 구간을 찾는다
    // (값을 받고 날렸으면 던진 직후 빙글빙글 도는 동안이다).
    const plan = fromStart ? fixes.map(() => null) : planBlends(f.rec, fixes, now + 0.02, this.walls);
    for (let i = 0; i < 2; i++) {
      f.fix[i] = fixes[i];
      const win = plan[i];
      if (win !== 'none') {
        f.blend[i] = win;
        continue;
      }
      // 그런 구간이 끝내 없으면(값이 아주 늦게 온 때) 멈춘 뒤 한 번 더 튀며 맞춘다.
      f.blend[i] = [Infinity, Infinity];
      f.hop[i] = true;
      f.hopAt = Math.max(f.rec.duration, now + 0.05);
    }
  }

  /** 던진 뒤 다 멈추기까지 남은 시간 (초) */
  private flightLength(f: Flight): number {
    return f.hop.some(Boolean) ? f.hopAt + HOP_TIME : f.rec.duration;
  }

  private scheduleSettle(): void {
    const f = this.flight;
    if (!f) return;
    window.clearTimeout(this.settleTimer);
    const left = this.flightLength(f) * 1000 - (performance.now() - f.start);
    // 화면이 가려져 그리기가 멈춰도 시간에 맞춰 끝낸다.
    this.settleTimer = window.setTimeout(() => this.settle(), Math.max(0, left));
  }

  private settle(): void {
    const f = this.flight;
    if (!f || !f.values) return;
    // 화면이 가려져 그리기가 멈췄어도 합계 자리는 마지막 자세로 잰다.
    this.poseFlight(f, Infinity);
    this.setMode('rest');
    const resolve = this.settleResolve;
    this.settleResolve = null;
    resolve?.(false);
    const seven = f.values[0] + f.values[1] === 7;
    window.clearTimeout(this.restTimer);
    this.restTimer = window.setTimeout(() => this.fadeOut(), seven ? REST_SEVEN_MS : REST_MS);
  }

  /** 지난 굴림 연출을 바로 끝낸다 (다음 굴림이나 던지기 자리가 올 때). 기다리던 쪽에는 멈춘 것으로 알린다. */
  private finishShow(): void {
    this.dropQueued();
    window.clearTimeout(this.settleTimer);
    window.clearTimeout(this.restTimer);
    window.clearTimeout(this.fadeTimer);
    const resolve = this.settleResolve;
    this.settleResolve = null;
    resolve?.(true);
    if (this.flight) {
      // 지금 보이는 자세에서 이어 가도록 멈춘 자리로 옮겨 둔다.
      this.poseFlight(this.flight, Infinity);
      this.flight = null;
    }
    this.canvas.style.transition = 'none';
    this.canvas.style.opacity = '1';
  }

  private fadeOut(): void {
    if (this.mode === 'off') return;
    this.setMode('fade');
    this.canvas.style.transition = `opacity ${FADE_MS}ms ease`;
    this.canvas.style.opacity = '0';
    window.clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => {
      this.flight = null;
      this.setMode('off');
      this.canvas.style.transition = 'none';
      this.canvas.style.opacity = '1';
    }, FADE_MS);
  }

  private restSpot(): Omit<StageResult, 'interrupted'> {
    const mid = this.dice[0].pos.clone().add(this.dice[1].pos).multiplyScalar(0.5);
    mid.y = DIE_HALF * 2 + 0.4;
    const p = mid.project(this.camera);
    return { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height };
  }

  // ───────── 좌표 ─────────

  private resize(): void {
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.width, this.height, false);
    this.unitPx = THREE.MathUtils.clamp(Math.min(this.width, this.height) * 0.075, 40, 56);
    const distance = this.height / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * this.unitPx);
    this.camera.aspect = this.width / this.height;
    this.camera.position.set(0, Math.sin(ELEVATION) * distance, Math.cos(ELEVATION) * distance);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.kick();
  }

  /** 화면 좌표 (x, y) 아래 높이 h 의 평면 위 점 */
  private groundAt(x: number, y: number, h = 0): THREE.Vector3 {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(UP, -h);
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3()) ?? new THREE.Vector3(0, h, 0);
  }

  /** 보드가 보이는 영역 (위아래 HUD 와 넓은 화면의 오른쪽 패널을 뺀다) */
  private region(): { left: number; top: number; right: number; bottom: number } {
    const rect = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : null;
    };
    const top = rect('.hud-top')?.bottom ?? 70;
    let bottom = rect('.hud-bottom')?.top ?? this.height - 160;
    const side = rect('.hud-side');
    const right = side && side.left > this.width * 0.4 ? side.left : this.width;
    const trayRect = this.tray?.getBoundingClientRect();
    if (trayRect && trayRect.bottom > bottom) bottom = trayRect.bottom;
    let t = top + 6;
    const b = bottom - 4;
    // 너무 좁으면 위쪽 HUD 위까지 쓴다.
    const minHeight = this.unitPx * 5;
    if (b - t < minHeight) t = Math.max(0, b - minHeight);
    return { left: 6, top: t, right: right - 6, bottom: b };
  }

  private updateWalls(): void {
    const r = this.region();
    const bl = this.groundAt(r.left, r.bottom);
    const br = this.groundAt(r.right, r.bottom);
    const tl = this.groundAt(r.left, r.top);
    const tr = this.groundAt(r.right, r.top);
    const center = bl.clone().add(br).add(tl).add(tr).multiplyScalar(0.25);
    const wall = (a: THREE.Vector3, b: THREE.Vector3): Wall => {
      const e = b.clone().sub(a);
      const n = new THREE.Vector3(e.z, 0, -e.x).normalize();
      if (n.dot(center.clone().sub(a)) < 0) n.negate();
      return { n, d: n.dot(a), ...SIDE };
    };
    this.walls = [{ n: UP.clone(), d: 0, ...TABLE }, wall(bl, tl), wall(br, tr), wall(tl, tr), wall(bl, br)];
  }

  /** 벽 안쪽으로 끌어들인다 (꼭짓점이 벽을 넘지 않게) */
  private insideWalls(p: THREE.Vector3): THREE.Vector3 {
    for (const w of this.walls) {
      if (w.n.y > 0.5) continue;
      const dist = w.n.dot(p) - w.d;
      const need = DIE_HALF_DIAG + 0.02;
      if (dist < need) p.addScaledVector(w.n, need - dist);
    }
    return p;
  }

  /** 던지기 자리 위 두 주사위 자리 (높이 h) */
  private traySpots(h: number): THREE.Vector3[] {
    const rect = this.tray?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : this.width / 2;
    const cy = rect ? rect.top + rect.height * 0.68 : this.region().bottom - this.unitPx * 1.4;
    const c = this.groundAt(cx, cy, 0);
    return [-1, 1].map((s) => new THREE.Vector3(c.x + s * PAIR_GAP, DIE_HALF + h, c.z));
  }

  /** 면 value 가 위를 보고 수평으로 yaw 만큼 돈 자세 */
  private restingQuat(value: number, yaw: number): THREE.Quaternion {
    const face = Math.max(0, FACE_VALUE.indexOf(value));
    const q = new THREE.Quaternion().setFromUnitVectors(FACE_NORMALS[face], UP);
    return new THREE.Quaternion().setFromAxisAngle(UP, yaw).multiply(q);
  }

  /** 들고 있던 손이 놓는 순간의 빠르기 (바닥 평면 단위/초) */
  private flickVelocity(): THREE.Vector3 | null {
    const s = this.pointer;
    if (s.length < 2) return null;
    const last = s[s.length - 1];
    if (performance.now() - last.t > 120) return null;
    let first = s[0];
    for (const p of s) if (last.t - p.t <= 90) {
      first = p;
      break;
    }
    const dt = (last.t - first.t) / 1000;
    if (dt < 0.012) return null;
    const a = this.groundAt(first.x, first.y, HOLD_HEIGHT);
    const b = this.groundAt(last.x, last.y, HOLD_HEIGHT);
    return b.sub(a).divideScalar(dt);
  }

  /** 자리에서 보드 가운데 위쪽을 향하는 방향 */
  private towardBoard(rand: () => number): THREE.Vector3 {
    const r = this.region();
    const target = this.groundAt((r.left + r.right) / 2 + (rand() - 0.5) * this.unitPx * 2, r.top + (r.bottom - r.top) * 0.3);
    const mid = this.dice[0].pos.clone().add(this.dice[1].pos).multiplyScalar(0.5);
    const dir = target.sub(mid).setY(0);
    return dir.lengthSq() > 1e-4 ? dir.normalize() : new THREE.Vector3(0, 0, -1);
  }

  /** 맞은편(화면 위쪽)에서 내 쪽으로 */
  private towardViewer(rand: () => number): THREE.Vector3 {
    const r = this.region();
    const target = this.groundAt((r.left + r.right) / 2 + (rand() - 0.5) * this.unitPx * 2.5, r.top + (r.bottom - r.top) * 0.72);
    const mid = this.dice[0].pos.clone().add(this.dice[1].pos).multiplyScalar(0.5);
    const dir = target.sub(mid).setY(0);
    return dir.lengthSq() > 1e-4 ? dir.normalize() : new THREE.Vector3(0, 0, 1);
  }

  /** 남이 던진 주사위는 화면 위쪽(맞은편)에서, 내가 다른 곳에서 던진 것은 아래쪽에서 날아든다 */
  private placeForRemote(from: 'near' | 'far', rand: () => number): void {
    const r = this.region();
    const y = from === 'far' ? r.top + this.unitPx * 0.6 : r.bottom - this.unitPx * 0.9;
    const c = this.groundAt((r.left + r.right) / 2 + (rand() - 0.5) * this.unitPx, y, 0);
    this.dice.forEach((d, i) => {
      d.pos.set(c.x + (i ? 1 : -1) * PAIR_GAP, from === 'far' ? 2.1 : 1.4, c.z);
      d.quat.setFromAxisAngle(new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), rand() * Math.PI * 2);
      d.shake.set(0, 0, 0);
    });
  }

  // ───────── 그리기 ─────────

  private setMode(mode: StageMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.setVisible(mode !== 'off');
    this.events.onMode(mode);
    this.kick();
  }

  private setVisible(on: boolean): void {
    this.canvas.style.display = on ? 'block' : 'none';
    if (!on) this.renderer.clear();
  }

  private kick(): void {
    window.clearTimeout(this.idleTimer);
    this.dirty = true;
    if (this.mode === 'off' || this.frame) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  /** 주사위가 가만히 있으면(자리 위에서 기다리거나 멈춘 뒤 합계를 보일 때) 다시 그리지 않고 가끔 자리만 살핀다 */
  private idleTimer = 0;
  private dirty = true;

  private tick = (now: number) => {
    this.frame = 0;
    if (this.mode === 'off') return;
    const moved = this.update(now);
    if (moved || this.dirty) this.renderer.render(this.scene, this.camera);
    this.dirty = false;
    if (moved || this.mode === 'fly' || this.mode === 'hold') {
      this.frame = requestAnimationFrame(this.tick);
    } else {
      this.lastFrame = 0;
      this.idleTimer = window.setTimeout(() => {
        if (!this.frame && this.mode !== 'off') this.frame = requestAnimationFrame(this.tick);
      }, 250);
    }
  };

  private lastFrame = 0;

  /** 주사위를 이번 프레임 자세로 옮긴다. 눈에 띄게 움직였으면 true */
  private update(now: number): boolean {
    const dt = Math.min(0.05, this.lastFrame ? (now - this.lastFrame) / 1000 : 0.016);
    this.lastFrame = now;
    const hiddenInTray = (this.mode === 'tray' || this.mode === 'hold') && (this.trayHidden || !this.tray);
    let moved = this.dice[0].group.visible === hiddenInTray;
    for (const d of this.dice) d.group.visible = d.shadow.visible = !hiddenInTray;

    if (this.mode === 'tray') {
      const spots = this.traySpots(0);
      this.dice.forEach((d, i) => {
        // 지난 굴림에서 자리로 모일 때는 살짝 들려 굴러온다.
        const k = 1 - Math.exp(-dt * 9);
        const far = d.pos.distanceTo(spots[i]);
        d.pos.lerp(spots[i], k);
        d.pos.y = DIE_HALF + Math.min(0.6, far * 0.25);
        const rest = levelled(d.quat);
        d.quat.slerp(rest, k);
        d.shake.multiplyScalar(Math.exp(-dt * 6));
      });
    } else if (this.mode === 'hold') {
      const t = (now - this.holdStart) / 1000;
      const lift = smooth(t / 0.14);
      const amp = 0.07 + Math.min(1, t / 0.8) * 0.08;
      const spots = this.traySpots(0);
      const target = this.holdTarget;
      const k = 1 - Math.exp(-dt * 18);
      this.dice.forEach((d, i) => {
        const sign = i ? 1 : -1;
        const home = new THREE.Vector3(target.x + sign * PAIR_GAP * 0.92, HOLD_HEIGHT, target.z);
        // 흔들기: 손안에서 이리저리 부딪히듯 작게 떨리며 돈다.
        home.x += Math.sin(t * 47 + i * 2.1) * amp;
        home.z += Math.cos(t * 39 + i * 1.3) * amp;
        home.y += Math.abs(Math.sin(t * 31 + i)) * amp * 1.2;
        const ground = spots[i];
        const goal = ground.clone().lerp(home, lift);
        d.pos.lerp(goal, k);
        if (now - d.shakeAt > 85) {
          d.shakeAt = now;
          // 손안에서 부딪히는 달그락 소리 (두 주사위가 번갈아, 너무 촘촘하지 않게)
          if (now - this.shakeSoundAt > 110 && Math.random() < 0.75) {
            this.shakeSoundAt = now;
            sfx.diceShake();
          }
          d.shake.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(8 + Math.random() * 6);
        }
        const w = d.shake;
        const spin = new THREE.Quaternion().setFromAxisAngle(w.clone().normalize(), w.length() * dt * lift);
        d.quat.premultiply(spin).normalize();
      });
    } else if (this.queued && !this.flight) {
      // 손을 놓고 서버 값을 기다리는 잠깐: 멈춰 보이지 않게 흔들던 회전만 이어 간다.
      for (const d of this.dice) {
        if (d.shake.lengthSq() < 1e-4) continue;
        d.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(d.shake.clone().normalize(), d.shake.length() * dt)).normalize();
      }
    } else if (this.flight && (this.mode === 'fly' || this.mode === 'rest' || this.mode === 'fade')) {
      const f = this.flight;
      const t = (now - f.start) / 1000;
      this.poseFlight(f, t);
      this.clack(f, t);
      if (f.mine) this.vibrate(f, t);
    }

    for (const d of this.dice) {
      if (d.group.position.distanceToSquared(d.pos) > 1e-8 || 1 - Math.abs(d.group.quaternion.dot(d.quat)) > 1e-9) moved = true;
      d.group.position.copy(d.pos);
      d.group.quaternion.copy(d.quat);
      // 그림자는 빛 반대쪽(오른쪽 뒤)으로 높이만큼 밀리고, 높이 뜰수록 옅고 넓어진다.
      const h = Math.max(0, d.pos.y - DIE_HALF);
      d.shadow.position.set(d.pos.x + h * 0.42, 0.002, d.pos.z - h * 0.38);
      d.shadow.scale.setScalar(1.55 + h * 0.35);
      d.shadow.material.opacity = 0.42 * Math.max(0.15, 1 - h / 3.2);
    }
    return moved;
  }

  /** 기록의 t 초 자세에 눈 방향 회전을 붙여 주사위에 놓는다 */
  private poseFlight(f: Flight, t: number): void {
    const end = f.rec.duration;
    for (let i = 0; i < 2; i++) {
      const d = this.dice[i];
      sampleRecording(f.rec, i, Math.min(t, end), d.pos, d.quat);
      const fix = f.fix[i];
      if (!fix) continue;
      const win = f.blend[i];
      if (f.hop[i]) {
        // 멈춘 뒤에 값이 왔다: 한 번 더 튀어 오르며 맞는 면으로 뒤집힌다.
        const s = Math.min(1, Math.max(0, (t - f.hopAt) / HOP_TIME));
        d.pos.y += 4 * HOP_HEIGHT * s * (1 - s);
        const turn = smooth((s - 0.2) / 0.6);
        d.quat.multiply(new THREE.Quaternion().slerp(fix, turn));
        continue;
      }
      const s = win ? smooth((t - win[0]) / Math.max(1e-3, win[1] - win[0])) : 1;
      if (s > 0) d.quat.multiply(new THREE.Quaternion().slerp(fix, s));
    }
  }

  /** 기록된 부딪힘마다 딱 소리를 낸다 (세게 부딪힐수록 크게). 화면이 한참 멈췄다 오면 밀린 소리는 버린다. */
  private clack(f: Flight, t: number): void {
    const list = f.rec.impacts;
    while (f.soundIndex < list.length && list[f.soundIndex].t <= t) {
      const hit = list[f.soundIndex++];
      if (t - hit.t > 0.12 || f.soundIndex > 18) continue;
      sfx.diceHit(hit.speed);
    }
  }

  private vibrate(f: Flight, t: number): void {
    const list = f.rec.impacts;
    while (f.impactIndex < list.length && list[f.impactIndex].t <= t) {
      const hit = list[f.impactIndex++];
      if (hit.speed < 3 || f.impactIndex > 6) continue;
      const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
      if (activation && !activation.hasBeenActive) continue;
      try {
        navigator.vibrate?.(Math.min(22, Math.round(hit.speed * 2)));
      } catch {
        /* 진동을 지원하지 않는 기기 */
      }
    }
  }
}
