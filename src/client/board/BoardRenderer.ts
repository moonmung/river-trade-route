// Three.js(WebGL 2) 보드 렌더러.
// - 비스듬한 직교 카메라 + 이동·확대 (회전 없음)
// - 타일 단위 터치 판정 (장식이 아니라 타일 상자에 광선을 쏜다)
// - 반복 소품은 InstancedMesh, 건물 아래 그림자는 미리 구운 텍스처
// - 카메라 조작, 크기 변경, 상태 변경, 짧은 연출 중에만 다시 그린다 (정지 화면은 마지막 프레임 유지)
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import type { Resource, TileDef, TileKind } from '../../shared/types';
import type { PropKey } from './art/builders';
import { loadArtLibrary, type ArtLibrary, type ArtReport, type GroundTextureKey, type LoadProgress } from './assets';
import {
  BANK_WIDTH,
  HEX_RADIUS,
  PLATFORM_TOP,
  RIVER_WIDTH,
  TILE_THICKNESS,
  TILE_TOP,
  WATER_Y,
  boardMetrics,
  hexCorners,
  houseTransform,
  riverCurve,
  sceneryPlacements,
  tileCenter,
  tilePlacements,
  type BoardMetrics,
  type Placement,
} from './layout';
import { PerfMeter, type PerfRecording, type PerfStats } from './perf';

export type HighlightKind = 'buildable' | 'placeable';
export type QualityMode = 'auto' | 'high' | 'low';

export interface BoardSettlementView {
  tileId: string;
  owner: string;
  colorIndex: number;
  /** 접근성/툴팁용 설명 */
  label: string;
}

export interface BoardState {
  settlements: BoardSettlementView[];
  highlights: Partial<Record<string, HighlightKind>>;
  selected: string | null;
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
  onTileTap?: (tileId: string) => void;
  onLoaded?: (report: ArtReport) => void;
  onLoadProgress?: (p: LoadProgress) => void;
  onPerf?: (s: PerfStats) => void;
  showTileLabels?: boolean;
  quality?: QualityMode;
  scenery?: boolean;
}

