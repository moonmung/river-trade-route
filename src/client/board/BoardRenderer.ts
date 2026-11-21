// Three.js(WebGL 2) 보드 렌더러.
// - 비스듬한 직교 카메라 + 이동·확대 (회전 없음)
// - 타일 단위 터치 판정 (장식이 아니라 타일 상자에 광선을 쏜다)
// - 반복 소품은 InstancedMesh, 건물 아래 그림자는 미리 구운 텍스처
// - 카메라 조작, 크기 변경, 상태 변경, 짧은 연출 중에만 다시 그린다 (정지 화면은 마지막 프레임 유지)
// - 만화 음영 재질과 수채화 후처리(먹선·종이 결·물감 얼룩)로 손으로 그린 삽화처럼 보이게 한다 (paint.ts)
import * as THREE from 'three';
import { boardGeometry, type BoardGeometry } from '../../shared/board';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { RESOURCES, RESOURCE_LABEL, numberPips } from '../../shared/constants';
import type { Harbor, Resource, TileDef, TileKind } from '../../shared/types';
import type { PropKey } from './art/builders';
import { loadArtLibrary, type ArtLibrary, type ArtReport, type GroundTextureKey, type LoadProgress } from './assets';
import {
  DAIS_HEIGHT,
  HEX_APOTHEM,
  HEX_RADIUS,
  HEX_SPACING,
  PLATFORM_TOP,
  PLAZA_STATUE_SPOT,
  STATUE_SPOT,
  TOKEN_SPOT,
  TILE_THICKNESS,
  TILE_TOP,
  boardMetrics,
  hexCorners,
  tileCenter,
  tilePlacements,
  type BoardMetrics,
  type Placement,
} from './layout';
import { hashString, mulberry32, smoothstep } from './art/rng';
import { PaintedRenderer, paintMaterial, paintTime } from './paint';
import { PerfMeter, type PerfRecording, type PerfStats } from './perf';

export type HighlightKind = 'buildable' | 'placeable';
export type QualityMode = 'auto' | 'high' | 'low';

/** 보드에서 고른 것: 타일, 꼭짓점(마을·도시 자리), 변(길 자리) */
export interface BoardSelection {
  kind: 'tile' | 'vertex' | 'edge';
  id: string;
}

export interface BoardBuildingView {
  vertexId: string;
  kind: 'village' | 'city';
  owner: string;
  colorIndex: number;
  /** 접근성/툴팁용 설명 */
  label: string;
}

export interface BoardRoadView {
  edgeId: string;
  owner: string;
  colorIndex: number;
}

export interface BoardState {
  buildings: BoardBuildingView[];
  roads: BoardRoadView[];
  /** 빛낼 꼭짓점·변·칸 (시작 배치·건설 모드에서 지을 수 있는 자리, 기사단 동상을 옮길 수 있는 칸) */
  highlights: { vertices: string[]; edges: string[]; tiles?: string[]; kind: HighlightKind } | null;
  selected: BoardSelection | null;
  /** 칸마다 놓인 숫자 패 (2~12). 없으면 숫자 패를 그리지 않는다. */
  numbers?: Record<string, number>;
  /** 기사단 동상이 선 칸 (없으면 광장 칸) */
  robber?: string | null;
  /** 해상 교역로 */
  harbors?: readonly Harbor[];
  /** 건설 모드가 아닐 때 내 차례에 은은하게 보여 주는 안내: 길을 이을 수 있는 변(점선), 마을을 지을 수 있는 꼭짓점(고리) */
  hints?: { vertices: string[]; edges: string[] } | null;
  /** 금빛으로 따라 그릴 길 (마우스를 올린 길 주인의 가장 긴 교역로) */
  trace?: string[] | null;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface BoardOptions {
  tiles: readonly TileDef[];
  playerColors: readonly string[];
  emblemMarkup: (colorIndex: number) => string;
  onTap?: (sel: BoardSelection) => void;
  /** 마우스가 올라간 자리 (마우스만). x·y 는 캔버스 안 좌표로, 자리 가운데 위쪽 */
  onHover?: (sel: BoardSelection | null, x: number, y: number) => void;
  /** 바람·양·연기 움직임 (기본 켬) */
  motion?: boolean;
  /** 교역로 표지 앞에 붙일 아이콘 SVG (자원, null 이면 아무 자원 3:1 의 물음표) */
  harborIcon?: (resource: Resource | null) => string;
  onLoaded?: (report: ArtReport) => void;
  onLoadProgress?: (p: LoadProgress) => void;
  onPerf?: (s: PerfStats) => void;
  showTileLabels?: boolean;
  quality?: QualityMode;
}

const ELEVATION_DEG = 54;
const CAMERA_DISTANCE = 40;
const LIGHT_DIR = new THREE.Vector3(-0.55, 1, 0.5).normalize();
/** 그림자가 빛 반대쪽(오른쪽 뒤)으로 살짝 밀리도록 한 오프셋. 조명 방향과 맞춘다. */
const SHADOW_SHIFT = new THREE.Vector2(0.07, -0.06);
const RESOURCE_TOKEN_COLOR: Record<Resource, string> = { wood: '#9a6332', grain: '#e7b52c', wool: '#f1ead8', brick: '#b85c3c', stone: '#a7b0ba' };
type BoardPieceKind = 'village' | 'city' | 'road' | 'joint';
/** 가마 하나에서 동시에 피어오르는 연기 공 수 */
const SMOKE_PUFFS = 5;
/** 바람·양·연기만 움직일 때 프레임 간격 (약 30fps) */
const AMBIENT_FRAME_MS = 33;
/** 꼭짓점에 놓는 집(마을)·도시의 크기. 타일 사이 흙길 교차점에 서도록 작게 줄인다. */
const VILLAGE_SCALE = 0.54;
const CITY_SCALE = 0.56;
/** 길 판자가 변 길이에서 차지하는 비율 (양 끝은 마을 자리로 비워 둔다) */
const ROAD_FRACTION = 0.7;
const HIGHLIGHT_COLOR: Record<HighlightKind | 'selected' | 'hover', string> = {
  placeable: '#ffe066',
  buildable: '#ffe066',
  selected: '#ffffff',
  hover: '#fff6cf',
};
/** 보드 바깥을 채우는 물 색. 물결 무늬 없이 장면 배경색으로만 칠하고, 종이 결과 물감 농담은 후처리가 입힌다.
 *  styles.css 의 --water(보드 배경과 처음 화면·대기실 배경)도 같은 색이다. */
const WATER_COLOR = '#589eb5';
const GROUND_FALLBACK: Record<TileKind | 'dirt' | 'sand', string> = {
  wood: '#5f8a3f',
  grain: '#b8924f',
  wool: '#a9cb74',
  brick: '#c98a5c',
  stone: '#bdb9ae',
  plaza: '#cfc0a2',
  dirt: '#b99e72',
  sand: '#dcc595',
};
const TILE_GROUND: Record<TileKind, GroundTextureKey> = {
  wood: 'ground_forest',
  grain: 'ground_field',
  wool: 'ground_pasture',
  brick: 'ground_clay',
  stone: 'ground_quarry',
  plaza: 'ground_cobble',
};
/** 타일 옆면(둑) 색: 길보다 한 뼘 높은 풀·흙 둑처럼 보이게 지형마다 흙빛을 다르게 한다. */
const TILE_SIDE: Record<TileKind, string> = {
  wood: '#5f6e3c',
  grain: '#94773f',
  wool: '#748f46',
  brick: '#93593b',
  stone: '#857f72',
  plaza: '#9d8a6a',
};
/** 타일 사이 흙길 띠 폭 (타일 사이 틈보다 넓어 양쪽 끝은 타일 밑에 숨는다) */
const ROAD_STRIP_WIDTH = 0.4;
/** 흙길 텍스처 한 장이 덮는 길이 */
const ROAD_TEX_LENGTH = 1.0;
/** 바닷가 변에서 흙 땅이 바다 쪽으로 더 나간 폭 */
const LAND_MARGIN = 0.3;
/** 모래밭 윗면 높이 (흙 땅보다 낮다) */
const BEACH_TOP = 0.13;
/** 얕은 물 색 (깊은 물은 장면 배경색) */
const SHALLOW_COLOR = '#86c4cf';
/** 바닷가 변 가운데에서 교역로 부두 중심까지 거리 */
const HARBOR_REACH = 1.0;
/** 화면에 담을 범위: 타일 꼭짓점 바깥으로 이만큼 더 (모래밭이 조금 보이게) */
const FIT_PAD = 0.32;
const STATUE_SCALE = 0.86;
/** 잠금 사슬 육각형 반지름 (꼭짓점의 마을과 겹치지 않게 타일보다 조금 안쪽) */
const CHAIN_RADIUS = HEX_RADIUS - 0.17;
const PADLOCK_SCALE = 2.3;
/** 잠긴 칸을 덮는 그늘의 불투명도 */
const LOCK_SHADE = 0.26;
const LOCK_SVG =
  '<svg class="num-lock" viewBox="0 0 12 14" width="12" height="14" aria-hidden="true"><path d="M3.2 6.2V4.4a2.8 2.8 0 0 1 5.6 0v1.8" fill="none" stroke="#3a2a1f" stroke-width="1.7"/><rect x="1.2" y="6" width="9.6" height="7" rx="1.6" fill="#d1a73a" stroke="#3a2a1f" stroke-width="1.1"/></svg>';

type Pt = { x: number; z: number };
interface CoastLoop {
  pts: Pt[];
  /** pts[i] → pts[i+1] 변의 바깥 방향 */
  normals: Pt[];
}

/** 둘레 고리를 바깥으로 d 만큼 민다. 모서리는 뾰족하게 잇는다 (오목한 모서리도 같은 폭을 유지). */
function offsetLoop(c: CoastLoop, d: number): Pt[] {
  const n = c.pts.length;
  return c.pts.map((p, i) => {
    const n1 = c.normals[(i - 1 + n) % n];
    const n2 = c.normals[i];
    let mx = n1.x + n2.x;
    let mz = n1.z + n2.z;
    const len = Math.hypot(mx, mz) || 1;
    mx /= len;
    mz /= len;
    const k = d / Math.max(0.3, mx * n1.x + mz * n1.z);
    return { x: p.x + mx * k, z: p.z + mz * k };
  });
}

/** 꺾인 선을 부드럽게 다듬는다 (모서리 깎기를 여러 번) */
function chaikin(pts: Pt[], iterations: number): Pt[] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const next: Pt[] = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i];
      const b = cur[(i + 1) % cur.length];
      next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    cur = next;
  }
  return cur;
}

interface Anim {
  start: number;
  duration: number;
  update(t: number): void;
  done?(): void;
}

interface OverlayItem {
  el: HTMLElement;
  world: THREE.Vector3;
  /** 기준점에 대한 요소 정렬 (CSS translate) */
  anchor: string;
  lastX?: number;
  lastY?: number;
}

/** 장면에 놓인 소품 하나: 같은 소품 종류의 인스턴스 메시들 안에서의 번호와 제자리 */
interface PropInstance {
  p: Placement;
  parts: THREE.InstancedMesh[];
  index: number;
  /** 접촉 그림자 인스턴스 번호 (없으면 -1) */
  shadow: number;
}

interface Token {
  start: number;
  duration: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  arc: number;
  color: THREE.Color;
  spin: number;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const yAxis = new THREE.Vector3(0, 1, 0);

function compose(x: number, y: number, z: number, rotY: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  tmpQ.setFromAxisAngle(yAxis, rotY);
  return tmpM.compose(tmpV.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz));
}