const ELEVATION_DEG = 54;
const CAMERA_DISTANCE = 40;
const LIGHT_DIR = new THREE.Vector3(-0.55, 1, 0.5).normalize();
/** 그림자가 빛 반대쪽(오른쪽 뒤)으로 살짝 밀리도록 한 오프셋. 조명 방향과 맞춘다. */
const SHADOW_SHIFT = new THREE.Vector2(0.07, -0.06);
const RESOURCE_TOKEN_COLOR: Record<Resource, string> = { wood: '#9a6332', grain: '#e7b52c', stone: '#a7b0ba' };
const HIGHLIGHT_COLOR: Record<HighlightKind | 'selected' | 'hover', string> = {
  placeable: '#ffe066',
  buildable: '#ffe066',
  selected: '#ffffff',
  hover: '#fff6cf',
};
const GROUND_FALLBACK: Record<TileKind | 'grass' | 'dirt' | 'sand', string> = {
  wood: '#5f8a3f',
  grain: '#b8924f',
  stone: '#bdb9ae',
  market: '#cfc0a2',
  grass: '#7aa04b',
  dirt: '#b99e72',
  sand: '#c8b184',
};
const TILE_GROUND: Record<TileKind, GroundTextureKey> = {
  wood: 'ground_forest',
  grain: 'ground_field',
  stone: 'ground_quarry',
  market: 'ground_cobble',
};

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
  private state: BoardState = { settlements: [], highlights: {}, selected: null };
  private firstState = true;
  private hovered: string | null = null;

  private hitBoxes: THREE.Mesh[] = [];
  private highlightRing: THREE.InstancedMesh | null = null;
  private highlightFill: THREE.InstancedMesh | null = null;
  private settlementParts: { mesh: THREE.InstancedMesh; tint: boolean; kind: 'house' | 'banner' }[] = [];
  private settlementShadow: THREE.InstancedMesh | null = null;
  private knownSettlements = new Set<string>();
  private growing = new Map<string, number>();
  private tokenMesh: THREE.InstancedMesh | null = null;
  private tokens: Token[] = [];
  private anims: Anim[] = [];
  private tileLabels: OverlayItem[] = [];
  private badges = new Map<string, OverlayItem>();
  private floating: OverlayItem[] = [];
  private tileLabelsVisible: boolean;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: BoardOptions,
  ) {
    this.metrics = boardMetrics(options.tiles);
    this.tileById = new Map(options.tiles.map((t) => [t.id, t]));
    this.quality = options.quality ?? 'auto';
    this.tileLabelsVisible = options.showTileLabels ?? true;

    const dpr = window.devicePixelRatio || 1;
    // WebGL 2 컨텍스트를 만든다 (three.js r163 이후 WebGL 1 은 지원하지 않는다).
    this.renderer = new THREE.WebGLRenderer({ antialias: dpr < 2, alpha: false, powerPreference: 'default' });
    if (!this.renderer.capabilities.isWebGL2) throw new Error('WebGL 2를 사용할 수 없습니다.');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'board-canvas';
    this.canvas.setAttribute('aria-label', '3D 보드. 타일을 눌러 선택합니다.');
    this.canvas.setAttribute('role', 'img');
    container.appendChild(this.canvas);

    this.overlay = document.createElement('div');
    this.overlay.className = 'board-overlay';
    container.appendChild(this.overlay);

    this.scene.background = new THREE.Color('#5d7a45');

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

    // 조명: 하늘·땅 반사광 + 왼쪽 앞에서 비치는 햇빛. 미리 구운 그림자 방향과 맞춘다.
    const hemi = new THREE.HemisphereLight('#fff6e2', '#5d6a40', 1.7);
    const sun = new THREE.DirectionalLight('#fff1d8', 2.35);
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
      { key: 'banner' as PropKey, variant: 0 },
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
    this.buildSettlementPool();
    this.buildHighlights();
    this.buildTokens();
    this.buildTileLabels();
    this.ready = true;
    this.applyState();
    this.options.onLoaded?.(art.report);
    // 셰이더를 미리 컴파일해 첫 조작 때 끊기지 않게 한다.
    this.renderer.compile(this.scene, this.camera);
    this.requestRender();
  }

  private allStaticPlacements(): Placement[] {
    const list: Placement[] = [];
    for (const t of this.options.tiles) list.push(...tilePlacements(t, this.metrics));
    if (this.options.scenery !== false) list.push(...sceneryPlacements(this.metrics));
    return list;
  }

  private own<T extends THREE.BufferGeometry | THREE.Material>(x: T): T {
    if (x instanceof THREE.BufferGeometry) this.owned.geometries.push(x);
    else this.owned.materials.push(x);
    return x;
  }

  private groundMaterial(key: GroundTextureKey, fallback: string, roughness = 1): THREE.MeshStandardMaterial {
    const map = this.art?.ground(key) ?? null;
    return this.own(
      new THREE.MeshStandardMaterial({ map, color: map ? '#ffffff' : fallback, roughness, metalness: 0 }),
    );
  }

  private buildGround(): void {
    const m = this.metrics;
    // 넓은 풀밭
    const terrain = new THREE.Mesh(
      this.own(scaleUV(new THREE.PlaneGeometry(90, 90).rotateX(-Math.PI / 2), 36)),
      this.groundMaterial('ground_grass', GROUND_FALLBACK.grass),
    );
    terrain.renderOrder = -2;
    this.scene.add(terrain);

    // 강둑(모래)과 강물: 곡선을 따라 띠 모양 도형을 만든다.
    const curve = riverCurve(m);
    const bank = new THREE.Mesh(
      this.own(this.ribbon(curve, RIVER_WIDTH + BANK_WIDTH * 2, 0.012)),
      this.groundMaterial('ground_sand', GROUND_FALLBACK.sand),
    );
    const waterNormal = this.art?.ground('water_normal') ?? null;
    const water = new THREE.Mesh(
      this.own(this.ribbon(curve, RIVER_WIDTH, WATER_Y)),
      this.own(
        new THREE.MeshStandardMaterial({
          color: '#3f7f9e',
          roughness: 0.22,
          metalness: 0.05,
          normalMap: waterNormal,
          normalScale: new THREE.Vector2(0.6, 0.6),
          transparent: true,
          opacity: 0.93,
        }),
      ),
    );
    this.scene.add(bank, water);

    // 흙으로 된 육각 받침 (꼭짓점이 좌우를 향하고 위아래 변이 평평하다). 타일 사이 틈이 흙길이 된다.
    const R = m.plinthRadius;
    const dirtTop = this.groundMaterial('ground_dirt', GROUND_FALLBACK.dirt);
    const dirtSide = this.own(new THREE.MeshStandardMaterial({ color: '#7a5a3a', roughness: 1, map: this.art?.ground('ground_dirt') ?? null }));
    const platformGeo = this.own(new THREE.CylinderGeometry(R, R + 0.2, PLATFORM_TOP, 6, 1, false, Math.PI / 6));
    scaleUV(platformGeo, R);
    const platform = new THREE.Mesh(platformGeo, [dirtSide, dirtTop, dirtSide]);
    platform.position.y = PLATFORM_TOP / 2;
    this.scene.add(platform);
    // 받침 가장자리를 두르는 낮은 나무 테두리
    const rimShape = new THREE.Shape();
    const rimOuter = R + 0.2;
    const rimInner = R - 0.06;
    const flatCorners = (rad: number) =>
      Array.from({ length: 6 }, (_, k) => new THREE.Vector2(Math.cos((k * Math.PI) / 3) * rad, Math.sin((k * Math.PI) / 3) * rad));
    rimShape.setFromPoints(flatCorners(rimOuter));
    rimShape.holes.push(new THREE.Path().setFromPoints(flatCorners(rimInner)));
    const rimGeo = this.own(new THREE.ExtrudeGeometry(rimShape, { depth: 0.07, bevelEnabled: false }).rotateX(-Math.PI / 2));
    const rimMat = this.own(new THREE.MeshStandardMaterial({ color: '#8a5f36', roughness: 0.85 }));
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.y = PLATFORM_TOP - 0.01;
    this.scene.add(rim);

    // 육각 타일 판 (종류별로 하나의 InstancedMesh). 옆면은 밝은 색이라 위에서 보면 타일 테두리처럼 보인다.
    const slabGeo = this.own(new THREE.CylinderGeometry(HEX_RADIUS, HEX_RADIUS + 0.035, TILE_THICKNESS, 6));
    const sideMat = this.own(new THREE.MeshStandardMaterial({ color: '#ecdfbc', roughness: 0.9 }));
    const kinds: TileKind[] = ['wood', 'grain', 'stone', 'market'];
    for (const kind of kinds) {
      const tiles = this.options.tiles.filter((t) => t.kind === kind);
      if (tiles.length === 0) continue;
      const top = this.groundMaterial(TILE_GROUND[kind], GROUND_FALLBACK[kind]);
      const mesh = new THREE.InstancedMesh(slabGeo, [sideMat, top, sideMat], tiles.length);
      tiles.forEach((t, i) => {
        const c = tileCenter(t, m);
        mesh.setMatrixAt(i, compose(c.x, PLATFORM_TOP + TILE_THICKNESS / 2, c.z, 0, 1, 1, 1));
      });
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
    }

    // 타일 안쪽 가장자리를 살짝 어둡게 칠해 눌러 찍은 보드게임 타일처럼 보이게 한다 (한 번의 그리기 호출).
    const edgeGeo = this.own(this.hexEdgeShade(HEX_RADIUS - 0.005, HEX_RADIUS - 0.2, 0.32));
    const edgeMat = this.own(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const edges = new THREE.InstancedMesh(edgeGeo, edgeMat, this.options.tiles.length);
    this.options.tiles.forEach((t, i) => {
      const c = tileCenter(t, m);
      edges.setMatrixAt(i, compose(c.x, TILE_TOP + 0.003, c.z, 0, 1, 1, 1));
    });
    edges.computeBoundingSphere();
    edges.renderOrder = 1;
    this.scene.add(edges);

    // 터치 판정용 투명 타일 상자 (소품이 아니라 타일 단위로 고른다)
    const hitGeo = this.own(new THREE.CylinderGeometry(HEX_RADIUS + 0.06, HEX_RADIUS + 0.06, 0.7, 6));
    const hitMat = this.own(new THREE.MeshBasicMaterial({ visible: false }));
    for (const t of this.options.tiles) {
      const c = tileCenter(t, m);
      const box = new THREE.Mesh(hitGeo, hitMat);
      box.position.set(c.x, TILE_TOP + 0.2, c.z);
      box.userData.tileId = t.id;
      box.updateMatrixWorld();
      this.hitBoxes.push(box);
    }
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

  private ribbon(curve: THREE.CatmullRomCurve3, width: number, y: number): THREE.BufferGeometry {
    const steps = 160;
    const pts = curve.getSpacedPoints(steps);
    const length = curve.getLength();
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const p = pts[i];
      const t = curve.getTangentAt(i / steps);
      const nx = -t.z;
      const nz = t.x;
      const len = Math.hypot(nx, nz) || 1;
      const w = width / 2;
      pos.push(p.x + (nx / len) * w, y, p.z + (nz / len) * w, p.x - (nx / len) * w, y, p.z - (nz / len) * w);
      const v = ((i / steps) * length) / 2;
      uv.push(0, v, width / 2, v);
      if (i < steps) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // 띠가 아래를 향하면 위로 뒤집는다.
    const n = g.attributes.normal;
    if (n.getY(0) < 0) {
      g.setIndex(idx.map((_, i) => idx[i - (i % 3) + (2 - (i % 3))]));
      g.computeVertexNormals();
    }
    return g;
  }

  private shadowMaterial(opacity: number): THREE.MeshBasicMaterial {
    return this.own(
      new THREE.MeshBasicMaterial({
        color: '#000000',
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
      for (const part of template.parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        list.forEach((p, i) =>
          mesh.setMatrixAt(i, compose(p.x, p.y, p.z, p.rotY, p.scale * (p.stretch ?? 1), p.scale * (p.sy ?? 1), p.scale)),
        );
        mesh.computeBoundingSphere();
        this.scene.add(mesh);
      }
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
  }

  private buildSettlementPool(): void {
    const art = this.art!;
    const capacity = 16;
    for (const kind of ['house', 'banner'] as const) {
      const template = art.prop(kind, 0);
      for (const part of template.parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
        mesh.count = 0;
        if (part.tint) {
          for (let i = 0; i < capacity; i++) mesh.setColorAt(i, new THREE.Color('#ffffff'));
        }
        mesh.frustumCulled = false;
        this.settlementParts.push({ mesh, tint: part.tint, kind });
        this.scene.add(mesh);
      }
    }
    const quad = this.own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    this.settlementShadow = new THREE.InstancedMesh(quad, this.shadowMaterial(0.55), capacity);
    this.settlementShadow.count = 0;
    this.settlementShadow.frustumCulled = false;
    this.settlementShadow.renderOrder = 1;
    this.scene.add(this.settlementShadow);
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
  }

  private buildTokens(): void {
    const geo = this.own(new THREE.CylinderGeometry(0.1, 0.1, 0.04, 18));
    const mat = this.own(new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.25 }));
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
        // 타일 앞쪽 꼭짓점 근처 (거점·소품과 겹치지 않는 자리)
        world: new THREE.Vector3(c.x, TILE_TOP, c.z + HEX_RADIUS - 0.16),
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
    const m = this.metrics;
    // 거점
    const current = new Set(s.settlements.map((st) => `${st.tileId}:${st.owner}`));
    if (!this.firstState) {
      for (const st of s.settlements) {
        const key = `${st.tileId}:${st.owner}`;
        if (!this.knownSettlements.has(key)) this.animateGrow(st.tileId);
      }
    }
    this.firstState = false;
    this.knownSettlements = current;
    this.updateSettlementInstances();

    // 거점 위 소유자 표식 (HTML: 색 + 모양)
    const seen = new Set<string>();
    for (const st of s.settlements) {
      const tile = this.tileById.get(st.tileId);
      if (!tile) continue;
      seen.add(st.tileId);
      let item = this.badges.get(st.tileId);
      if (!item) {
        const el = document.createElement('div');
        el.className = 'owner-badge';
        this.overlay.appendChild(el);
        const { banner } = houseTransform(tile, m);
        item = { el, world: banner.clone().add(new THREE.Vector3(0.16, 1.06, 0)), anchor: 'translate(-50%, -100%)' };
        this.badges.set(st.tileId, item);
      }
      const key = `${st.owner}:${st.colorIndex}`;
      if (item.el.dataset.key !== key) {
        item.el.dataset.key = key;
        item.el.innerHTML = this.options.emblemMarkup(st.colorIndex);
        item.el.title = st.label;
      }
    }
    for (const [tileId, item] of this.badges) {
      if (!seen.has(tileId)) {
        item.el.remove();
        this.badges.delete(tileId);
      }
    }
    this.updateHighlights();
    this.requestRender();
  }

  private updateSettlementInstances(): void {
    const m = this.metrics;
    const list = this.state.settlements.filter((st) => this.tileById.has(st.tileId));
    const color = new THREE.Color();
    for (const part of this.settlementParts) {
      list.forEach((st, i) => {
        const tile = this.tileById.get(st.tileId)!;
        const t = houseTransform(tile, m);
        const g = this.growing.get(st.tileId) ?? 1;
        const p = part.kind === 'house' ? t.house : t.banner;
        part.mesh.setMatrixAt(i, compose(p.x, p.y, p.z, 0, g, g, g));
        if (part.tint) {
          color.set(this.options.playerColors[st.colorIndex % this.options.playerColors.length]);
          part.mesh.setColorAt(i, color);
        }
      });
      part.mesh.count = list.length;
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
    if (this.settlementShadow) {
      list.forEach((st, i) => {
        const tile = this.tileById.get(st.tileId)!;
        const { house } = houseTransform(tile, m);
        const g = this.growing.get(st.tileId) ?? 1;
        this.settlementShadow!.setMatrixAt(i, compose(house.x + SHADOW_SHIFT.x, TILE_TOP + 0.005, house.z + SHADOW_SHIFT.y, 0, 0.98 * g, 1, 0.78 * g));
      });
      this.settlementShadow.count = list.length;
      this.settlementShadow.instanceMatrix.needsUpdate = true;
    }
  }

  private updateHighlights(): void {
    const ring = this.highlightRing;
    const fill = this.highlightFill;
    if (!ring || !fill) return;
    const color = new THREE.Color();
    this.options.tiles.forEach((t, i) => {
      const c = tileCenter(t, this.metrics);
      const hl = this.state.highlights[t.id];
      const selected = this.state.selected === t.id;
      const hovered = this.hovered === t.id;
      let kind: keyof typeof HIGHLIGHT_COLOR | null = null;
      if (selected) kind = 'selected';
      else if (hl) kind = hl;
      else if (hovered) kind = 'hover';
      const show = kind !== null;
      ring.setMatrixAt(i, compose(c.x, TILE_TOP + 0.012, c.z, 0, show ? 1 : 0, 1, show ? 1 : 0));
      const showFill = selected || !!hl;
      fill.setMatrixAt(i, compose(c.x, TILE_TOP + 0.008, c.z, 0, showFill ? 1 : 0, 1, showFill ? 1 : 0));
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

  // ───────────────────────── 연출 ─────────────────────────

  private addAnim(a: Omit<Anim, 'start'> & { delay?: number }): void {
    this.anims.push({ ...a, start: performance.now() + (a.delay ?? 0) });
    this.requestRender();
  }

  private animateGrow(tileId: string): void {
    this.growing.set(tileId, 0.01);
    this.addAnim({
      duration: 520,
      update: (t) => {
        this.growing.set(tileId, Math.max(0.01, easeOutBack(t)));
        this.updateSettlementInstances();
      },
      done: () => {
        this.growing.delete(tileId);
        this.updateSettlementInstances();
      },
    });
  }

  /** 라운드 시작 공동 생산 연출: 거점에서 자원 토큰이 솟아오른다. */
  playProduction(items: { tileId: string; resource: Resource; amount: number; colorIndex: number }[]): void {
    if (!this.ready) return;
    const now = performance.now();
    items.forEach((item, idx) => {
      const tile = this.tileById.get(item.tileId);
      if (!tile) return;
      const { house } = houseTransform(tile, this.metrics);
      for (let k = 0; k < item.amount; k++) {
        const from = house.clone().add(new THREE.Vector3((k - (item.amount - 1) / 2) * 0.22, 0.75, 0.1));
        this.tokens.push({
          start: now + idx * 90 + k * 140,
          duration: 1100,
          from,
          to: from.clone().add(new THREE.Vector3(0, 0.9, 0)),
          arc: 0,
          color: new THREE.Color(RESOURCE_TOKEN_COLOR[item.resource]),
          spin: 5,
        });
      }
      this.spawnFloating(
        house.clone().add(new THREE.Vector3(0, 1.1, 0)),
        `+${item.amount}`,
        `float-label float-${item.resource}`,
        idx * 90,
      );
    });
    this.requestRender();
  }

  /** 납품 연출: 납품한 사람의 거점에서 가까운 시장으로 물자가 날아간다. */
  playDelivery(fromTileIds: string[], resources: Resource[], points: number): void {
    if (!this.ready) return;
    const markets = this.options.tiles.filter((t) => t.kind === 'market');
    if (markets.length === 0) return;
    const starts = fromTileIds
      .map((id) => this.tileById.get(id))
      .filter((t): t is TileDef => !!t)
      .map((t) => houseTransform(t, this.metrics).house.clone().add(new THREE.Vector3(0, 0.5, 0)));
    if (starts.length === 0) starts.push(new THREE.Vector3(0, TILE_TOP + 0.5, 0));
    const origin = starts[0];
    const market = markets
      .map((t) => tileCenter(t, this.metrics))
      .sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin))[0];
    const target = market.clone().add(new THREE.Vector3(0, 0.45, 0.2));
    const now = performance.now();
    resources.forEach((r, i) => {
      this.tokens.push({
        start: now + i * 120,
        duration: 900,
        from: starts[i % starts.length].clone(),
        to: target.clone().add(new THREE.Vector3((i - (resources.length - 1) / 2) * 0.18, 0, 0)),
        arc: 1.1,
        color: new THREE.Color(RESOURCE_TOKEN_COLOR[r]),
        spin: 8,
      });
    });
    this.spawnFloating(target.clone().add(new THREE.Vector3(0, 0.7, 0)), `+${points}점`, 'float-label float-points', 700);
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
    }
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.pixelRatioTarget());
    this.renderer.setSize(w, h, false);
    this.fitCamera();
    this.requestRender();
  }

  /** 화면에서 HUD 가 가리지 않는 영역 안에 보드 전체가 들어오도록 직교 카메라 범위를 맞춘다. */
  private fitCamera(): void {
    // 타일이 화면에 최대한 크게 보이도록 타일 범위에 맞춘다 (받침 가장자리는 조금 잘려도 된다).
    const { fitX, fitZ } = this.metrics;
    const el = THREE.MathUtils.degToRad(ELEVATION_DEG);
    const margin = 0.22;
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
  };

  private onControlsEnd = (): void => {
    this.interacting = false;
    this.emitPerf(true);
  };

  private pick(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.hitBoxes, false)[0];
    return (hit?.object.userData.tileId as string | undefined) ?? null;
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
    const tile = this.pick(e.clientX, e.clientY);
    if (tile) this.options.onTileTap?.(tile);
  };

  private onPointerCancel = (e: PointerEvent): void => {
    this.pointerDowns.delete(e.pointerId);
    if (this.pointerDowns.size === 0) this.multiTouch = false;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' || e.buttons !== 0 || !this.ready) return;
    const tile = this.pick(e.clientX, e.clientY);
    if (tile !== this.hovered) {
      this.hovered = tile;
      this.canvas.style.cursor = tile ? 'pointer' : '';
      this.updateHighlights();
      this.requestRender();
    }
  };

  private onPointerLeave = (): void => {
    if (this.hovered) {
      this.hovered = null;
      this.updateHighlights();
      this.requestRender();
    }
  };

  // ───────────────────────── 그리기 ─────────────────────────

  requestRender(): void {
    if (this.disposed || this.rafId) return;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.rafId = 0;
    if (this.disposed) return;
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
    const moving = this.controls.update();
    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.perf.renderMs = performance.now() - t0;
    this.updateOverlay();
    const continuous = this.interacting || moving || animating;
    this.perf.frame(now, continuous);
    if (continuous) {
      this.autoQuality();
      this.emitPerf(false);
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
    if (this.tileLabelsVisible) this.tileLabels.forEach(place);
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
    for (const g of this.owned.geometries) g.dispose();
    for (const m of this.owned.materials) m.dispose();
    this.scene.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    });
    this.art?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.overlay.remove();
  }
}