function scaleUV(g: THREE.BufferGeometry, su: number, sv = su): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export class BoardRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly painter: PaintedRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly controls: MapControls;
  private readonly overlay: HTMLDivElement;
  private readonly metrics: BoardMetrics;
  private readonly tileById: Map<string, TileDef>;
  private readonly defaultTarget: THREE.Vector3;
  private readonly owned: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] } = { geometries: [], materials: [] };
  private readonly perf = new PerfMeter();
  private readonly resizeObserver: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerDowns = new Map<number, { x: number; y: number; t: number }>();

  private art: ArtLibrary | null = null;
  private ready = false;
  private disposed = false;
  private rafId = 0;
  private interacting = false;
  private multiTouch = false;
  private width = 1;
  private height = 1;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private quality: QualityMode;
  private pixelStep = 0;
  private lastPerfEmit = 0;
  private state: BoardState = { buildings: [], roads: [], highlights: null, selected: null };
  private firstState = true;
  private hovered: BoardSelection | null = null;

  private highlightRing: THREE.InstancedMesh | null = null;
  private highlightFill: THREE.InstancedMesh | null = null;
  private readonly geo: BoardGeometry;
  private pieceParts: { mesh: THREE.InstancedMesh; tint: boolean; kind: BoardPieceKind }[] = [];
  private pieceShadow: THREE.InstancedMesh | null = null;
  private knownPieces = new Set<string>();
  private spotRing: THREE.InstancedMesh | null = null;
  private spotFill: THREE.InstancedMesh | null = null;
  private edgeMark: THREE.InstancedMesh | null = null;
  private hintDots: THREE.InstancedMesh | null = null;
  private hintRings: THREE.InstancedMesh | null = null;
  private traceMark: THREE.InstancedMesh | null = null;
  private growing = new Map<string, number>();
  private tokenMesh: THREE.InstancedMesh | null = null;
  private tokens: Token[] = [];
  /** 소품 하나하나의 인스턴스 자리 (흔들기·톡 튀기기에 쓴다) */
  private instances: PropInstance[] = [];
  private instancesByTile = new Map<string, PropInstance[]>();
  private sheep: PropInstance[] = [];
  /** 양마다 거닐 수 있는 반지름 (울타리 칸 가장자리와 숫자 패·동상 빈터를 넘지 않게) */
  private sheepRoam: number[] = [];
  private propShadows: THREE.InstancedMesh | null = null;
  /** 가마 굴뚝 꼭대기와 연기 */
  private kilnTops: THREE.Vector3[] = [];
  private smokeMesh: THREE.InstancedMesh | null = null;
  /** 눌린 타일과 시작 시각 (소품이 톡 튄다) */
  private bouncing = new Map<string, number>();
  /** 바람·양·연기 움직임 */
  private motion: boolean;
  private lastAmbient = 0;
  private anims: Anim[] = [];
  private tileLabels: OverlayItem[] = [];
  private badges = new Map<string, OverlayItem>();
  private floating: OverlayItem[] = [];
  private tileLabelsVisible: boolean;
  /** 숫자 패 (HTML) */
  private numberTokens = new Map<string, OverlayItem>();
  /** 해상 교역로 표지 (HTML)와 부두 소품 */
  private harborLabels: OverlayItem[] = [];
  private harborGroup: THREE.Group | null = null;
  private harborKey = '';
  /** 화면에 꼭 담을 범위 (타일 + 교역로 부두) */
  private fitX = 0;
  private fitZ = 0;
  /** 기사단 동상과 잠금(사슬·자물쇠·그늘) */
  private statue: THREE.Group | null = null;
  private statueShadow: THREE.Mesh | null = null;
  private statueTile: string | null = null;
  private lockRoot: THREE.Group | null = null;
  private lockChain: THREE.Group | null = null;
  private padlock: THREE.Group | null = null;
  private lockShade: THREE.Mesh | null = null;
  /** 생산·막힘 때 칸 테두리를 빛내는 고리 */
  private flashRing: THREE.InstancedMesh | null = null;
  private overlayScale = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: BoardOptions,
  ) {
    this.metrics = boardMetrics(options.tiles);
    this.geo = boardGeometry(options.tiles);
    this.tileById = new Map(options.tiles.map((t) => [t.id, t]));
    this.quality = options.quality ?? 'auto';
    this.tileLabelsVisible = options.showTileLabels ?? true;
    this.motion = options.motion ?? true;
    this.fitX = this.metrics.fitX + FIT_PAD;
    this.fitZ = this.metrics.fitZ + FIT_PAD;

    // WebGL 2 컨텍스트를 만든다 (three.js r163 이후 WebGL 1 은 지원하지 않는다).
    // 장면은 화면 밖 버퍼에 그린 뒤 후처리로 옮기므로 캔버스 자체의 계단 현상 줄이기는 쓰지 않는다.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'default' });
    if (!this.renderer.capabilities.isWebGL2) throw new Error('WebGL 2를 사용할 수 없습니다.');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    // 장면 그리기와 후처리 두 번을 한 프레임으로 세도록 통계는 프레임마다 직접 비운다.
    this.renderer.info.autoReset = false;
    this.painter = new PaintedRenderer(this.renderer, this.quality === 'low' ? 0 : 4);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'board-canvas';
    this.canvas.setAttribute('aria-label', '3D 보드. 타일을 눌러 선택합니다.');
    this.canvas.setAttribute('role', 'img');
    container.appendChild(this.canvas);

    this.overlay = document.createElement('div');
    this.overlay.className = 'board-overlay';
    container.appendChild(this.overlay);

    this.scene.background = new THREE.Color(WATER_COLOR);

    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 120);
    const el = THREE.MathUtils.degToRad(ELEVATION_DEG);
    // 뒤쪽 나무 높이만큼 화면 중심을 조금 뒤로 옮겨 보드가 가운데 보이게 한다.
    this.defaultTarget = new THREE.Vector3(0, TILE_TOP, -0.55 / Math.tan(el));
    this.camera.position.copy(this.defaultTarget).add(new THREE.Vector3(0, Math.sin(el), Math.cos(el)).multiplyScalar(CAMERA_DISTANCE));
    this.camera.lookAt(this.defaultTarget);

    this.controls = new MapControls(this.camera, this.canvas);
    this.controls.target.copy(this.defaultTarget);
    this.controls.enableRotate = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.14;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;
    this.controls.minZoom = 0.65;
    this.controls.maxZoom = 4.5;
    this.controls.zoomSpeed = 1.1;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('change', this.onControlsChange);
    this.controls.addEventListener('start', this.onControlsStart);
    this.controls.addEventListener('end', this.onControlsEnd);
    this.controls.update();

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    // 탭을 다시 보면 멈춰 있던 바람·양·연기를 이어서 움직인다.
    document.addEventListener('visibilitychange', this.onVisibility);

    // 조명: 왼쪽 앞에서 비치는 따뜻한 햇빛 + 서늘한 하늘빛. 미리 구운 그림자 방향과 맞춘다.
    // 만화 음영이라 햇빛은 단계로 끊기고, 그늘진 면은 하늘빛(푸른 기)만 받아 수채화처럼 서늘해진다.
    const hemi = new THREE.HemisphereLight('#c9d3e6', '#8c7a5c', 1.35);
    const sun = new THREE.DirectionalLight('#ffe8c2', 1.9);
    sun.position.copy(LIGHT_DIR).multiplyScalar(30);
    this.scene.add(hemi, sun, sun.target);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  // ───────────────────────── 불러오기와 장면 구성 ─────────────────────────

  async load(): Promise<void> {
    const placements = this.allStaticPlacements();
    const propList = [
      ...placements.map((p) => ({ key: p.key, variant: p.variant })),
      { key: 'house' as PropKey, variant: 0 },
      { key: 'city' as PropKey, variant: 0 },
      { key: 'road' as PropKey, variant: 0 },
      { key: 'roadjoint' as PropKey, variant: 0 },
      ...(['statue', 'chain', 'padlock', 'pier', 'dock', 'boat', 'logpile', 'sheep', 'blocks', 'barrel'] as PropKey[]).map((key) => ({ key, variant: key === 'sheep' ? 1 : 0 })),
      { key: 'sack' as PropKey, variant: 0 },
      { key: 'sack' as PropKey, variant: 1 },
      { key: 'bricks' as PropKey, variant: 1 },
      { key: 'crate' as PropKey, variant: 0 },
    ];
    const art = await loadArtLibrary(this.renderer, propList, (p) => {
      if (!this.disposed) this.options.onLoadProgress?.(p);
    });
    if (this.disposed) {
      art.dispose();
      return;
    }
    this.art = art;
    this.buildGround();
    this.buildProps(placements);
    this.buildPiecePools();
    this.buildHighlights();
    this.buildTokens();
    this.buildSmoke();
    this.buildTileLabels();
    this.buildStatue();
    this.ready = true;
    this.applyState();
    this.options.onLoaded?.(art.report);
    // 셰이더를 미리 컴파일해 첫 조작 때 끊기지 않게 한다.
    this.renderer.compile(this.scene, this.camera);
    this.requestRender();
  }

  private allStaticPlacements(): Placement[] {
    return [...this.options.tiles.flatMap((t) => tilePlacements(t, this.metrics).map((p) => ({ ...p, tile: t.id }))), ...this.roadsidePlacements()];
  }

  /** 길가 잔돌과 풀 포기: 변마다 한두 개를 길 가장자리(길 판자와 마을 자리를 피해)에 둔다. */
  private roadsidePlacements(): Placement[] {
    const out: Placement[] = [];
    for (const e of this.geo.edges) {
      const ew = this.edgeWorld(e.id);
      if (!ew) continue;
      const rand = mulberry32(hashString(e.id) + 17);
      const dir = ew.b.clone().sub(ew.a).normalize();
      const nrm = new THREE.Vector3(-dir.z, 0, dir.x);
      const n = rand() < 0.45 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const t = 0.28 + rand() * 0.44;
        const side = rand() < 0.5 ? 1 : -1;
        const p = ew.a.clone().lerp(ew.b, t).addScaledVector(nrm, side * (0.12 + rand() * 0.02));
        const stone = rand() < 0.55;
        out.push({
          key: stone ? 'pebbles' : 'tuft',
          variant: Math.floor(rand() * 2),
          x: p.x,
          y: PLATFORM_TOP,
          z: p.z,
          rotY: rand() * 6.28,
          scale: stone ? 0.42 + rand() * 0.15 : 0.6 + rand() * 0.2,
          shadow: 0,
        });
      }
    }
    return out;
  }

  /** 인스턴스 하나를 제자리 기준으로 옮기거나 늘인다 (모든 부품 메시에 같은 행렬) */
  private setInstance(inst: PropInstance, dx = 0, dy = 0, dz = 0, drot = 0, sx = 1, sy = 1, sz = 1): void {
    const p = inst.p;
    const m = compose(p.x + dx, p.y + dy, p.z + dz, p.rotY + drot, p.scale * (p.stretch ?? 1) * sx, p.scale * (p.sy ?? 1) * sy, p.scale * sz);
    for (const mesh of inst.parts) {
      mesh.setMatrixAt(inst.index, m);
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (inst.shadow >= 0 && this.propShadows && (dx || dz)) {
      const r = p.shadow * p.scale * 2;
      this.propShadows.setMatrixAt(
        inst.shadow,
        compose(p.x + dx + SHADOW_SHIFT.x * p.scale, p.y + 0.004, p.z + dz + SHADOW_SHIFT.y * p.scale, p.rotY + drot, r * (p.shadowAspect ?? 1), 1, r),
      );
      this.propShadows.instanceMatrix.needsUpdate = true;
    }
  }

  /** 가마 연기: 굴뚝마다 공 다섯 개가 차례로 솟아오르며 커졌다가 사라진다 */
  private buildSmoke(): void {
    if (!this.kilnTops.length) return;
    const geo = this.own(new THREE.IcosahedronGeometry(1, 1));
    const mat = this.own(paintMaterial({ color: '#ece6dc', wash: 0.5 }));
    this.smokeMesh = new THREE.InstancedMesh(geo, mat, this.kilnTops.length * SMOKE_PUFFS);
    this.smokeMesh.count = 0;
    this.smokeMesh.frustumCulled = false;
    this.scene.add(this.smokeMesh);
  }

  /**
   * 움직임 한 프레임: 바람(셰이더 시간), 양이 거닐며 풀을 뜯는 모습, 가마 연기, 눌린 타일 소품의 튀기.
   * 움직임을 끈 상태에서도 타일 튀기는 끝까지 재생한다.
   */
  private updateMotion(now: number): boolean {
    const t = now / 1000;
    if (this.motion) paintTime.value = t;
    if (this.motion && this.hintDots && (this.hintDots.count || this.hintRings?.count)) {
      (this.hintDots.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.6));
    }
    // 양: 자기 자리 둘레의 둥근 길을 따라 목초지를 거닌다. 걷다가 멈춰 고개를 숙여 풀을 뜯고 다시 걷는다.
    // 걷는 방향으로 몸을 돌리고, 양마다 길 모양과 박자가 다르다.
    for (let i = 0; i < this.sheep.length; i++) {
      const s = this.sheep[i];
      if (this.bouncing.has(s.p.tile ?? '')) continue;
      if (!this.motion) continue;
      const seed = i * 1.618 + s.p.x * 2.3;
      const r = this.sheepRoam[i] ?? 0.05;
      // 걷기·멈춤: 늘였다 줄인 시간(빠르기 0~2배, 평균 1배)
      const w = 0.45 + (i % 3) * 0.08;
      const tau = t + Math.sin(t * w + seed) / w;
      const speed = 1 + Math.cos(t * w + seed);
      const a = 0.16 + (i % 2) * 0.05;
      const b = 0.11 + ((i + 1) % 3) * 0.03;
      const dx = r * 0.95 * Math.sin(a * tau + seed);
      const dz = r * Math.sin(b * tau + seed * 1.7);
      const vx = r * 0.95 * a * Math.cos(a * tau + seed);
      const vz = r * b * Math.cos(b * tau + seed * 1.7);
      // 양 모델은 머리가 +x 를 본다.
      const yaw = Math.atan2(-vz, vx);
      let turn = yaw - s.p.rotY;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      const moving = Math.min(1, speed);
      const graze = -0.007 * (1 - moving);
      const step = 0.004 * Math.abs(Math.sin(t * 7 + seed)) * moving;
      this.setInstance(s, dx, graze + step, dz, turn);
    }
    // 가마 연기
    const smoke = this.smokeMesh;
    if (smoke) {
      let n = 0;
      if (this.motion) {
        this.kilnTops.forEach((top, k) => {
          for (let j = 0; j < SMOKE_PUFFS; j++) {
            const age = (t * 0.32 + j / SMOKE_PUFFS + k * 0.29) % 1;
            const grow = smoothstep(0, 0.12, age) * (1 - smoothstep(0.72, 1, age));
            const sc = (0.035 + 0.075 * age) * grow;
            smoke.setMatrixAt(n++, compose(top.x + Math.sin(age * 4 + k) * 0.05 * age - age * 0.08, top.y + age * 0.62, top.z - age * 0.1, age * 2, sc, sc * 0.85, sc));
          }
        });
      }
      smoke.count = n;
      smoke.instanceMatrix.needsUpdate = true;
    }
    // 눌린 타일: 소품이 가운데부터 바깥으로 차례로 눌렸다가 톡 튄다. 바위·벽돌 더미는 조금 흔들린다.
    for (const [tile, start] of this.bouncing) {
      const list = this.instancesByTile.get(tile) ?? [];
      const tileDef = this.tileById.get(tile);
      const c = tileDef ? tileCenter(tileDef, this.metrics) : new THREE.Vector3();
      let done = true;
      for (const inst of list) {
        const delay = Math.hypot(inst.p.x - c.x, inst.p.z - c.z) * 260;
        const u = Math.min(1, Math.max(0, (now - start - delay) / 520));
        if (u < 1) done = false;
        const k = Math.sin(u * Math.PI * 2) * (1 - u);
        const heavy = inst.p.key === 'boulder' || inst.p.key === 'bricks' || inst.p.key === 'blocks' || inst.p.key === 'kiln';
        const wobble = heavy ? 0.12 * Math.sin(u * Math.PI * 3) * (1 - u) : 0;
        this.setInstance(inst, 0, 0.05 * Math.sin(u * Math.PI) * (1 - u) * (heavy ? 0.4 : 1), 0, wobble, 1 - 0.07 * k, 1 + 0.18 * k, 1 - 0.07 * k);
      }
      if (done) {
        for (const inst of list) if (!(this.motion && inst.p.key === 'sheep')) this.setInstance(inst);
        this.bouncing.delete(tile);
      }
    }
    return this.bouncing.size > 0;
  }

  /** 움직임 켜기·끄기. 끄면 양을 제자리로 돌리고 연기를 지운다. */
  setMotion(on: boolean): void {
    if (this.motion === on) return;
    this.motion = on;
    if (!on) {
      for (const s of this.sheep) this.setInstance(s);
      paintTime.value = 0;
      if (this.smokeMesh) this.smokeMesh.count = 0;
    }
    this.requestRender();
  }

  /** 눌린 자리에 짧은 반응: 타일이면 소품이 톡 튀고, 마을·도시·길이면 그 조각이 한 번 부풀었다 돌아온다. */
  private pokeAt(sel: BoardSelection): void {
    if (!this.ready) return;
    if (sel.kind === 'tile') {
      this.bouncing.set(sel.id, performance.now());
      this.requestRender();
      return;
    }
    const key = sel.kind === 'vertex' ? `b:${sel.id}` : `r:${sel.id}`;
    const exists = sel.kind === 'vertex' ? this.state.buildings.some((b) => b.vertexId === sel.id) : this.state.roads.some((r) => r.edgeId === sel.id);
    if (!exists || this.growing.has(key)) return;
    this.addAnim({
      duration: 420,
      update: (t) => {
        this.growing.set(key, 1 + 0.16 * Math.sin(t * Math.PI) * (1 - t * 0.3));
        this.updatePieceInstances();
      },
      done: () => {
        this.growing.delete(key);
        this.updatePieceInstances();
      },
    });
  }

  private own<T extends THREE.BufferGeometry | THREE.Material>(x: T): T {
    if (x instanceof THREE.BufferGeometry) this.owned.geometries.push(x);
    else this.owned.materials.push(x);
    return x;
  }

  private groundMaterial(key: GroundTextureKey, fallback: string, wash = 1): THREE.MeshToonMaterial {
    const map = this.art?.ground(key) ?? null;
    return this.own(paintMaterial({ map, color: map ? '#ffffff' : fallback, wash }));
  }

  private buildGround(): void {
    const m = this.metrics;
    // 보드 바깥은 무늬 없는 물이다. 장면 배경색(WATER_COLOR)이 그 역할을 하므로 따로 그리지 않는다.

    // 땅: 바깥 타일 둘레(바닷가 변)를 따라 조금 넓힌 흙 땅. 타일 사이 틈이 흙길이 되고, 둘레는 모래밭과 얕은 물로 이어진다.
    const coast = this.coastLoop();
    const shapeOf = (pts: Pt[]) => new THREE.Shape(pts.map((q) => new THREE.Vector2(q.x, -q.z)));
    const shallows = chaikin(offsetLoop(coast, LAND_MARGIN + 1.55), 3);
    const shallowGeo = this.own(new THREE.ShapeGeometry(shapeOf(shallows), 1).rotateX(-Math.PI / 2));
    const shallowMesh = new THREE.Mesh(shallowGeo, this.own(paintMaterial({ color: SHALLOW_COLOR, wash: 0.8 })));
    shallowMesh.position.y = 0.01;
    this.scene.add(shallowMesh);
    const beach = chaikin(offsetLoop(coast, LAND_MARGIN + 0.32), 2);
    const beachGeo = this.own(new THREE.ExtrudeGeometry(shapeOf(beach), { depth: BEACH_TOP + 0.02, bevelEnabled: false }).rotateX(-Math.PI / 2));
    scaleUV(beachGeo, 0.5);
    const beachMesh = new THREE.Mesh(beachGeo, [this.groundMaterial('ground_sand', GROUND_FALLBACK.sand), this.own(paintMaterial({ color: '#c9ad7c' }))]);
    beachMesh.position.y = -0.02;
    this.scene.add(beachMesh);
    const land = offsetLoop(coast, LAND_MARGIN);
    const landGeo = this.own(new THREE.ExtrudeGeometry(shapeOf(land), { depth: PLATFORM_TOP, bevelEnabled: false }).rotateX(-Math.PI / 2));
    scaleUV(landGeo, 0.5);
    const dirtTop = this.groundMaterial('ground_dirt', GROUND_FALLBACK.dirt);
    const dirtSide = this.own(paintMaterial({ color: '#9a7752', map: this.art?.ground('ground_dirt') ?? null }));
    this.scene.add(new THREE.Mesh(landGeo, [dirtTop, dirtSide]));

    this.buildRoadStrips();

    // 육각 타일 판 (종류별로 하나의 InstancedMesh). 옆면은 지형마다 흙·풀 둑 색이라 흙길보다 한 뼘 높은 둑처럼 보인다.
    const slabGeo = this.own(new THREE.CylinderGeometry(HEX_RADIUS, HEX_RADIUS + 0.035, TILE_THICKNESS, 6));
    const kinds: TileKind[] = [...RESOURCES, 'plaza'];
    for (const kind of kinds) {
      const tiles = this.options.tiles.filter((t) => t.kind === kind);
      if (tiles.length === 0) continue;
      const top = this.groundMaterial(TILE_GROUND[kind], GROUND_FALLBACK[kind]);
      const sideMat = this.own(paintMaterial({ color: TILE_SIDE[kind], wash: 0.8 }));
      const mesh = new THREE.InstancedMesh(slabGeo, [sideMat, top, sideMat], tiles.length);
      tiles.forEach((t, i) => {
        const c = tileCenter(t, m);
        mesh.setMatrixAt(i, compose(c.x, PLATFORM_TOP + TILE_THICKNESS / 2, c.z, 0, 1, 1, 1));
      });
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
    }

    // 타일 안쪽 가장자리를 살짝 어둡게 칠해 눌러 찍은 보드게임 타일처럼 보이게 한다 (한 번의 그리기 호출).
    const edgeGeo = this.own(this.hexEdgeShade(HEX_RADIUS - 0.005, HEX_RADIUS - 0.16, 0.2));
    const edgeMat = this.own(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const edges = new THREE.InstancedMesh(edgeGeo, edgeMat, this.options.tiles.length);
    this.options.tiles.forEach((t, i) => {
      const c = tileCenter(t, m);
      edges.setMatrixAt(i, compose(c.x, TILE_TOP + 0.003, c.z, 0, 1, 1, 1));
    });
    edges.computeBoundingSphere();
    edges.renderOrder = 1;
    this.scene.add(edges);

  }

  /**
   * 타일 사이 흙길: 변마다 수레바퀴 자국이 길을 따라 난 흙길 띠를 깐다. 텍스처 가로가 길 방향이라 자국이 변을 따라 이어지고,
   * 띠는 교차점까지 조금 더 뻗어 세 갈래가 겹치며 갈림길이 된다. 띠마다 높이를 아주 조금씩 달리해 겹친 곳이 깜박이지 않는다.
   */
  private buildRoadStrips(): void {
    const tex = this.art?.ground('ground_road') ?? null;
    if (tex) {
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
    }
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const hw = ROAD_STRIP_WIDTH / 2;
    const ext = 0.08;
    this.geo.edges.forEach((e, k) => {
      const a = this.vertexWorld(e.a)!;
      const b = this.vertexWorld(e.b)!;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const tx = (b.x - a.x) / len;
      const tz = (b.z - a.z) / len;
      const nx = -tz;
      const nz = tx;
      const ax = a.x - tx * ext;
      const az = a.z - tz * ext;
      const bx = b.x + tx * ext;
      const bz = b.z + tz * ext;
      const y = PLATFORM_TOP + 0.003 + (k % 24) * 0.0004;
      const u0 = (hashString(e.id) % 1000) / 1000;
      const u1 = u0 + (len + ext * 2) / ROAD_TEX_LENGTH;
      const base = pos.length / 3;
      pos.push(ax + nx * hw, y, az + nz * hw, bx + nx * hw, y, bz + nz * hw, bx - nx * hw, y, bz - nz * hw, ax - nx * hw, y, az - nz * hw);
      uv.push(u0, 1, u1, 1, u1, 0, u0, 0);
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // 위에서 보이도록 앞면을 위로
    if (g.attributes.normal.getY(0) < 0) {
      g.setIndex(idx.map((_, i) => idx[i - (i % 3) + (2 - (i % 3))]));
      g.computeVertexNormals();
    }
    this.own(g);
    const mat = this.own(paintMaterial({ map: tex, color: tex ? '#ffffff' : '#c4a273', wash: 0.7 }));
    this.scene.add(new THREE.Mesh(g, mat));
  }

  /** 바깥 꼭짓점은 검정 반투명, 안쪽은 투명인 육각 띠 (꼭짓점 RGBA 색) */
  private hexEdgeShade(outer: number, inner: number, alpha: number): THREE.BufferGeometry {
    const o = hexCorners(outer);
    const n = hexCorners(inner);
    const pos: number[] = [];
    const col: number[] = [];
    for (let k = 0; k < 6; k++) {
      pos.push(o[k].x, 0, o[k].z, n[k].x, 0, n[k].z);
      col.push(0.08, 0.06, 0.03, alpha, 0.08, 0.06, 0.03, 0);
    }
    const idx: number[] = [];
    for (let k = 0; k < 6; k++) {
      const a = k * 2;
      const b = ((k + 1) % 6) * 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    // 위에서 보이도록 앞면을 위로
    if (g.attributes.normal.getY(0) < 0) {
      g.setIndex(idx.map((_, i) => idx[i - (i % 3) + (2 - (i % 3))]));
    }
    return g;
  }

  private shadowMaterial(opacity: number): THREE.MeshBasicMaterial {
    return this.own(
      new THREE.MeshBasicMaterial({
        // 그림자는 검정 대신 서늘한 보라빛 물감으로 칠한다.
        color: '#2c2747',
        alphaMap: this.art?.ground('contact_shadow') ?? null,
        transparent: true,
        opacity,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    );
  }

  private buildProps(placements: Placement[]): void {
    const art = this.art!;
    const groups = new Map<string, Placement[]>();
    for (const p of placements) {
      const k = `${p.key}:${p.variant}`;
      const list = groups.get(k) ?? [];
      list.push(p);
      groups.set(k, list);
    }
    for (const list of groups.values()) {
      const { key, variant } = list[0];
      const template = art.prop(key, variant);
      const meshes: THREE.InstancedMesh[] = [];
      for (const part of template.parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        list.forEach((p, i) =>
          mesh.setMatrixAt(i, compose(p.x, p.y, p.z, p.rotY, p.scale * (p.stretch ?? 1), p.scale * (p.sy ?? 1), p.scale)),
        );
        mesh.computeBoundingSphere();
        this.scene.add(mesh);
        meshes.push(mesh);
      }
      list.forEach((p, i) => this.instances.push({ p, parts: meshes, index: i, shadow: -1 }));
    }
    // 미리 구운 접촉 그림자: 모든 소품을 한 번의 그리기 호출로 처리한다.
    const shadowed = placements.filter((p) => p.shadow > 0);
    const quad = this.own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    const shadows = new THREE.InstancedMesh(quad, this.shadowMaterial(0.5), shadowed.length);
    shadowed.forEach((p, i) => {
      const r = p.shadow * p.scale * 2;
      shadows.setMatrixAt(
        i,
        compose(p.x + SHADOW_SHIFT.x * p.scale, p.y + 0.004, p.z + SHADOW_SHIFT.y * p.scale, p.rotY, r * (p.shadowAspect ?? 1), 1, r),
      );
    });
    shadows.computeBoundingSphere();
    shadows.renderOrder = 1;
    this.scene.add(shadows);
    // 움직일 소품을 찾아 둔다: 양, 가마 굴뚝, 타일별 소품 목록
    this.propShadows = shadows;
    const byPlacement = new Map(this.instances.map((x) => [x.p, x]));
    shadowed.forEach((p, i) => {
      const inst = byPlacement.get(p);
      if (inst) inst.shadow = i;
    });
    for (const inst of this.instances) {
      const tile = inst.p.tile ?? '';
      const list = this.instancesByTile.get(tile) ?? [];
      list.push(inst);
      this.instancesByTile.set(tile, list);
    }
    this.sheep = this.instances.filter((x) => x.p.key === 'sheep');
    this.sheepRoam = this.sheep.map((inst) => {
      const t = this.tileById.get(inst.p.tile ?? '');
      if (!t) return 0;
      const c = tileCenter(t, this.metrics);
      const lx = inst.p.x - c.x;
      const lz = inst.p.z - c.z;
      // 육각형 변까지 거리 (변의 바깥 방향은 0°, 60°, … 120°마다)
      let edge = Infinity;
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3;
        edge = Math.min(edge, HEX_APOTHEM - (lx * Math.cos(a) + lz * Math.sin(a)));
      }
      const tz = Math.min(TOKEN_SPOT.z, Math.max(STATUE_SPOT.z, lz));
      const clear = Math.hypot(lx, lz - tz) - 0.23;
      // 울타리 칸 가장자리와 빈터에 조금 걸쳐도 되니 넉넉히 잡아 목초지를 제법 돌아다니게 한다.
      return Math.max(0.14, Math.min(0.36, edge - 0.08, clear - 0.02));
    });
    this.kilnTops = placements.filter((p) => p.key === 'kiln').map((p) => new THREE.Vector3(p.x, p.y + 0.45 * p.scale, p.z));
  }

  /** 마을(집)·도시·길을 미리 만든 인스턴스 묶음에 담는다. 플레이어 색은 지붕·판자에 인스턴스 색으로 곱한다. */
  private buildPiecePools(): void {
    const art = this.art!;
    const pools: [BoardPieceKind, PropKey, number][] = [
      ['village', 'house', 24],
      ['city', 'city', 20],
      ['road', 'road', 64],
      ['joint', 'roadjoint', 48],
    ];
    for (const [kind, key, capacity] of pools) {
      const template = art.prop(key, 0);
      for (const part of template.parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
        mesh.count = 0;
        if (part.tint) {
          for (let i = 0; i < capacity; i++) mesh.setColorAt(i, new THREE.Color('#ffffff'));
        }
        mesh.frustumCulled = false;
        this.pieceParts.push({ mesh, tint: part.tint, kind });
        this.scene.add(mesh);
      }
    }
    const quad = this.own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    this.pieceShadow = new THREE.InstancedMesh(quad, this.shadowMaterial(0.55), 48);
    this.pieceShadow.count = 0;
    this.pieceShadow.frustumCulled = false;
    this.pieceShadow.renderOrder = 1;
    this.scene.add(this.pieceShadow);
  }

  private buildHighlights(): void {
    const n = this.options.tiles.length;
    // 육각 테두리 (모양 평면의 y 를 -z 로 눕히므로 꼭짓점 z 를 뒤집어 넣는다)
    const hexPoints = (rad: number) => hexCorners(rad).map((v) => new THREE.Vector2(v.x, -v.z));
    const shape = new THREE.Shape().setFromPoints(hexPoints(HEX_RADIUS + 0.045));
    shape.holes.push(new THREE.Path().setFromPoints(hexPoints(HEX_RADIUS - 0.085)));
    const ringGeo = this.own(new THREE.ShapeGeometry(shape, 6).rotateX(-Math.PI / 2));
    const ringMat = this.own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }));
    this.highlightRing = new THREE.InstancedMesh(ringGeo, ringMat, n);
    const fillGeo = this.own(new THREE.ShapeGeometry(new THREE.Shape().setFromPoints(hexPoints(HEX_RADIUS - 0.05))).rotateX(-Math.PI / 2));
    const fillMat = this.own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false }));
    this.highlightFill = new THREE.InstancedMesh(fillGeo, fillMat, n);
    for (let i = 0; i < n; i++) {
      this.highlightRing.setColorAt(i, new THREE.Color('#ffffff'));
      this.highlightFill.setColorAt(i, new THREE.Color('#ffffff'));
    }
    this.highlightRing.renderOrder = 3;
    this.highlightFill.renderOrder = 2;
    this.highlightRing.frustumCulled = false;
    this.highlightFill.frustumCulled = false;
    this.scene.add(this.highlightFill, this.highlightRing);
    const flashShape = new THREE.Shape().setFromPoints(hexPoints(HEX_RADIUS + 0.07));
    flashShape.holes.push(new THREE.Path().setFromPoints(hexPoints(HEX_RADIUS - 0.16)));
    const flashGeo = this.own(new THREE.ShapeGeometry(flashShape, 6).rotateX(-Math.PI / 2));
    const flashMat = this.own(
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.flashRing = new THREE.InstancedMesh(flashGeo, flashMat, n);
    for (let i = 0; i < n; i++) {
      this.flashRing.setMatrixAt(i, compose(0, 0, 0, 0, 0, 1, 0));
      this.flashRing.setColorAt(i, new THREE.Color('#000000'));
    }
    this.flashRing.renderOrder = 3;
    this.flashRing.frustumCulled = false;
    this.scene.add(this.flashRing);

    // 꼭짓점 표식(고리 + 옅은 원)과 변 표식(가는 띠): 시작 배치·건설 모드에서 지을 수 있는 자리를 빛낸다.
    const nv = this.geo.vertices.length;
    const ne = this.geo.edges.length;
    const spotRingGeo = this.own(new THREE.RingGeometry(0.15, 0.23, 24).rotateX(-Math.PI / 2));
    const spotFillGeo = this.own(new THREE.CircleGeometry(0.15, 24).rotateX(-Math.PI / 2));
    const edgeGeo = this.own(new THREE.PlaneGeometry(1, 0.11).rotateX(-Math.PI / 2));
    const markMat = (opacity: number) =>
      this.own(new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, toneMapped: false }));
    this.spotRing = new THREE.InstancedMesh(spotRingGeo, markMat(0.95), nv);
    this.spotFill = new THREE.InstancedMesh(spotFillGeo, markMat(0.35), nv);
    this.edgeMark = new THREE.InstancedMesh(edgeGeo, markMat(0.85), ne);
    for (const m of [this.spotRing, this.spotFill, this.edgeMark]) {
      for (let i = 0; i < m.count; i++) m.setColorAt(i, new THREE.Color('#ffffff'));
      m.renderOrder = 4;
      m.frustumCulled = false;
      this.scene.add(m);
    }
    // 안내 표식: 변마다 점 세 개(점선), 꼭짓점마다 가는 고리. 은은하게 숨 쉬듯 밝아졌다 어두워진다.
    const hintMat = this.own(new THREE.MeshBasicMaterial({ color: '#fff4cf', transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }));
    this.hintDots = new THREE.InstancedMesh(this.own(new THREE.CircleGeometry(0.042, 12).rotateX(-Math.PI / 2)), hintMat, ne * 3);
    this.hintRings = new THREE.InstancedMesh(this.own(new THREE.RingGeometry(0.1, 0.135, 24).rotateX(-Math.PI / 2)), hintMat, nv);
    this.traceMark = new THREE.InstancedMesh(
      this.own(new THREE.PlaneGeometry(1, 0.2).rotateX(-Math.PI / 2)),
      this.own(new THREE.MeshBasicMaterial({ color: '#ffd34d', transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false })),
      ne,
    );
    for (const m of [this.hintDots, this.hintRings, this.traceMark]) {
      m.count = 0;
      m.renderOrder = 5;
      m.frustumCulled = false;
      this.scene.add(m);
    }
  }

  private buildTokens(): void {
    const geo = this.own(new THREE.CylinderGeometry(0.1, 0.1, 0.04, 18));
    const mat = this.own(paintMaterial({ wash: 0.4 }));
    this.tokenMesh = new THREE.InstancedMesh(geo, mat, 96);
    for (let i = 0; i < 96; i++) this.tokenMesh.setColorAt(i, new THREE.Color('#ffffff'));
    this.tokenMesh.count = 0;
    this.tokenMesh.frustumCulled = false;
    this.scene.add(this.tokenMesh);
  }

  private buildTileLabels(): void {
    for (const t of this.options.tiles) {
      const el = document.createElement('div');
      el.className = `tile-label tile-label-${t.kind}`;
      el.textContent = t.id;
      this.overlay.appendChild(el);
      const c = tileCenter(t, this.metrics);
      this.tileLabels.push({
        el,
        // 타일 앞쪽 가운데, 숫자 패 아래 (앞 꼭짓점의 마을과 겹치지 않는 자리)
        world: new THREE.Vector3(c.x, TILE_TOP, c.z + HEX_RADIUS * 0.74),
        anchor: 'translate(-50%, -50%)',
      });
    }
    this.setTileLabelsVisible(this.tileLabelsVisible);
  }

  // ───────────────────────── 상태 반영 ─────────────────────────

  setState(state: BoardState): void {
    this.state = state;
    if (this.ready) this.applyState();
  }

  private applyState(): void {
    const s = this.state;
    // 새로 생긴 조각은 솟아오르며 나타난다 (처음 받은 화면은 연출하지 않는다).
    const current = new Set([
      ...s.buildings.map((b) => `b:${b.vertexId}:${b.kind}:${b.owner}`),
      ...s.roads.map((r) => `r:${r.edgeId}:${r.owner}`),
    ]);
    if (!this.firstState) {
      for (const b of s.buildings) if (!this.knownPieces.has(`b:${b.vertexId}:${b.kind}:${b.owner}`)) this.animateGrow(`b:${b.vertexId}`);
      for (const r of s.roads) if (!this.knownPieces.has(`r:${r.edgeId}:${r.owner}`)) this.animateGrow(`r:${r.edgeId}`);
    }
    this.firstState = false;
    this.knownPieces = current;
    this.updatePieceInstances();

    // 마을·도시 위 소유자 표식 (HTML: 색 + 모양)
    const seen = new Set<string>();
    for (const b of s.buildings) {
      const p = this.vertexWorld(b.vertexId);
      if (!p) continue;
      seen.add(b.vertexId);
      let item = this.badges.get(b.vertexId);
      if (!item) {
        const el = document.createElement('div');
        el.className = 'owner-badge';
        this.overlay.appendChild(el);
        item = { el, world: p.clone(), anchor: 'translate(-50%, -100%)' };
        this.badges.set(b.vertexId, item);
      }
      item.world.set(p.x, p.y + (b.kind === 'city' ? 0.62 : 0.46), p.z);
      const key = `${b.owner}:${b.colorIndex}:${b.kind}`;
      if (item.el.dataset.key !== key) {
        item.el.dataset.key = key;
        item.el.innerHTML = this.options.emblemMarkup(b.colorIndex);
        item.el.title = b.label;
        item.el.classList.toggle('owner-badge-city', b.kind === 'city');
      }
    }
    for (const [id, item] of this.badges) {
      if (!seen.has(id)) {
        item.el.remove();
        this.badges.delete(id);
      }
    }
    this.syncNumbers();
    this.syncHarbors();
    this.syncRobber();
    this.updateHighlights();
    this.requestRender();
  }

  /** 꼭짓점의 세계 좌표 (타일 윗면 높이) */
  vertexWorld(id: string): THREE.Vector3 | null {
    const v = this.geo.vertexMap[id];
    if (!v) return null;
    return new THREE.Vector3(v.x * HEX_SPACING - this.metrics.cx, TILE_TOP, v.y * HEX_SPACING - this.metrics.cz);
  }

  /** 변의 가운데, 방향(y 축 회전), 길이 */
  private edgeWorld(id: string): { mid: THREE.Vector3; angle: number; length: number; a: THREE.Vector3; b: THREE.Vector3 } | null {
    const e = this.geo.edgeMap[id];
    if (!e) return null;
    const a = this.vertexWorld(e.a)!;
    const b = this.vertexWorld(e.b)!;
    return { mid: a.clone().add(b).multiplyScalar(0.5), angle: Math.atan2(-(b.z - a.z), b.x - a.x), length: a.distanceTo(b), a, b };
  }

  /** 집이 모두 같은 쪽을 보지 않도록 꼭짓점마다 조금씩 돌린다 */
  private vertexYaw(id: string): number {
    return ((hashString(id) % 1000) / 1000 - 0.5) * 0.5;
  }

  private updatePieceInstances(): void {
    const color = new THREE.Color();
    const villages = this.state.buildings.filter((b) => b.kind === 'village');
    const cities = this.state.buildings.filter((b) => b.kind === 'city');
    // 같은 사람의 길이 꼭짓점에서 이어지면(길끼리, 또는 내 마을·도시에 닿으면) 그쪽 끝을 꼭짓점까지 늘려 끊김 없이 잇는다.
    // 남의 마을·도시가 선 꼭짓점에서는 규칙대로 길이 끊기므로 늘리지 않는다.
    const roadsAt = new Map<string, Map<string, number>>();
    for (const r of this.state.roads) {
      const e = this.geo.edgeMap[r.edgeId];
      if (!e) continue;
      for (const v of [e.a, e.b]) {
        const m = roadsAt.get(v) ?? new Map<string, number>();
        m.set(r.owner, (m.get(r.owner) ?? 0) + 1);
        roadsAt.set(v, m);
      }
    }
    const buildingAtV = new Map(this.state.buildings.map((b) => [b.vertexId, b]));
    const joins = (v: string, owner: string) => {
      const b = buildingAtV.get(v);
      if (b) return b.owner === owner;
      return (roadsAt.get(v)?.get(owner) ?? 0) >= 2;
    };
    const gap = (1 - ROAD_FRACTION) / 2;
    for (const part of this.pieceParts) {
      let i = 0;
      if (part.kind === 'road') {
        for (const r of this.state.roads) {
          const ew = this.edgeWorld(r.edgeId);
          const e = this.geo.edgeMap[r.edgeId];
          if (!ew || !e || i >= part.mesh.instanceMatrix.count) continue;
          const g = this.growing.get(`r:${r.edgeId}`) ?? 1;
          const t0 = joins(e.a, r.owner) ? 0 : gap;
          const t1 = joins(e.b, r.owner) ? 1 : 1 - gap;
          const mid = ew.a.clone().lerp(ew.b, (t0 + t1) / 2);
          part.mesh.setMatrixAt(i, compose(mid.x, PLATFORM_TOP + 0.004, mid.z, ew.angle, ew.length * (t1 - t0) * g, Math.max(0.01, g), 1));
          if (part.tint) part.mesh.setColorAt(i, color.set(this.playerColor(r.colorIndex)));
          i++;
        }
      } else if (part.kind === 'joint') {
        // 길 둘 이상이 만나는 빈 꼭짓점에 판자 받침 (마을·도시가 선 자리는 집이 덮는다)
        for (const [v, owners] of roadsAt) {
          if (buildingAtV.has(v)) continue;
          for (const [owner, n] of owners) {
            if (n < 2 || i >= part.mesh.instanceMatrix.count) continue;
            const p = this.vertexWorld(v);
            const road = this.state.roads.find((r) => r.owner === owner);
            if (!p || !road) continue;
            part.mesh.setMatrixAt(i, compose(p.x, PLATFORM_TOP + 0.004, p.z, 0, 1, 1, 1));
            if (part.tint) part.mesh.setColorAt(i, color.set(this.playerColor(road.colorIndex)));
            i++;
          }
        }
      } else {
        const list = part.kind === 'city' ? cities : villages;
        const base = part.kind === 'city' ? CITY_SCALE : VILLAGE_SCALE;
        for (const b of list) {
          const p = this.vertexWorld(b.vertexId);
          if (!p || i >= part.mesh.instanceMatrix.count) continue;
          const sc = base * (this.growing.get(`b:${b.vertexId}`) ?? 1);
          part.mesh.setMatrixAt(i, compose(p.x, TILE_TOP - 0.03, p.z, this.vertexYaw(b.vertexId), sc, sc, sc));
          if (part.tint) part.mesh.setColorAt(i, color.set(this.playerColor(b.colorIndex)));
          i++;
        }
      }
      part.mesh.count = i;
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
    if (this.pieceShadow) {
      let i = 0;
      for (const b of this.state.buildings) {
        const p = this.vertexWorld(b.vertexId);
        if (!p || i >= this.pieceShadow.instanceMatrix.count) continue;
        const g = (this.growing.get(`b:${b.vertexId}`) ?? 1) * (b.kind === 'city' ? 0.7 : 0.52);
        this.pieceShadow.setMatrixAt(i, compose(p.x + SHADOW_SHIFT.x * 0.6, TILE_TOP + 0.006, p.z + SHADOW_SHIFT.y * 0.6, 0, 0.98 * g, 1, 0.8 * g));
        i++;
      }
      this.pieceShadow.count = i;
      this.pieceShadow.instanceMatrix.needsUpdate = true;
    }
  }

  private playerColor(index: number): string {
    const list = this.options.playerColors;
    return list[((index % list.length) + list.length) % list.length];
  }

  private updateHighlights(): void {
    const color = new THREE.Color();
    const sel = this.state.selected;
    const hov = this.hovered;
    const same = (a: BoardSelection | null, kind: BoardSelection['kind'], id: string) => !!a && a.kind === kind && a.id === id;
    // 타일: 고른 칸, 기사단 동상을 옮길 수 있는 칸, 마우스가 올라간 칸에 테두리를 그린다.
    const hlTiles = new Set(this.state.highlights?.tiles ?? []);
    const hlKind = this.state.highlights?.kind ?? null;
    const ring = this.highlightRing;
    const fill = this.highlightFill;
    if (ring && fill) {
      this.options.tiles.forEach((t, i) => {
        const c = tileCenter(t, this.metrics);
        const selected = same(sel, 'tile', t.id);
        const kind: keyof typeof HIGHLIGHT_COLOR | null = selected
          ? 'selected'
          : hlTiles.has(t.id) && hlKind
            ? hlKind
            : same(hov, 'tile', t.id)
              ? 'hover'
              : null;
        const show = kind !== null;
        ring.setMatrixAt(i, compose(c.x, TILE_TOP + 0.012, c.z, 0, show ? 1 : 0, 1, show ? 1 : 0));
        fill.setMatrixAt(i, compose(c.x, TILE_TOP + 0.008, c.z, 0, selected ? 1 : 0, 1, selected ? 1 : 0));
        if (kind) {
          color.set(HIGHLIGHT_COLOR[kind]);
          ring.setColorAt(i, color);
          fill.setColorAt(i, color);
        }
      });
      ring.instanceMatrix.needsUpdate = true;
      fill.instanceMatrix.needsUpdate = true;
      if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
      if (fill.instanceColor) fill.instanceColor.needsUpdate = true;
    }
    const hl = this.state.highlights;
    const hv = new Set(hl?.vertices ?? []);
    const he = new Set(hl?.edges ?? []);
    const spotRing = this.spotRing;
    const spotFill = this.spotFill;
    if (spotRing && spotFill) {
      this.geo.vertices.forEach((v, i) => {
        const p = this.vertexWorld(v.id)!;
        const selected = same(sel, 'vertex', v.id);
        const kind: keyof typeof HIGHLIGHT_COLOR | null = selected
          ? 'selected'
          : hv.has(v.id) && hl
            ? hl.kind
            : same(hov, 'vertex', v.id)
              ? 'hover'
              : null;
        const s = kind ? (selected ? 1.2 : 1) : 0;
        spotRing.setMatrixAt(i, compose(p.x, TILE_TOP + 0.03, p.z, 0, s, 1, s));
        spotFill.setMatrixAt(i, compose(p.x, TILE_TOP + 0.028, p.z, 0, kind && kind !== 'hover' ? s : 0, 1, kind && kind !== 'hover' ? s : 0));
        if (kind) {
          color.set(HIGHLIGHT_COLOR[kind]);
          spotRing.setColorAt(i, color);
          spotFill.setColorAt(i, color);
        }
      });
      spotRing.instanceMatrix.needsUpdate = true;
      spotFill.instanceMatrix.needsUpdate = true;
      if (spotRing.instanceColor) spotRing.instanceColor.needsUpdate = true;
      if (spotFill.instanceColor) spotFill.instanceColor.needsUpdate = true;
    }
    const edgeMark = this.edgeMark;
    if (edgeMark) {
      this.geo.edges.forEach((e, i) => {
        const ew = this.edgeWorld(e.id)!;
        const selected = same(sel, 'edge', e.id);
        const kind: keyof typeof HIGHLIGHT_COLOR | null = selected ? 'selected' : he.has(e.id) && hl ? hl.kind : same(hov, 'edge', e.id) ? 'hover' : null;
        const len = kind ? ew.length * 0.66 : 0;
        edgeMark.setMatrixAt(i, compose(ew.mid.x, PLATFORM_TOP + 0.09, ew.mid.z, ew.angle, len, 1, kind ? (selected ? 1.4 : 1) : 0));
        if (kind) edgeMark.setColorAt(i, color.set(HIGHLIGHT_COLOR[kind]));
      });
      edgeMark.instanceMatrix.needsUpdate = true;
      if (edgeMark.instanceColor) edgeMark.instanceColor.needsUpdate = true;
    }
    // 안내 표식: 빛나는 자리(건설 모드)나 고른 자리와 겹치는 곳은 빼고 그린다.
    const hints = this.state.hints;
    if (this.hintDots && this.hintRings) {
      let nd = 0;
      for (const id of hints?.edges ?? []) {
        if (he.has(id) || same(sel, 'edge', id)) continue;
        const ew = this.edgeWorld(id);
        if (!ew) continue;
        for (const t of [0.3, 0.5, 0.7]) {
          const p = ew.a.clone().lerp(ew.b, t);
          this.hintDots.setMatrixAt(nd++, compose(p.x, PLATFORM_TOP + 0.09, p.z, 0, 1, 1, 1));
        }
      }
      this.hintDots.count = nd;
      this.hintDots.instanceMatrix.needsUpdate = true;
      let nr = 0;
      for (const id of hints?.vertices ?? []) {
        if (hv.has(id) || same(sel, 'vertex', id)) continue;
        const p = this.vertexWorld(id);
        if (!p) continue;
        this.hintRings.setMatrixAt(nr++, compose(p.x, TILE_TOP + 0.03, p.z, 0, 1, 1, 1));
      }
      this.hintRings.count = nr;
      this.hintRings.instanceMatrix.needsUpdate = true;
    }
    if (this.traceMark) {
      let nt = 0;
      for (const id of this.state.trace ?? []) {
        const ew = this.edgeWorld(id);
        if (!ew) continue;
        this.traceMark.setMatrixAt(nt++, compose(ew.mid.x, PLATFORM_TOP + 0.08, ew.mid.z, ew.angle, ew.length * 0.82, 1, 1));
      }
      this.traceMark.count = nt;
      this.traceMark.instanceMatrix.needsUpdate = true;
    }
  }

  // ───────────────────────── 연출 ─────────────────────────

  private addAnim(a: Omit<Anim, 'start'> & { delay?: number }): void {
    this.anims.push({ ...a, start: performance.now() + (a.delay ?? 0) });
    this.requestRender();
  }

  /** key: 'b:<꼭짓점>' 또는 'r:<변>' */
  private animateGrow(key: string): void {
    this.growing.set(key, 0.01);
    this.addAnim({
      duration: 520,
      update: (t) => {
        this.growing.set(key, Math.max(0.01, easeOutBack(t)));
        this.updatePieceInstances();
      },
      done: () => {
        this.growing.delete(key);
        this.updatePieceInstances();
      },
    });
  }

  /** 라운드 시작 공동 생산 연출: 마을·도시에서 자원 토큰이 솟아오른다. */
  playProduction(items: { vertexId: string; resource: Resource; amount: number }[]): void {
    if (!this.ready) return;
    const now = performance.now();
    items.forEach((item, idx) => {
      const at = this.vertexWorld(item.vertexId);
      if (!at) return;
      for (let k = 0; k < item.amount; k++) {
        const from = at.clone().add(new THREE.Vector3((k - (item.amount - 1) / 2) * 0.2, 0.45, 0.08));
        this.tokens.push({
          start: now + idx * 90 + k * 140,
          duration: 1100,
          from,
          to: from.clone().add(new THREE.Vector3(0, 0.85, 0)),
          arc: 0,
          color: new THREE.Color(RESOURCE_TOKEN_COLOR[item.resource]),
          spin: 5,
        });
      }
      this.spawnFloating(at.clone().add(new THREE.Vector3(0, 0.95, 0)), `+${item.amount}`, `float-label float-${item.resource}`, idx * 90);
    });
    this.requestRender();
  }

  private spawnFloating(world: THREE.Vector3, text: string, className: string, delayMs = 0): void {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    el.style.animationDelay = `${delayMs}ms`;
    this.overlay.appendChild(el);
    const item: OverlayItem = { el, world, anchor: 'translate(-50%, -50%)' };
    this.floating.push(item);
    // 연출이 끝나면 지운다. 화면이 멈춰 있어도 위치가 맞도록 한 번 더 그린다.
    window.setTimeout(() => {
      el.remove();
      this.floating = this.floating.filter((f) => f !== item);
    }, 1700 + delayMs);
    this.requestRender();
  }

  private updateTokens(now: number): boolean {
    const mesh = this.tokenMesh;
    if (!mesh) return false;
    let n = 0;
    const pos = new THREE.Vector3();
    this.tokens = this.tokens.filter((tk) => now < tk.start + tk.duration);
    for (const tk of this.tokens) {
      if (n >= mesh.instanceMatrix.count) break;
      const t = Math.max(0, (now - tk.start) / tk.duration);
      if (now < tk.start) continue;
      const e = easeInOut(Math.min(1, t));
      pos.lerpVectors(tk.from, tk.to, e);
      pos.y += Math.sin(Math.PI * e) * tk.arc;
      const s = (t < 0.15 ? t / 0.15 : 1) * (t > 0.78 ? Math.max(0, (1 - t) / 0.22) : 1);
      mesh.setMatrixAt(n, compose(pos.x, pos.y, pos.z, t * tk.spin, s, s, s));
      mesh.setColorAt(n, tk.color);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return this.tokens.length > 0;
  }

  // ───────────────────────── 바닷가·교역로 ─────────────────────────

  /** 바닷가 변(타일 하나에만 닿은 변)을 이어 만든 보드 둘레 고리. 변마다 바깥 방향(그 타일 중심에서 멀어지는 쪽)을 함께 준다. */
  private coastLoop(): CoastLoop {
    const coast = this.geo.edges.filter((e) => e.tiles.length === 1);
    const byVertex = new Map<string, typeof coast>();
    for (const e of coast) for (const v of [e.a, e.b]) byVertex.set(v, [...(byVertex.get(v) ?? []), e]);
    const pts: Pt[] = [];
    const normals: Pt[] = [];
    if (!coast.length) return { pts, normals };
    let edge = coast[0];
    let from = edge.a;
    const used = new Set<string>();
    while (!used.has(edge.id)) {
      used.add(edge.id);
      const to = edge.a === from ? edge.b : edge.a;
      const a = this.vertexWorld(from)!;
      const b = this.vertexWorld(to)!;
      const c = tileCenter(this.tileById.get(edge.tiles[0])!, this.metrics);
      let nx = b.z - a.z;
      let nz = -(b.x - a.x);
      const len = Math.hypot(nx, nz) || 1;
      nx /= len;
      nz /= len;
      if (nx * ((a.x + b.x) / 2 - c.x) + nz * ((a.z + b.z) / 2 - c.z) < 0) {
        nx = -nx;
        nz = -nz;
      }
      pts.push({ x: a.x, z: a.z });
      normals.push({ x: nx, z: nz });
      const next = (byVertex.get(to) ?? []).find((e) => e.id !== edge.id && !used.has(e.id));
      if (!next) break;
      edge = next;
      from = to;
    }
    return { pts, normals };
  }

  /** 교역로 하나의 자리: 바닷가 변의 두 꼭짓점, 가운데, 바깥 방향, 바다 쪽 부두 중심 */
  private harborSpot(edgeId: string) {
    const e = this.geo.edgeMap[edgeId];
    if (!e || e.tiles.length !== 1) return null;
    const ew = this.edgeWorld(edgeId)!;
    const c = tileCenter(this.tileById.get(e.tiles[0])!, this.metrics);
    const n = new THREE.Vector3(ew.mid.x - c.x, 0, ew.mid.z - c.z).normalize();
    const a = ew.a.clone().setY(0);
    const b = ew.b.clone().setY(0);
    const mid = ew.mid.clone().setY(0);
    return { a, b, mid, n, dock: mid.clone().addScaledVector(n, HARBOR_REACH) };
  }

  /** 소품 배치 목록을 인스턴스 메시 묶음으로 만든다 (교역로 부두처럼 상태를 받은 뒤 붙이는 소품) */
  private instancedGroup(placements: Placement[]): THREE.Group {
    const art = this.art!;
    const group = new THREE.Group();
    const byKey = new Map<string, Placement[]>();
    for (const p of placements) {
      const k = `${p.key}:${p.variant}`;
      byKey.set(k, [...(byKey.get(k) ?? []), p]);
    }
    for (const list of byKey.values()) {
      for (const part of art.prop(list[0].key, list[0].variant).parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        list.forEach((p, i) => mesh.setMatrixAt(i, compose(p.x, p.y, p.z, p.rotY, p.scale * (p.stretch ?? 1), p.scale * (p.sy ?? 1), p.scale)));
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
    }
    return group;
  }

  /**
   * 해상 교역로: 바닷가 변 바깥 바다에 작은 부두를 띄우고 그 변의 두 꼭짓점에서 잔교를 잇는다.
   * 부두에는 교역 물품(2:1 은 그 자원, 3:1 은 통과 상자)을 쌓고 비율 표지를 띄운다.
   */
  private syncHarbors(): void {
    const list = this.state.harbors ?? [];
    const key = list.map((h) => `${h.edgeId}:${h.resource ?? '*'}`).join(',');
    if (key === this.harborKey || !this.art) return;
    this.harborKey = key;
    if (this.harborGroup) {
      this.scene.remove(this.harborGroup);
      this.harborGroup.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
      this.harborGroup = null;
    }
    for (const l of this.harborLabels) l.el.remove();
    this.harborLabels = [];
    this.fitX = this.metrics.fitX + FIT_PAD;
    this.fitZ = this.metrics.fitZ + FIT_PAD;
    const placements: Placement[] = [];
    list.forEach((h, idx) => {
      const s = this.harborSpot(h.edgeId);
      if (!s) return;
      const yaw = Math.atan2(s.n.x, s.n.z);
      const side = new THREE.Vector3(s.n.z, 0, -s.n.x);
      // 잔교와 부두 바닥은 모래밭(윗면 약 0.13)보다 높아야 모래에 묻히지 않는다.
      const deck = 0.16;
      placements.push({ key: 'dock', variant: 0, x: s.dock.x, y: 0.09, z: s.dock.z, rotY: yaw, scale: 0.52, shadow: 0 });
      for (const v of [s.a, s.b]) {
        // 잔교는 꼭짓점 바로 앞 흙 둑에서 나와 부두 모서리로 이어진다 (교역로 하나에 길 두 갈래).
        const start = v.clone().addScaledVector(s.n, 0.2);
        const toward = v.clone().sub(s.mid).normalize();
        const end = s.dock.clone().addScaledVector(toward, 0.17).addScaledVector(s.n, -0.1);
        const mid = start.clone().add(end).multiplyScalar(0.5);
        placements.push({
          key: 'pier',
          variant: 0,
          x: mid.x,
          y: 0.075,
          z: mid.z,
          rotY: Math.atan2(-(end.z - start.z), end.x - start.x),
          scale: 1.15,
          stretch: start.distanceTo(end) / 1.15,
          shadow: 0,
        });
      }
      if (idx % 2 === 0) {
        const at = s.dock.clone().addScaledVector(side, idx % 4 === 0 ? 0.36 : -0.36).addScaledVector(s.n, 0.04);
        placements.push({ key: 'boat', variant: 0, x: at.x, y: 0.0, z: at.z, rotY: Math.atan2(-s.n.z, s.n.x), scale: 0.34, shadow: 0 });
      }
      const on = (dx: number, dz: number) => s.dock.clone().addScaledVector(side, dx).addScaledVector(s.n, dz);
      const cargo = (key: PropKey, variant: number, at: THREE.Vector3, scale: number, rot = 0) =>
        placements.push({ key, variant, x: at.x, y: deck, z: at.z, rotY: yaw + rot, scale, shadow: 0 });
      switch (h.resource) {
        case 'wood':
          cargo('logpile', 0, on(0, 0), 0.34, Math.PI / 2);
          break;
        case 'grain':
          cargo('sack', 0, on(-0.06, 0), 0.62);
          cargo('sack', 1, on(0.07, 0.03), 0.6, 1.2);
          break;
        case 'wool':
          cargo('sheep', 1, on(0, 0), 0.72, 0.6);
          break;
        case 'brick':
          cargo('bricks', 1, on(0, 0), 0.52);
          break;
        case 'stone':
          cargo('blocks', 0, on(0, 0), 0.36);
          break;
        default:
          cargo('barrel', 0, on(-0.07, 0), 0.62);
          cargo('crate', 0, on(0.08, 0.02), 0.62, 0.4);
          break;
      }
      const el = document.createElement('div');
      el.className = `harbor-label ${h.resource ? `harbor-res harbor-${h.resource}` : 'harbor-any'}`;
      // 앞에 아이콘(자원, 3:1 은 물음표)만 두고 비율을 쓴다. 이름은 마우스를 올리면 나온다.
      el.innerHTML = `${this.options.harborIcon?.(h.resource) ?? ''}<b>${h.resource ? '2:1' : '3:1'}</b>`;
      el.title = h.resource ? `해상 교역로: ${RESOURCE_LABEL[h.resource]} 2장 → 원하는 자원 1장` : '해상 교역로: 같은 자원 3장 → 원하는 자원 1장';
      this.overlay.appendChild(el);
      this.harborLabels.push({ el, world: s.dock.clone().addScaledVector(s.n, 0.42).setY(0.36), anchor: 'translate(-50%, -50%) scale(var(--tz, 1))' });
      const tip = s.dock.clone().addScaledVector(s.n, 0.42);
      this.fitX = Math.max(this.fitX, Math.abs(tip.x) + 0.4);
      this.fitZ = Math.max(this.fitZ, Math.abs(tip.z) + 0.3);
    });
    if (placements.length) {
      this.harborGroup = this.instancedGroup(placements);
      this.scene.add(this.harborGroup);
    }
    this.fitCamera();
  }

  // ───────────────────────── 숫자 패, 기사단 동상, 잠금 ─────────────────────────

  /** 기사단 동상이 선 칸. 상태에 없으면 광장 칸에 선다. */
  private robberTile(): string | null {
    if (this.state.robber !== undefined) return this.state.robber;
    return this.options.tiles.find((t) => t.kind === 'plaza')?.id ?? null;
  }

  /** 숫자 패를 칸마다 띄운다 (빨간 6·8, 나올 확률 점). 동상이 선 칸의 패는 잠긴 모습이 된다. */
  private syncNumbers(): void {
    const nums = this.state.numbers ?? {};
    const robber = this.robberTile();
    for (const t of this.options.tiles) {
      const n = nums[t.id];
      let item = this.numberTokens.get(t.id);
      if (!n) {
        if (item) {
          item.el.remove();
          this.numberTokens.delete(t.id);
        }
        continue;
      }
      if (!item) {
        const el = document.createElement('div');
        this.overlay.appendChild(el);
        const c = tileCenter(t, this.metrics);
        item = { el, world: new THREE.Vector3(c.x + TOKEN_SPOT.x, TILE_TOP + 0.02, c.z + TOKEN_SPOT.z), anchor: 'translate(-50%, -50%) scale(var(--tz, 1))' };
        this.numberTokens.set(t.id, item);
      }
      const locked = robber === t.id;
      const key = `${n}:${locked}`;
      if (item.el.dataset.key !== key) {
        item.el.dataset.key = key;
        item.el.className = `num-token${n === 6 || n === 8 ? ' num-hot' : ''}${locked ? ' num-locked' : ''}`;
        // 바깥 요소는 자리(transform)만 맡고, 원판과 튀는 연출은 안쪽 요소가 맡는다 (scale 연출이 자리까지 늘리지 않게).
        item.el.innerHTML = `<span class="num-face"><b>${n}</b><i>${'•'.repeat(numberPips(n))}</i></span>${locked ? LOCK_SVG : ''}`;
        item.el.title = `${t.id} · 주사위 ${n}${locked ? ' · 기사단 동상이 막고 있음' : ''}`;
      }
    }
  }

  private buildStatue(): void {
    const art = this.art!;
    const group = (key: PropKey) => {
      const g = new THREE.Group();
      for (const part of art.prop(key, 0).parts) g.add(new THREE.Mesh(part.geometry, part.material));
      return g;
    };
    this.statue = group('statue');
    this.statue.scale.setScalar(STATUE_SCALE);
    this.statue.visible = false;
    const quad = this.own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    this.statueShadow = new THREE.Mesh(quad, this.shadowMaterial(0.55));
    this.statueShadow.renderOrder = 1;
    this.statueShadow.visible = false;
    this.scene.add(this.statue, this.statueShadow);

    // 잠금: 칸 둘레 사슬 + 앞 오른쪽 변의 자물쇠 + 칸을 어둡게 덮는 그늘
    this.lockRoot = new THREE.Group();
    this.lockRoot.visible = false;
    this.lockChain = group('chain');
    this.lockChain.scale.setScalar(CHAIN_RADIUS);
    this.padlock = group('padlock');
    // 사슬 고리가 앞 오른쪽 변 가운데에서 조금 바깥에 선다 (꼭짓점의 마을·변의 길과 겹치지 않는 자리).
    const n = { x: 0.5, z: Math.sqrt(3) / 2 };
    this.padlock.position.set(0.433 * CHAIN_RADIUS + n.x * 0.06, 0, 0.75 * CHAIN_RADIUS + n.z * 0.06);
    this.padlock.rotation.y = Math.PI / 6;
    this.padlock.scale.setScalar(PADLOCK_SCALE);
    const hex = hexCorners(HEX_RADIUS - 0.02).map((v) => new THREE.Vector2(v.x, -v.z));
    const shadeGeo = this.own(new THREE.ShapeGeometry(new THREE.Shape().setFromPoints(hex)).rotateX(-Math.PI / 2));
    this.lockShade = new THREE.Mesh(
      shadeGeo,
      this.own(new THREE.MeshBasicMaterial({ color: '#241b3c', transparent: true, opacity: LOCK_SHADE, depthWrite: false, toneMapped: false })),
    );
    this.lockShade.position.y = 0.006;
    this.lockShade.renderOrder = 2;
    this.lockRoot.add(this.lockShade, this.lockChain, this.padlock);
    this.scene.add(this.lockRoot);
  }

  private statueSpot(tileId: string): THREE.Vector3 {
    const t = this.tileById.get(tileId)!;
    const c = tileCenter(t, this.metrics);
    const s = t.kind === 'plaza' ? PLAZA_STATUE_SPOT : STATUE_SPOT;
    return new THREE.Vector3(c.x + s.x, TILE_TOP + (t.kind === 'plaza' ? DAIS_HEIGHT : 0), c.z + s.z);
  }

  private placeStatue(at: THREE.Vector3, lift: number): void {
    this.statue!.position.set(at.x, at.y + lift, at.z);
    const r = 0.5 * (1 - Math.min(0.6, lift * 0.45));
    this.statueShadow!.position.set(at.x + SHADOW_SHIFT.x * 0.7, at.y + 0.006, at.z + SHADOW_SHIFT.y * 0.7);
    this.statueShadow!.scale.set(r, 1, r * 0.9);
  }

  /** 동상이 다른 칸으로 옮겨 가면 들려 올라 한 바퀴 돌며 날아가 쿵 내려앉고, 그 칸에 사슬과 자물쇠가 채워진다. */
  private syncRobber(): void {
    if (!this.statue) return;
    const tile = this.robberTile();
    if (tile === this.statueTile) return;
    const from = this.statueTile;
    this.statueTile = tile;
    if (!tile || !this.tileById.has(tile)) {
      this.statue.visible = false;
      this.statueShadow!.visible = false;
      this.setLock(null, false);
      return;
    }
    const to = this.statueSpot(tile);
    this.statue.visible = true;
    this.statueShadow!.visible = true;
    if (!from) {
      this.placeStatue(to, 0);
      this.setLock(tile, false);
      return;
    }
    const start = this.statue.position.clone();
    this.setLock(null, true);
    const pos = new THREE.Vector3();
    this.addAnim({
      duration: 1050,
      update: (t) => {
        const e = easeInOut(t);
        pos.lerpVectors(start, to, e);
        this.placeStatue(pos, Math.sin(Math.PI * e) * 1.1);
        this.statue!.rotation.y = e * Math.PI * 2;
      },
      done: () => {
        this.statue!.rotation.y = 0;
        this.placeStatue(to, 0);
        this.bouncing.set(tile, performance.now());
        this.addAnim({
          duration: 320,
          update: (t) => {
            const k = Math.sin(t * Math.PI) * (1 - t);
            this.statue!.scale.set(STATUE_SCALE * (1 + 0.12 * k), STATUE_SCALE * (1 - 0.16 * k), STATUE_SCALE * (1 + 0.12 * k));
          },
          done: () => this.statue!.scale.setScalar(STATUE_SCALE),
        });
        this.setLock(tile, true);
      },
    });
  }

  /** 칸에 잠금(사슬·자물쇠·그늘)을 채우거나 푼다. 광장은 생산하지 않는 칸이라 잠그지 않는다. */
  private setLock(tile: string | null, animate: boolean): void {
    const root = this.lockRoot;
    const chain = this.lockChain;
    const padlock = this.padlock;
    const shade = this.lockShade?.material as THREE.MeshBasicMaterial | undefined;
    if (!root || !chain || !padlock || !shade) return;
    const t = tile ? this.tileById.get(tile) : null;
    if (!t || t.kind === 'plaza') {
      if (!root.visible) return;
      if (!animate) {
        root.visible = false;
        return;
      }
      this.addAnim({
        duration: 260,
        update: (k) => {
          chain.scale.set(CHAIN_RADIUS, CHAIN_RADIUS * Math.max(0.001, 1 - k), CHAIN_RADIUS);
          padlock.scale.setScalar(PADLOCK_SCALE * Math.max(0.001, 1 - k));
          shade.opacity = LOCK_SHADE * (1 - k);
        },
        done: () => {
          root.visible = false;
        },
      });
      return;
    }
    const c = tileCenter(t, this.metrics);
    root.position.set(c.x, TILE_TOP, c.z);
    root.visible = true;
    padlock.rotation.z = 0;
    if (!animate) {
      chain.scale.setScalar(CHAIN_RADIUS);
      padlock.scale.setScalar(PADLOCK_SCALE);
      padlock.position.y = 0;
      padlock.visible = true;
      shade.opacity = LOCK_SHADE;
      return;
    }
    padlock.visible = false;
    this.addAnim({
      duration: 420,
      update: (k) => {
        chain.scale.set(CHAIN_RADIUS, CHAIN_RADIUS * Math.max(0.001, easeOutBack(k)), CHAIN_RADIUS);
        shade.opacity = LOCK_SHADE * k;
      },
    });
    this.addAnim({
      delay: 240,
      duration: 620,
      update: (k) => {
        padlock.visible = true;
        padlock.scale.setScalar(PADLOCK_SCALE);
        const fall = Math.min(1, k / 0.45);
        padlock.position.y = 0.6 * (1 - fall * fall);
        padlock.rotation.z = k > 0.45 ? Math.sin((k - 0.45) * Math.PI * 7) * 0.3 * (1 - k) : 0;
      },
      done: () => {
        padlock.position.y = 0;
        padlock.rotation.z = 0;
      },
    });
  }

  /** 막힌 칸의 숫자가 나왔을 때: 자물쇠가 덜컹이고 사슬이 튄다. */
  private shakeLock(): void {
    const padlock = this.padlock;
    const chain = this.lockChain;
    if (!this.lockRoot?.visible || !padlock || !chain) return;
    this.addAnim({
      duration: 760,
      update: (k) => {
        const d = 1 - k;
        padlock.rotation.z = Math.sin(k * Math.PI * 9) * 0.35 * d;
        chain.position.y = Math.abs(Math.sin(k * Math.PI * 7)) * 0.03 * d;
      },
      done: () => {
        padlock.rotation.z = 0;
        chain.position.y = 0;
      },
    });
  }

  /** 칸 테두리를 잠깐 빛낸다 (생산은 금빛, 막힘은 붉은빛) */
  private flashTile(tileId: string, color: string, delay = 0): void {
    const ring = this.flashRing;
    const i = this.options.tiles.findIndex((t) => t.id === tileId);
    if (!ring || i < 0) return;
    const c = tileCenter(this.options.tiles[i], this.metrics);
    const base = new THREE.Color(color);
    const col = new THREE.Color();
    this.addAnim({
      delay,
      duration: 1400,
      update: (t) => {
        const k = t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
        const s = 1 + 0.04 * Math.sin(t * Math.PI * 4);
        ring.setMatrixAt(i, compose(c.x, TILE_TOP + 0.014, c.z, 0, s, 1, s));
        ring.setColorAt(i, col.copy(base).multiplyScalar(Math.max(0, k)));
        ring.instanceMatrix.needsUpdate = true;
        if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
      },
      done: () => {
        ring.setMatrixAt(i, compose(c.x, 0, c.z, 0, 0, 1, 0));
        ring.instanceMatrix.needsUpdate = true;
      },
    });
  }

  /** 숫자 패를 한 번 크게 튀긴다 (CSS 연출) */
  private pulseToken(tileId: string, cls: 'num-roll' | 'num-blocked'): void {
    const item = this.numberTokens.get(tileId);
    if (!item) return;
    item.el.classList.remove('num-roll', 'num-blocked');
    void item.el.offsetWidth;
    item.el.classList.add(cls);
    window.setTimeout(() => item.el.classList.remove(cls), 1700);
  }

  /**
   * 주사위 생산 연출: 숫자가 나온 칸의 테두리가 금빛으로 빛나고 숫자 패가 튀며, 칸 위 소품이 일하듯 들썩인다.
   * 그다음 그 칸에서 자원 토큰이 솟아 닿은 마을·도시로 날아간다. 동상에 막힌 칸은 붉게 빛나고 자물쇠가 덜컹인다.
   */
  playRoll(tiles: string[], blocked: string[], items: { tileId: string; vertexId: string; resource: Resource; amount: number }[]): void {
    if (!this.ready) return;
    const now = performance.now();
    tiles.forEach((id, i) => {
      const isBlocked = blocked.includes(id);
      this.flashTile(id, isBlocked ? '#e0503c' : '#ffcf3f', i * 70);
      this.pulseToken(id, isBlocked ? 'num-blocked' : 'num-roll');
      const t = this.tileById.get(id);
      if (isBlocked) {
        this.shakeLock();
        if (t) this.spawnFloating(tileCenter(t, this.metrics).add(new THREE.Vector3(0, 0.75, 0)), '막힘', 'float-label float-blocked', 150);
        return;
      }
      this.bouncing.set(id, now + i * 70);
    });
    items.forEach((it, idx) => {
      if (blocked.includes(it.tileId)) return;
      const t = this.tileById.get(it.tileId);
      const to = this.vertexWorld(it.vertexId);
      if (!t || !to) return;
      const c = tileCenter(t, this.metrics);
      const from = new THREE.Vector3(c.x + TOKEN_SPOT.x, TILE_TOP + 0.3, c.z + TOKEN_SPOT.z);
      for (let k = 0; k < it.amount; k++) {
        this.tokens.push({
          start: now + 420 + idx * 110 + k * 130,
          duration: 880,
          from: from.clone(),
          to: to.clone().add(new THREE.Vector3((k - (it.amount - 1) / 2) * 0.16, 0.42, 0)),
          arc: 0.75,
          color: new THREE.Color(RESOURCE_TOKEN_COLOR[it.resource]),
          spin: 7,
        });
      }
      this.spawnFloating(to.clone().add(new THREE.Vector3(0, 0.95, 0)), `+${it.amount}`, `float-label float-${it.resource}`, 1000 + idx * 110);
    });
    this.requestRender();
  }

  /** 조각 하나(마을·도시 'b:<꼭짓점>', 길 'r:<변>')를 잠깐 부풀린다. */
  private pulsePiece(key: string, delay: number, amount: number): void {
    this.addAnim({
      delay,
      duration: 560,
      update: (t) => {
        this.growing.set(key, 1 + amount * Math.sin(t * Math.PI));
        this.updatePieceInstances();
      },
      done: () => {
        this.growing.delete(key);
        this.updatePieceInstances();
      },
    });
  }

  /**
   * 달성 연출. 최장 교역로는 그 사람의 길이 차례로 솟았다 가라앉고, 최강 기사단은 기사단 동상이 제자리에서 뛰어올라
   * 한 바퀴 돌며 그 사람의 마을·도시가 부푼다.
   */
  playAward(award: 'longest_road' | 'largest_army', _colorIndex: number, playerId: string): void {
    if (!this.ready) return;
    if (award === 'longest_road') {
      const roads = this.state.roads.filter((r) => r.owner === playerId);
      roads.forEach((r, i) => this.pulsePiece(`r:${r.edgeId}`, i * 80, 0.5));
      const mids = roads.map((r) => this.edgeWorld(r.edgeId)?.mid).filter((m): m is THREE.Vector3 => !!m);
      if (mids.length) {
        const at = mids.reduce((a, m) => a.add(m), new THREE.Vector3()).multiplyScalar(1 / mids.length);
        this.spawnFloating(at.add(new THREE.Vector3(0, 0.8, 0)), '최장 교역로', 'float-label float-award', 300);
      }
      return;
    }
    this.state.buildings.filter((b) => b.owner === playerId).forEach((b, i) => this.pulsePiece(`b:${b.vertexId}`, 200 + i * 90, 0.3));
    const statue = this.statue;
    if (statue?.visible) {
      const base = statue.position.clone();
      this.addAnim({
        duration: 900,
        update: (t) => {
          statue.position.y = base.y + Math.sin(Math.PI * t) * 0.45;
          statue.rotation.y = easeInOut(t) * Math.PI * 2;
        },
        done: () => {
          statue.position.copy(base);
          statue.rotation.y = 0;
        },
      });
      this.spawnFloating(base.clone().add(new THREE.Vector3(0, 1.0, 0)), '최강 기사단', 'float-label float-award', 300);
    }
  }

  // ───────────────────────── 카메라·입력 ─────────────────────────

  setInsets(insets: Insets): void {
    const a = this.insets;
    if (a.top === insets.top && a.right === insets.right && a.bottom === insets.bottom && a.left === insets.left) return;
    this.insets = { ...insets };
    this.fitCamera();
    this.requestRender();
  }

  resetView(): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.copy(this.defaultTarget);
    this.camera.position.copy(this.defaultTarget).add(offset);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  setQuality(mode: QualityMode): void {
    this.quality = mode;
    this.painter.setSamples(mode === 'low' ? 0 : 4);
    this.pixelStep = 0;
    this.perf.resetRecent();
    this.applyPixelRatio();
    this.requestRender();
  }

  setTileLabelsVisible(visible: boolean): void {
    this.tileLabelsVisible = visible;
    for (const l of this.tileLabels) l.el.style.display = visible ? '' : 'none';
    this.requestRender();
  }

  /** 타일 중심의 화면 좌표 (테스트·접근성용) */
  tileScreenPosition(tileId: string): { x: number; y: number } | null {
    const t = this.tileById.get(tileId);
    if (!t) return null;
    const p = tileCenter(t, this.metrics).project(this.camera);
    return { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height };
  }

  /** 꼭짓점·변 가운데의 화면 좌표 (테스트·접근성용). 마을은 몸통 높이에서 잰다. */
  spotScreenPosition(kind: 'vertex' | 'edge', id: string): { x: number; y: number } | null {
    const w = kind === 'vertex' ? this.vertexWorld(id)?.add(new THREE.Vector3(0, 0.08, 0)) : this.edgeWorld(id)?.mid.setY(PLATFORM_TOP + 0.06);
    if (!w) return null;
    const p = w.project(this.camera);
    return { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height };
  }

  private pixelRatioTarget(): number {
    const dpr = window.devicePixelRatio || 1;
    if (this.quality === 'low') return Math.min(dpr, 1);
    const max = Math.min(dpr, 2);
    if (this.quality === 'high') return max;
    const steps = [max, max * 0.85, max * 0.72, max * 0.6].map((v) => Math.max(1, v));
    return steps[Math.min(this.pixelStep, steps.length - 1)];
  }

  private applyPixelRatio(): void {
    const ratio = this.pixelRatioTarget();
    if (Math.abs(this.renderer.getPixelRatio() - ratio) > 0.01) {
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(this.width, this.height, false);
      this.painter.setSize(this.width, this.height, ratio);
    }
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.pixelRatioTarget());
    this.renderer.setSize(w, h, false);
    this.painter.setSize(w, h, this.renderer.getPixelRatio());
    this.fitCamera();
    this.requestRender();
  }

  /** 화면에서 HUD 가 가리지 않는 영역 안에 보드 전체가 들어오도록 직교 카메라 범위를 맞춘다. */
  private fitCamera(): void {
    // 타일이 화면에 최대한 크게 보이도록 타일 범위에 맞춘다 (받침 가장자리는 조금 잘려도 된다).
    const fitX = this.fitX;
    const fitZ = this.fitZ;
    const el = THREE.MathUtils.degToRad(ELEVATION_DEG);
    const margin = 0.08;
    const needW = (fitX + margin) * 2;
    const needH = (fitZ + margin) * 2 * Math.sin(el) + 1.1 * Math.cos(el);
    const ins = this.insets;
    const rw = Math.max(80, this.width - ins.left - ins.right);
    const rh = Math.max(80, this.height - ins.top - ins.bottom);
    const unitsPerPx = Math.max(needW / rw, needH / rh);
    const cx = ins.left + rw / 2;
    const cy = ins.top + rh / 2;
    this.camera.left = -cx * unitsPerPx;
    this.camera.right = (this.width - cx) * unitsPerPx;
    this.camera.top = cy * unitsPerPx;
    this.camera.bottom = -(this.height - cy) * unitsPerPx;
    this.camera.updateProjectionMatrix();
  }

  private clampTarget(): void {
    const t = this.controls.target;
    const limX = this.metrics.halfX + 2.5;
    const limZ = this.metrics.halfZ + 2.5;
    const cx = THREE.MathUtils.clamp(t.x, -limX, limX);
    const cz = THREE.MathUtils.clamp(t.z, -limZ, limZ);
    if (cx !== t.x || cz !== t.z) {
      const dx = cx - t.x;
      const dz = cz - t.z;
      t.x = cx;
      t.z = cz;
      this.camera.position.x += dx;
      this.camera.position.z += dz;
    }
  }

  private onControlsChange = (): void => {
    this.clampTarget();
    this.requestRender();
  };

  private onControlsStart = (): void => {
    this.interacting = true;
    this.requestRender();
    // 보드를 끌기 시작하면 마우스 올림 알림을 닫는다 (위치가 맞지 않게 되므로).
    if (this.hovered) {
      this.hovered = null;
      this.updateHighlights();
      this.emitHover();
    }
  };

  private onControlsEnd = (): void => {
    this.interacting = false;
    this.emitPerf(true);
  };

  /**
   * 화면 좌표를 보드 위의 자리로 바꾼다. 빛나는 자리가 있으면 그중 가까운 것을 넉넉하게 잡고,
   * 없으면 꼭짓점 → 변 → 타일 순으로 가까운 것을 고른다. 판정 반경은 확대 수준에 맞춰 화면에서 손가락 크기로 유지한다.
   */
  private pick(clientX: number, clientY: number): BoardSelection | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const ray = this.raycaster.ray;
    const low = new THREE.Vector3();
    const mid = new THREE.Vector3();
    if (!ray.intersectPlane(new THREE.Plane(yAxis, -TILE_TOP), low)) return null;
    // 집·도시는 높이가 있어 몸통을 누르면 바닥보다 조금 뒤쪽이 맞는다. 꼭짓점은 그 높이에서 잰다.
    ray.intersectPlane(new THREE.Plane(yAxis, -(TILE_TOP + 0.14)), mid);
    const worldPerPixel = (this.camera.right - this.camera.left) / this.camera.zoom / Math.max(1, rect.width);
    // 손가락 크기(약 24px)로 잡되, 멀리 축소해도 이웃 꼭짓점(1.32 떨어짐)까지 넘보지 않게 상한을 둔다.
    const reach = Math.min(0.42, Math.max(0.16, 24 * worldPerPixel));
    const flat = (p: THREE.Vector3, q: THREE.Vector3) => Math.hypot(p.x - q.x, p.z - q.z);
    const nearestVertex = (ids: readonly string[]) => {
      let best: { id: string; d: number } | null = null;
      for (const id of ids) {
        const p = this.vertexWorld(id);
        if (!p) continue;
        const d = Math.min(flat(p, mid), flat(p, low));
        if (!best || d < best.d) best = { id, d };
      }
      return best;
    };
    const nearestEdge = (ids: readonly string[]) => {
      let best: { id: string; d: number } | null = null;
      const seg = new THREE.Line3();
      const closest = new THREE.Vector3();
      const at = new THREE.Vector3(low.x, 0, low.z);
      for (const id of ids) {
        const ew = this.edgeWorld(id);
        if (!ew) continue;
        // 양 끝(마을 자리)을 뺀 가운데 부분만 길로 본다. 꼭짓점 가까이 누르면 꼭짓점이 잡힌다.
        const a = new THREE.Vector3(ew.a.x, 0, ew.a.z);
        const b = new THREE.Vector3(ew.b.x, 0, ew.b.z);
        seg.set(a.clone().lerp(b, 0.18), a.clone().lerp(b, 0.82));
        seg.closestPointToPoint(at, true, closest);
        const d = closest.distanceTo(at);
        if (!best || d < best.d) best = { id, d };
      }
      return best;
    };
    // 꼭짓점과 변 가운데 더 가까운 쪽을 고른다 (꼭짓점을 먼저 보면 변 가운데를 눌러도 끝 꼭짓점이 잡힌다).
    const closer = (vIds: readonly string[], eIds: readonly string[], vScale: number, eScale: number): BoardSelection | null => {
      const v = vIds.length ? nearestVertex(vIds) : null;
      const e = eIds.length ? nearestEdge(eIds) : null;
      const vOk = !!v && v.d < reach * vScale;
      const eOk = !!e && e.d < reach * eScale;
      if (vOk && (!eOk || v!.d <= e!.d)) return { kind: 'vertex', id: v!.id };
      if (eOk) return { kind: 'edge', id: e!.id };
      return null;
    };
    const hl = this.state.highlights;
    if (hl?.tiles?.length) {
      let best: { id: string; d: number } | null = null;
      for (const id of hl.tiles) {
        const t = this.tileById.get(id);
        if (!t) continue;
        const d = flat(tileCenter(t, this.metrics), low);
        if (!best || d < best.d) best = { id, d };
      }
      if (best && best.d < HEX_RADIUS) return { kind: 'tile', id: best.id };
    }
    if (hl && (hl.vertices.length || hl.edges.length)) {
      const hit = closer(hl.vertices, hl.edges, 1.7, 1.5);
      if (hit) return hit;
    }
    const hit = closer(
      this.geo.vertices.map((x) => x.id),
      this.geo.edges.map((x) => x.id),
      1,
      0.8,
    );
    if (hit) return hit;
    let tile: { id: string; d: number } | null = null;
    for (const t of this.options.tiles) {
      const d = flat(tileCenter(t, this.metrics), low);
      if (!tile || d < tile.d) tile = { id: t.id, d };
    }
    return tile && tile.d < HEX_RADIUS ? { kind: 'tile', id: tile.id } : null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerDowns.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
    if (this.pointerDowns.size > 1) this.multiTouch = true;
  };

  private onPointerUp = (e: PointerEvent): void => {
    const d = this.pointerDowns.get(e.pointerId);
    this.pointerDowns.delete(e.pointerId);
    const wasMulti = this.multiTouch;
    if (this.pointerDowns.size === 0) this.multiTouch = false;
    if (!d || wasMulti) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    const slop = e.pointerType === 'mouse' ? 6 : 12;
    if (moved > slop || performance.now() - d.t > 650) return;
    const sel = this.pick(e.clientX, e.clientY);
    if (sel) {
      this.pokeAt(sel);
      this.options.onTap?.(sel);
    }
  };

  private onPointerCancel = (e: PointerEvent): void => {
    this.pointerDowns.delete(e.pointerId);
    if (this.pointerDowns.size === 0) this.multiTouch = false;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' || e.buttons !== 0 || !this.ready) return;
    const sel = this.pick(e.clientX, e.clientY);
    if (sel?.kind !== this.hovered?.kind || sel?.id !== this.hovered?.id) {
      this.hovered = sel;
      this.canvas.style.cursor = sel ? 'pointer' : '';
      this.updateHighlights();
      this.requestRender();
      this.emitHover();
    }
  };

  private onVisibility = (): void => {
    if (!document.hidden) this.requestRender();
  };

  private onPointerLeave = (): void => {
    if (this.hovered) {
      this.hovered = null;
      this.updateHighlights();
      this.requestRender();
      this.emitHover();
    }
  };

  /** 마우스가 올라간 자리를 알린다. 위치는 그 자리(꼭짓점·변·타일 가운데) 바로 위의 캔버스 좌표. */
  private emitHover(): void {
    const sel = this.hovered;
    if (!this.options.onHover) return;
    if (!sel) {
      this.options.onHover(null, 0, 0);
      return;
    }
    const at = sel.kind === 'tile' ? this.tileScreenPosition(sel.id) : this.spotScreenPosition(sel.kind, sel.id);
    this.options.onHover(sel, at?.x ?? 0, at?.y ?? 0);
  }

  // ───────────────────────── 그리기 ─────────────────────────

  requestRender(): void {
    if (this.disposed || this.rafId) return;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.rafId = 0;
    if (this.disposed) return;
    // 바람·양·연기만 움직이는 동안에는 초당 30번 정도만 그린다 (배터리를 아낀다).
    const busy = this.interacting || this.anims.length > 0 || this.tokens.length > 0 || this.bouncing.size > 0;
    const ambient = this.motion && this.ready && !document.hidden;
    if (!busy && ambient && now - this.lastAmbient < AMBIENT_FRAME_MS) {
      this.rafId = requestAnimationFrame(this.frame);
      return;
    }
    this.lastAmbient = now;
    let animating = false;
    if (this.anims.length) {
      const keep: Anim[] = [];
      for (const a of this.anims) {
        if (now < a.start) {
          keep.push(a);
          continue;
        }
        const t = Math.min(1, (now - a.start) / a.duration);
        a.update(t);
        if (t < 1) keep.push(a);
        else a.done?.();
      }
      this.anims = keep;
      animating = keep.length > 0;
    }
    if (this.updateTokens(now)) animating = true;
    if (this.ready && (ambient || this.bouncing.size) && this.updateMotion(now)) animating = true;
    const moving = this.controls.update();
    const t0 = performance.now();
    this.renderer.info.reset();
    this.painter.render(this.scene, this.camera);
    this.perf.renderMs = performance.now() - t0;
    this.updateOverlay();
    const continuous = this.interacting || moving || animating;
    this.perf.frame(now, continuous);
    if (continuous) {
      this.autoQuality();
      this.emitPerf(false);
      this.requestRender();
    } else if (ambient) {
      this.requestRender();
    }
  };

  /** 자동 품질: 움직이는 동안 평균 프레임이 30fps 를 못 넘기면 내부 해상도부터 낮춘다. */
  private autoQuality(): void {
    if (this.quality !== 'auto') return;
    const avg = this.perf.recentAvg(45);
    if (avg !== null && avg > 36 && this.pixelStep < 3) {
      const before = this.pixelRatioTarget();
      this.pixelStep += 1;
      if (this.pixelRatioTarget() < before - 0.01) this.applyPixelRatio();
      this.perf.resetRecent();
    }
  }

  private emitPerf(force: boolean): void {
    if (!this.options.onPerf) return;
    const now = performance.now();
    if (!force && now - this.lastPerfEmit < 500) return;
    this.lastPerfEmit = now;
    this.options.onPerf(this.perf.stats(this.perfExtra()));
  }

  private perfExtra() {
    const info = this.renderer.info.render;
    return {
      renderMs: this.perf.renderMs,
      pixelRatio: this.renderer.getPixelRatio(),
      drawCalls: info.calls,
      triangles: info.triangles,
      canvas: `${Math.round(this.width * this.renderer.getPixelRatio())}×${Math.round(this.height * this.renderer.getPixelRatio())}`,
    };
  }

  startPerfRecording(): void {
    this.perf.startRecording();
  }

  stopPerfRecording(): PerfRecording | null {
    return this.perf.stopRecording(this.perfExtra());
  }

  private updateOverlay(): void {
    const w = this.width;
    const h = this.height;
    const place = (item: OverlayItem) => {
      const p = tmpV.copy(item.world).project(this.camera);
      const x = Math.round(((p.x + 1) / 2) * w);
      const y = Math.round(((1 - p.y) / 2) * h);
      if (x !== item.lastX || y !== item.lastY) {
        item.el.style.transform = `translate(${x}px, ${y}px) ${item.anchor}`;
        item.lastX = x;
        item.lastY = y;
      }
    };
    // 숫자 패·교역로 표지는 확대 수준에 맞춰 크기를 조금 바꾼다 (타일 크기에 비례하되 너무 작거나 크지 않게).
    const pxPerUnit = (w * this.camera.zoom) / Math.max(0.001, this.camera.right - this.camera.left);
    const tz = Math.round(Math.min(1.6, Math.max(0.72, pxPerUnit / 46)) * 20) / 20;
    if (tz !== this.overlayScale) {
      this.overlayScale = tz;
      this.overlay.style.setProperty('--tz', String(tz));
    }
    if (this.tileLabelsVisible) this.tileLabels.forEach(place);
    this.numberTokens.forEach(place);
    this.harborLabels.forEach(place);
    this.badges.forEach(place);
    this.floating.forEach(place);
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.controls.removeEventListener('change', this.onControlsChange);
    this.controls.removeEventListener('start', this.onControlsStart);
    this.controls.removeEventListener('end', this.onControlsEnd);
    this.controls.dispose();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const g of this.owned.geometries) g.dispose();
    for (const m of this.owned.materials) m.dispose();
    this.scene.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    });
    this.art?.dispose();
    this.painter.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.overlay.remove();
  }
}
