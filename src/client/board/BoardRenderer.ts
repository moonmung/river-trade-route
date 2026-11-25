// Three.js(WebGL 2) 보드 렌더러.
// - 비스듬한 직교 카메라 + 이동·확대 (회전 없음)
// - 타일 단위 터치 판정 (장식이 아니라 타일 상자에 광선을 쏜다)
// - 반복 소품은 InstancedMesh, 건물 아래 그림자는 미리 구운 텍스처
// - 카메라 조작, 크기 변경, 상태 변경, 짧은 연출 중에만 다시 그린다 (정지 화면은 마지막 프레임 유지)
// - 만화 음영 재질과 수채화 후처리(먹선·종이 결·물감 얼룩)로 손으로 그린 삽화처럼 보이게 한다 (paint.ts)
import * as THREE from 'three';
import { boardGeometry, innerCoastEdges, type BoardGeometry, type EdgeDef } from '../../shared/board';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { RESOURCES, RESOURCE_LABEL, numberPips } from '../../shared/constants';
import { longestRoadPath } from '../../shared/rules';
import type { Bundle, Harbor, Resource, TileDef, TileKind } from '../../shared/types';
import { GOODS_VARIANT, ROAD_DECK_TOP, SOLDIER_REACH, SOLDIER_SHOULDER, type PropKey } from './art/builders';
import { PARADE_LOWER_MS, paradeTiming, type ParadeTiming } from './parade';
import { harborLegs } from './harborTrade';
import { loadArtLibrary, type ArtLibrary, type ArtReport, type GroundTextureKey, type LoadProgress } from './assets';
import {
  DAIS_HEIGHT,
  HEX_APOTHEM,
  HEX_RADIUS,
  HEX_SPACING,
  PLATFORM_TOP,
  PLAZA_STATUE_SPOT,
  STATUE_SPOT,
  TOKEN_FACE,
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
import { GLOW_SLOTS, PaintedRenderer, greyWhenLocked, paintGlow, paintLock, paintMaterial, paintTime } from './paint';
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
  ownerMarkup: (colorIndex: number) => string;
  /** 자리를 눌렀다. alt: Alt 키를 누른 채 눌렀다 (핑 찍기) */
  onTap?: (sel: BoardSelection, info: { alt: boolean }) => void;
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
  /** 소품·조각이 바닥과 옆 소품에 드리우는 그림자 (기본 켬, 품질이 낮음이면 늘 끈다) */
  shadows?: boolean;
}

const ELEVATION_DEG = 54;
const ELEVATION_RAD = THREE.MathUtils.degToRad(ELEVATION_DEG);
/** 장면에서 카메라 쪽을 가리키는 방향 (카메라는 돌지 않으므로 한 번만 구한다) */
const VIEW_AXIS = new THREE.Vector3(0, Math.sin(ELEVATION_RAD), Math.cos(ELEVATION_RAD));
const CAMERA_DISTANCE = 40;
const LIGHT_DIR = new THREE.Vector3(-0.55, 1, 0.5).normalize();
/** 그림자 맵 해상도 (보드 전체를 한 장에 담는다). 품질이 높음이면 2048, 자동이면 휴대폰 메모리를 아껴 1024 (칸 하나가 약 60픽셀). */
const SHADOW_MAP_SIZE: Record<QualityMode, number> = { high: 2048, auto: 1024, low: 1024 };
/** 그늘에서 빠지는 햇빛의 비율 (1 이면 햇빛이 모두 가려진다) */
const SHADOW_INTENSITY = 0.75;
/** 그림자가 빛 반대쪽(오른쪽 뒤)으로 살짝 밀리도록 한 오프셋. 조명 방향과 맞춘다. */
const SHADOW_SHIFT = new THREE.Vector2(0.07, -0.06);
/**
 * 날아가는 생산물(통나무·볏단·양·벽돌·돌덩이)의 크기와 날아가는 동안 구르는 바퀴 수.
 * 기본 줌에서도 모양을 알아보도록 마을 집보다 조금 크게 그린다 (잠깐 날아가는 연출이라 과장해도 된다).
 */
const GOODS_SIZE: Record<Resource, number> = { wood: 1.5, grain: 1.5, wool: 1.2, brick: 1.55, stone: 1.5 };
const GOODS_TURNS: Record<Resource, number> = { wood: 2, grain: 1.5, wool: 1, brick: 1.5, stone: 1.75 };
/** 생산물 한 종류가 한꺼번에 날 수 있는 수 */
/** 자원마다 한꺼번에 날아가는 생산물 수 (8명이 도시를 많이 지은 대형 맵도 넉넉하게) */
const GOODS_CAPACITY = 96;
/** 달성 연출(최장 교역로·최강 기사단)의 금빛 */
const AWARD_GOLD = '#ffd45a';
const SPARKLE_MAX = 120;
/** 길 위 교역인: 길 두세 개에 한 명, 한 사람에 최대 다섯 명, 보드 전체 최대 열여덟 명 */
const TRADER_ROADS_EACH = 2.5;
const TRADER_MAX_EACH = 5;
const TRADER_MAX = 18;
/** 교역인 크기: 키 약 0.17 로 마을 집(약 0.55)의 3분의 1쯤이다. 굵은 길 위에서 장식으로만 보이게 작게 둔다. */
const TRADER_SCALE = 0.82;
/** 교역인이 걷는 빠르기 (초당 거리, 변 하나는 1.32) */
const TRADER_SPEED = 0.2;
/** 교역인이 마을·도시 앞에서 돌아서는 거리 (집 몸통 바로 앞) */
const TRADER_HOUSE_STOP = 0.3;
/** 도시는 성벽이 넓게 둘러서 그 앞에서 돌아선다 */
const TRADER_CITY_STOP = 0.42;
/** 교역인 발 높이 (길 판자 윗면) */
const TRADER_FOOT = PLATFORM_TOP + 0.004 + ROAD_DECK_TOP;
/** 길 위에서 오른쪽으로 비켜 걷는 거리 (마주 오는 사람과 엇갈린다) */
const TRADER_KEEP_RIGHT = 0.042;
type BoardPieceKind = 'village' | 'city' | 'road' | 'joint';
/** 해상 교역 배: 한꺼번에 뜰 수 있는 수, 크기(길이 약 0.55), 연출 길이(들어옴 → 짐 주고받기 → 떠남) */
const SHIP_MAX = 4;
const SHIP_SCALE = 0.55;
const SHIP_MS = 2800;
/** 배가 들어오기를 마치는 때와 떠나기 시작하는 때 (연출 길이 대비) */
const SHIP_IN = 0.3;
const SHIP_OUT = 0.72;
/** 가마 하나에서 동시에 피어오르는 연기 공 수 */
const SMOKE_PUFFS = 5;
/** 바람·양·연기만 움직일 때 프레임 간격 (약 30fps) */
const AMBIENT_FRAME_MS = 33;
/**
 * 꼭짓점에 놓는 집(마을)·도시의 크기. 실제 보드게임 말처럼 평평한 판 위에 큼직하게 세워 멀리서도 누구 것인지 보인다.
 * 마을 집은 폭 약 0.5, 키 약 0.55 이다. 도시는 성벽 둘레가 폭 약 0.76, 깊이 약 0.64 이고 큰 탑 깃발까지 키가 약 1.0 이라
 * 마을보다 한 둘레 크게 보인다 (변 하나는 1.32).
 */
const VILLAGE_SCALE = 0.78;
const CITY_SCALE = 1;
/** 마을·도시 위 소유자 문양 높이 (지붕·탑 꼭대기 바로 위) */
const BADGE_LIFT = { village: VILLAGE_SCALE * 0.86, city: CITY_SCALE * 1.1 };
/** 꼭짓점 판정에서 마을·도시가 서 있으면 몸통 크기만큼 넉넉히 더 잡는 거리 */
const PIECE_PICK_BONUS = { village: 0.36 * VILLAGE_SCALE, city: 0.36 * CITY_SCALE };
/** 길 판자가 변 길이에서 차지하는 비율 (양 끝은 마을 자리로 비워 둔다. 커진 집이 들어설 만큼) */
const ROAD_FRACTION = 0.64;
/** 판자가 꼭짓점까지 늘어나지 않은 쪽 끝에 비워 둔 몫 (변 길이 대비) */
const ROAD_GAP = (1 - ROAD_FRACTION) / 2;
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
  wood: '#4a5a2f',
  grain: '#94773f',
  wool: '#8fa55e',
  brick: '#93593b',
  stone: '#857f72',
  plaza: '#9d8a6a',
};
/**
 * 빈 변의 샛길: 타일 사이 흙 땅(틈 폭 약 0.31) 한가운데로 난 희끄무레한 오솔길.
 * 반폭은 판자 길(폭 0.22)보다 좁아 길을 놓으면 판자에 거의 가리고, 구불거림은 틈 밖으로 나가지 않을 만큼만 준다.
 */
const PATH_HALF = 0.046;
/** 샛길 중심선이 변에서 옆으로 벗어나는 최대 거리 (변 가운데에서 가장 크고 꼭짓점에서는 0) */
const PATH_WANDER = 0.04;
/** 샛길 거리장 텍스처에 담는 거리 (중심선에서 이보다 먼 곳은 모두 같은 값) */
const PATH_FIELD_REACH = 0.22;
/** 거리장 텍스처의 1 단위당 화소 수 */
const PATH_FIELD_PPU = 40;
/** 갈림길에서 세 갈래를 부드럽게 합치는 정도 (작을수록 날카롭다) */
const PATH_JOIN = 0.02;
/** 바닷가 변에서 흙 땅이 바다 쪽으로 더 나간 폭 */
const LAND_MARGIN = 0.3;
/** 모래밭 윗면 높이 (흙 땅보다 낮다). 흙 땅 가장자리 밑에서 이 높이로 시작해 바다 쪽으로 비스듬히 내려간다. */
const BEACH_TOP = 0.13;
/** 모래밭이 물 밑으로 잠기는 끝의 높이 (물은 0) */
const BEACH_LOW = -0.07;
/** 모래밭 띠의 안쪽(흙 땅 밑)과 바깥쪽(물 밑) 끝: 바닷가 변에서 떨어진 거리 */
const BEACH_IN = LAND_MARGIN - 0.04;
const BEACH_OUT = LAND_MARGIN + 0.66;
/** 모래밭이 물과 만나는 줄 (물가) */
const WATERLINE = BEACH_IN + ((BEACH_OUT - BEACH_IN) * BEACH_TOP) / (BEACH_TOP - BEACH_LOW);
/** 물가에서 이만큼 나가면 깊은 물(장면 배경색)이 된다 */
const SEA_REACH = 3.4;
/** 물가에서 떨어진 거리별 물빛: 젖은 모래 → 옥빛 → 얕은 물 → 깊은 물 */
const SEA_RAMP: [number, string][] = [
  [0, '#cfdcbf'],
  [0.18, '#acdcd0'],
  [0.7, '#8ccad0'],
  [1.6, '#72b4c4'],
  [2.5, '#619fbb'],
  [SEA_REACH, WATER_COLOR],
];

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 물가에서 d 만큼 떨어진 곳의 물빛 (sRGB 로 섞는다. 캔버스 색과 장면 배경색이 같은 공간이다) */
function seaColor(d: number): string {
  let i = 1;
  while (i < SEA_RAMP.length - 1 && d > SEA_RAMP[i][0]) i++;
  const [d0, c0] = SEA_RAMP[i - 1];
  const [d1, c1] = SEA_RAMP[i];
  const t = Math.max(0, Math.min(1, (d - d0) / (d1 - d0)));
  const s = t * t * (3 - 2 * t);
  const a = hexRgb(c0);
  const b = hexRgb(c1);
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * s)).join(', ')})`;
}
/** 바닷가 변 가운데에서 교역로 부두 중심까지 거리 */
const HARBOR_REACH = 1.0;
/** 화면에 담을 범위: 타일 꼭짓점 바깥으로 이만큼 더 (모래밭이 조금 보이게) */
const FIT_PAD = 0.32;
const STATUE_SCALE = 0.86;
/** 최강 기사단 사열 병사 크기 (키 약 0.33, 동상의 절반쯤) */
const SOLDIER_SCALE = 0.62;
/** 칼 든 팔의 어깨 각도: 칼끝을 앞쪽 아래로 내린 차렷과 하늘로 치켜든 경례 */
const SOLDIER_ARM_REST = 0.8;
const SOLDIER_ARM_SALUTE = -1.45;
/** 광장 돌 단 위 대열: 병사 사이와 줄 사이 (돌 단 가운데 기준, 앞줄이 카메라 쪽) */
const PARADE_FILE_GAP = 0.19;
const PARADE_RANK_GAP = 0.2;
/** 동상이 광장 돌 단에 서 있으면 병사들이 돌 단 둘레에 둥글게 서서 동상을 본다 (둘레 소품 안쪽) */
const PARADE_RING = 0.55;
/** 돌 단 두 층의 반지름: 안쪽 높은 층, 바깥 낮은 층 (art/builders 의 buildDais) */
const DAIS_TOP_R = 0.29;
const DAIS_LOW_R = 0.39;
/** 잠금 사슬 육각형 반지름 (꼭짓점의 마을과 겹치지 않게 타일보다 조금 안쪽) */
const CHAIN_RADIUS = HEX_RADIUS - 0.17;
const PADLOCK_SCALE = 2.3;
/** 잠긴 칸이 무채색이 되는 육각형의 중심~변 거리. 타일 옆면 아래까지 덮도록 타일보다 조금 넓다. */
const LOCK_APOTHEM = HEX_APOTHEM + 0.04;
/** 잠긴 칸 중심에서 잿빛이 다 번졌을 때의 반지름 (육각형 꼭짓점 너머까지) */
const LOCK_REACH = 1.65;
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
  /** 제자리에서 옮겨 그린 몫 (거니는 양). 눌려 튈 때도 이 자리와 방향에서 튄다. */
  pose?: { dx: number; dy: number; dz: number; rot: number };
  /** 그림자를 제자리에서 옮겨 둔 상태인지 (제자리로 돌릴 때 그림자도 함께 돌린다) */
  shadowMoved?: boolean;
}

/** 날아가는 생산물 하나 */
interface Token {
  start: number;
  duration: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  arc: number;
  resource: Resource;
  /** 구르는 축 (날아가는 방향에 수직인 가로 축) */
  axis: THREE.Vector3;
  /** 처음 놓인 방향 (y 축 회전) */
  yaw: number;
  /** 날아가는 동안 구르는 각도 */
  spin: number;
}

/** 달성 연출의 반짝이 하나 (화면을 향한 네 갈래 별) */
interface Sparkle {
  start: number;
  duration: number;
  pos: THREE.Vector3;
  size: number;
  spin: number;
  rise: number;
}

/** 해상 교역로 교환 때 부두에 들어왔다 떠나는 배 하나 */
interface Ship {
  /** 연출 진행 (0~1) */
  t: number;
  /** 바다에서 나타나는 곳, 부두 옆에 대는 곳, 떠나서 사라지는 곳 */
  sea: THREE.Vector3;
  berth: THREE.Vector3;
  away: THREE.Vector3;
  /** 부두에 댄 동안 뱃머리 방향 (바닷가와 나란히) */
  dockYaw: number;
  colorIndex: number;
  seed: number;
}

/** 최강 기사단 사열: 빈 광장에 줄지어 선 그 사람의 병사들 */
interface Parade {
  members: {
    /** 발 딛는 자리 */
    at: THREE.Vector3;
    /** 보는 방향 (돌 단 대열은 카메라 쪽, 둥근 대열은 동상 쪽) */
    yaw: number;
    /** 몇 번째 줄(들어서는 차례)과 줄 안 자리 */
    rank: number;
    file: number;
  }[];
  colorIndex: number;
  timing: ParadeTiming;
  golden: boolean;
  /** 칼을 치켜들며 칼끝이 반짝인 병사 */
  sparked: Set<number>;
}

/** 길 위를 오가는 교역인 한 명 */
interface Trader {
  owner: string;
  colorIndex: number;
  edge: string;
  /** 변의 a → b 로 걸으면 1, b → a 면 -1 */
  dir: 1 | -1;
  /** 변 위 자리 (0 = a 꼭짓점, 1 = b 꼭짓점) */
  t: number;
  /** 멈춰 선 채 남은 시간(초). 마을·도시 앞이나 길 끝에서 돌아설 때 */
  wait: number;
  /** 몸이 보는 방향. 걷는 쪽으로 천천히 돌아선다. */
  yaw: number;
  /** 변의 a→b 오른쪽으로 비켜 선 거리 (걷는 방향의 오른쪽으로 서서히 옮겨 간다) */
  lat: number;
  /** 걸음 박자 */
  stride: number;
  seed: number;
  turns: number;
  scale: number;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const yAxis = new THREE.Vector3(0, 1, 0);
const xAxis = new THREE.Vector3(1, 0, 0);
const zAxis = new THREE.Vector3(0, 0, 1);

/** 가운데가 밝고 바깥으로 부드럽게 사라지는 둥근 빛. 더하기로 섞어 칠하며 길쭉하게 늘이면 길을 따라 번진 빛이 된다. */
function glowTexture(): THREE.DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot(((x + 0.5) / n) * 2 - 1, ((y + 0.5) / n) * 2 - 1);
      const v = Math.round(Math.pow(Math.max(0, 1 - r), 1.7) * 255);
      data.set([v, v, v, 255], (y * n + x) * 4);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 네 갈래 반짝이 별. 카메라가 돌지 않으므로 미리 화면 쪽으로 세워 둔다. */
function sparkleGeometry(): THREE.BufferGeometry {
  const star = new THREE.Shape();
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 4;
    const r = i % 2 ? 0.24 : 1;
    if (i === 0) star.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else star.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  return new THREE.ShapeGeometry(star).rotateX(-ELEVATION_RAD);
}

function compose(x: number, y: number, z: number, rotY: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  tmpQ.setFromAxisAngle(yAxis, rotY);
  return tmpM.compose(tmpV.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz));
}

function scaleUV(g: THREE.BufferGeometry, su: number, sv = su): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

/** 흙 땅 윗면에 샛길을 칠하는 셰이더 조각 (paintMaterial 이 선언한 vPaintWorld·uPaintNoise 를 쓴다) */
const FOOTPATH_UNIFORMS = /* glsl */ `
uniform sampler2D uPathField;
uniform vec4 uPathBox;
uniform float uPathReach;
uniform float uPathHalf;
uniform vec3 uPathLight;
uniform vec3 uPathDark;
uniform vec3 uPathVerge;`;

const FOOTPATH_FRAGMENT = /* glsl */ `
  {
    // 샛길 중심선까지의 거리. 넓은 흔들림과 잔 알갱이를 더해 가장자리가 고르지 않고 폭도 들쭉날쭉하다.
    float pathD = texture2D( uPathField, ( vPaintWorld.xz - uPathBox.xy ) * uPathBox.zw ).r * uPathReach;
    vec4 pathWide = texture2D( uPaintNoise, vPaintWorld.xz * 0.21 + 0.13 );
    float pathGrain = texture2D( uPaintNoise, vPaintWorld.xz * 0.83 + 0.37 ).r;
    pathD += ( pathWide.b - 0.5 ) * 0.045 + ( pathGrain - 0.5 ) * 0.02;
    // 경계를 넓게 풀어 후처리 먹선이 가장자리에 줄을 긋지 않게 한다.
    float onPath = 1.0 - smoothstep( uPathHalf - 0.024, uPathHalf + 0.024, pathD );
    // 길가: 사람이 밟고 다녀 풀이 눌린 짙은 흙
    float verge = ( 1.0 - smoothstep( uPathHalf, uPathHalf + 0.11, pathD ) ) * ( 1.0 - onPath );
    diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uPathVerge, verge );
    // 길 바닥: 희끄무레한 모래·자갈에 잔돌이 드문드문 박혔다.
    float pebble = smoothstep( 0.72, 0.8, texture2D( uPaintNoise, vPaintWorld.xz * 1.3 + 0.71 ).r );
    vec3 pathCol = mix( uPathLight, uPathDark, clamp( pathWide.g * 0.5 + pebble * 0.45, 0.0, 1.0 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, pathCol, onPath );
  }`;

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
  private readonly owned: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[]; textures: THREE.Texture[] } = {
    geometries: [],
    materials: [],
    textures: [],
  };
  private readonly perf = new PerfMeter();
  private readonly resizeObserver: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerDowns = new Map<number, { x: number; y: number; t: number }>();

  private art: ArtLibrary | null = null;
  /** 햇빛. 정적 그림자 맵을 드리운다. */
  private sun!: THREE.DirectionalLight;
  /** 그림자를 켰는지 (설정 값. 품질이 낮음이면 이 값과 상관없이 끈다) */
  private shadowsWanted = true;
  /** 다음 그림에서 그림자 맵을 다시 그려야 하는지 (보드 모양이 바뀌었을 때만) */
  private shadowDirty = true;
  private ready = false;
  private disposed = false;
  private rafId = 0;
  private interacting = false;
  private multiTouch = false;
  private width = 1;
  private height = 1;
  /** 캔버스 크기를 한 번이라도 맞췄는지 */
  private sized = false;
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
  /** 생산물 모양별 인스턴스 메시 (부품마다 하나) */
  private goods = new Map<Resource, THREE.InstancedMesh[]>();
  private goodsShown = false;
  private tokens: Token[] = [];
  /**
   * 달성 연출로 빛나는 조각과 세기 (0~1). 'r:<변>' 길, 'v:<꼭짓점>' 길 이음목, 'b:<꼭짓점>' 마을·도시, 's' 기사단 동상.
   * 플레이어 색에 금빛을 섞어 밝히고 그 자리 바닥에도 금빛을 더한다.
   */
  private glow = new Map<string, number>();
  private glowMesh: THREE.InstancedMesh | null = null;
  private sparkleMesh: THREE.InstancedMesh | null = null;
  private sparkles: Sparkle[] = [];
  /** 길 위 교역인 */
  private shipParts: { mesh: THREE.InstancedMesh; tint: boolean }[] = [];
  private ships: Ship[] = [];
  /** 최강 기사단 사열 병사: 몸과 칼 든 팔을 부품마다 인스턴스 메시로 */
  private soldierParts: { mesh: THREE.InstancedMesh; tint: boolean }[] = [];
  private soldierArmParts: { mesh: THREE.InstancedMesh; tint: boolean }[] = [];
  private parade: Parade | null = null;
  private traderParts: { mesh: THREE.InstancedMesh; tint: boolean }[] = [];
  private traderShadow: THREE.InstancedMesh | null = null;
  private traders: Trader[] = [];
  /** 사람마다 꼭짓점에 닿은 자기 길 (교역인이 갈림길에서 다음 길을 고른다) */
  private roadNet = new Map<string, Map<string, string[]>>();
  private buildingAtV = new Map<string, BoardBuildingView>();
  private edgeEndsCache = new Map<string, { a: THREE.Vector3; b: THREE.Vector3; len: number; angle: number }>();
  private lastTraderTime = 0;
  /** 소품 하나하나의 인스턴스 자리 (흔들기·톡 튀기기에 쓴다) */
  private instances: PropInstance[] = [];
  private instancesByTile = new Map<string, PropInstance[]>();
  private sheep: PropInstance[] = [];
  /** 양마다 걸음 시계(초). 눌려 튀는 동안은 멈췄다가 이어 가서 튄 자리에서 다시 걷는다. */
  private sheepClock: number[] = [];
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
  /** 고른 자리 위에 붙은 ✓ / ✕ 같은 HTML 칸 (React 가 안을 채운다) */
  private pins: OverlayItem[] = [];
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
  /** 기사단 동상과 잠금(사슬·자물쇠, 칸을 무채색으로 칠하는 paintLock) */
  private statue: THREE.Group | null = null;
  /** 눌러서 동상이 뛰는 중 */
  private statueHopping = false;
  private statueShadow: THREE.Mesh | null = null;
  private statueTile: string | null = null;
  private lockRoot: THREE.Group | null = null;
  private lockChain: THREE.Group | null = null;
  private padlock: THREE.Group | null = null;
  /** 잠금 연출 차례 번호. 동상을 빨리 거듭 옮겨도 지난 연출이 새 잠금을 덮어쓰지 않게 한다. */
  private lockGen = 0;
  /** 생산·막힘 때 칸 테두리를 빛내는 고리 */
  private flashRing: THREE.InstancedMesh | null = null;
  /** 빛나는 칸 자리 (paintGlow 슬롯마다 칸 ID) */
  private glowSlots: (string | null)[] = Array.from({ length: GLOW_SLOTS }, () => null);
  private glowTokens: number[] = Array.from({ length: GLOW_SLOTS }, () => 0);
  private glowSeq = 0;
  private overlayScale = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: BoardOptions,
  ) {
    this.metrics = boardMetrics(options.tiles);
    this.geo = boardGeometry(options.tiles);
    this.tileById = new Map(options.tiles.map((t) => [t.id, t]));
    // 잠긴 칸 무채색은 모든 재질이 함께 보는 값이라, 새 보드를 열 때 지난 보드의 잠금을 지운다.
    paintLock.apothem.value = LOCK_APOTHEM;
    paintLock.amount.value = 0;
    paintLock.reach.value = 0;
    // 빛나는 칸도 같다.
    paintGlow.apothem.value = HEX_APOTHEM;
    for (const v of paintGlow.tiles.value) v.set(0, 0, 0);
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
    // 그림자 맵은 보드가 바뀔 때만 다시 그린다 (지형·소품·조각은 멈춰 있고, 움직이는 양·교역인은 그림자를 드리우지 않는다).
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.shadowsWanted = options.shadows ?? true;
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
    // 그림자 카메라는 보드 받침 전체를 덮는다. 그늘에도 햇빛이 조금 남게 해 그림자가 먹처럼 까맣지 않고 서늘한 물감빛이 된다.
    const reach = this.metrics.plinthRadius + 1.2;
    const cam = sun.shadow.camera;
    cam.left = -reach;
    cam.right = reach;
    cam.top = reach;
    cam.bottom = -reach;
    cam.near = 20;
    cam.far = 40;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 2.2;
    sun.shadow.intensity = SHADOW_INTENSITY;
    this.sun = sun;
    this.scene.add(hemi, sun, sun.target);
    this.applyShadows();

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
      ...RESOURCES.map((r) => ({ key: 'goods' as PropKey, variant: GOODS_VARIANT[r] })),
      { key: 'trader' as PropKey, variant: 0 },
      { key: 'ship' as PropKey, variant: 0 },
      { key: 'soldier' as PropKey, variant: 0 },
      { key: 'soldierarm' as PropKey, variant: 0 },
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
    this.buildAwardFx();
    this.buildGoods();
    this.buildTraders();
    this.buildShips();
    this.buildSoldiers();
    this.buildSmoke();
    this.buildTileLabels();
    this.buildStatue();
    this.tagShadows();
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
    const moved = !!(dx || dz);
    if (inst.shadow >= 0 && this.propShadows && (moved || inst.shadowMoved)) {
      const r = p.shadow * p.scale * 2;
      this.propShadows.setMatrixAt(
        inst.shadow,
        compose(p.x + dx + SHADOW_SHIFT.x * p.scale, p.y + 0.004, p.z + dz + SHADOW_SHIFT.y * p.scale, p.rotY + drot, r * (p.shadowAspect ?? 1), 1, r),
      );
      this.propShadows.instanceMatrix.needsUpdate = true;
      inst.shadowMoved = moved;
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
    // 길 위 교역인 (탭을 오래 비웠다 돌아와도 한 번에 멀리 가지 않게 한 프레임을 0.1초로 묶는다)
    const dt = Math.min(0.1, Math.max(0, (now - this.lastTraderTime) / 1000));
    this.lastTraderTime = now;
    if (this.motion && this.traders.length) this.updateTraders(dt);
    if (this.motion && this.hintDots && (this.hintDots.count || this.hintRings?.count)) {
      const pulse = 0.5 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.6));
      (this.hintDots.material as THREE.MeshBasicMaterial).opacity = pulse;
      if (this.hintRings) (this.hintRings.material as THREE.MeshBasicMaterial).opacity = pulse;
    }
    // 양: 자기 자리 둘레의 둥근 길을 따라 목초지를 거닌다. 걷다가 멈춰 고개를 숙여 풀을 뜯고 다시 걷는다.
    // 걷는 방향으로 몸을 돌리고, 양마다 길 모양과 박자가 다르다.
    // 양마다 따로 도는 걸음 시계를 쓴다. 칸이 눌려 튀는 동안은 시계를 멈춰 그 자리에서 튀고, 끝나면 그 자리에서 이어 걷는다.
    for (let i = 0; i < this.sheep.length; i++) {
      const s = this.sheep[i];
      if (!this.motion) continue;
      if (this.bouncing.has(s.p.tile ?? '')) continue;
      const st = (this.sheepClock[i] = (this.sheepClock[i] ?? 0) + dt);
      const seed = i * 1.618 + s.p.x * 2.3;
      const r = this.sheepRoam[i] ?? 0.05;
      // 걷기·멈춤: 늘였다 줄인 시간(빠르기 0~2배, 평균 1배)
      const w = 0.45 + (i % 3) * 0.08;
      const tau = st + Math.sin(st * w + seed) / w;
      const speed = 1 + Math.cos(st * w + seed);
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
      const step = 0.004 * Math.abs(Math.sin(st * 7 + seed)) * moving;
      s.pose = { dx, dy: graze + step, dz, rot: turn };
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
    // 거니는 양은 제자리가 아니라 지금 선 자리와 보는 방향(pose)에서 튄다.
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
        const o = inst.pose;
        const hop = 0.05 * Math.sin(u * Math.PI) * (1 - u) * (heavy ? 0.4 : 1);
        this.setInstance(inst, o?.dx ?? 0, (o?.dy ?? 0) + hop, o?.dz ?? 0, (o?.rot ?? 0) + wobble, 1 - 0.07 * k, 1 + 0.18 * k, 1 - 0.07 * k);
      }
      if (done) {
        for (const inst of list) {
          const o = inst.pose;
          this.setInstance(inst, o?.dx, o?.dy, o?.dz, o?.rot);
        }
        this.bouncing.delete(tile);
      }
    }
    return this.bouncing.size > 0;
  }

  /** 움직임 켜기·끄기. 끄면 양을 제자리로 돌리고 연기를 지운다. 길 위 교역인은 그 자리에 멈춰 선다. */
  setMotion(on: boolean): void {
    if (this.motion === on) return;
    this.motion = on;
    if (!on) {
      for (const s of this.sheep) {
        s.pose = undefined;
        this.setInstance(s);
      }
      paintTime.value = 0;
      if (this.smokeMesh) this.smokeMesh.count = 0;
      this.placeTraders();
    }
    this.requestRender();
  }

  // ───────────────────────── 길 위 교역인 ─────────────────────────

  /** 변 양 끝 좌표·길이·방향 (교역인이 매 프레임 쓰므로 한 번만 계산해 둔다) */
  private edgeEnds(id: string) {
    let c = this.edgeEndsCache.get(id);
    if (!c) {
      const ew = this.edgeWorld(id);
      if (!ew) return null;
      c = { a: ew.a, b: ew.b, len: ew.length, angle: ew.angle };
      this.edgeEndsCache.set(id, c);
    }
    return c;
  }

  /**
   * 길이 바뀌면 교역인을 다시 배치한다. 사람마다 길 두세 개에 한 명(최대 다섯 명, 보드 전체 열여덟 명)이다.
   * 아직 자기 길 위에 있는 교역인은 그대로 두고 모자라면 그 사람의 길에 고르게 흩어 새로 세운다.
   */
  private planTraders(): void {
    if (!this.traderParts.length) return;
    const byOwner = new Map<string, BoardRoadView[]>();
    for (const r of this.state.roads) {
      if (!this.geo.edgeMap[r.edgeId]) continue;
      byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r]);
    }
    this.roadNet.clear();
    for (const [owner, list] of byOwner) {
      const at = new Map<string, string[]>();
      for (const r of list) {
        const e = this.geo.edgeMap[r.edgeId];
        for (const v of [e.a, e.b]) at.set(v, [...(at.get(v) ?? []), r.edgeId]);
      }
      this.roadNet.set(owner, at);
    }
    this.buildingAtV = new Map(this.state.buildings.map((b) => [b.vertexId, b]));
    const next: Trader[] = [];
    for (const owner of [...byOwner.keys()].sort()) {
      const list = byOwner.get(owner)!.slice().sort((a, b) => (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0));
      const want = Math.min(TRADER_MAX_EACH, Math.max(1, Math.round(list.length / TRADER_ROADS_EACH)));
      const mineEdges = new Set(list.map((r) => r.edgeId));
      const keep = this.traders.filter((tr) => tr.owner === owner && mineEdges.has(tr.edge)).slice(0, want);
      for (const tr of keep) tr.colorIndex = list[0].colorIndex;
      const used = new Set(keep.map((tr) => tr.edge));
      while (keep.length < want) {
        const j = keep.length;
        const base = Math.floor(((j + 0.5) * list.length) / want);
        let road = list[base % list.length];
        for (let s = 0; s < list.length; s++) {
          const c = list[(base + s) % list.length];
          if (!used.has(c.edgeId)) {
            road = c;
            break;
          }
        }
        used.add(road.edgeId);
        const seed = hashString(`${owner}:${road.edgeId}:${j}`);
        const rand = mulberry32(seed);
        const ends = this.edgeEnds(road.edgeId);
        const dir: 1 | -1 = rand() < 0.5 ? 1 : -1;
        keep.push({
          owner,
          colorIndex: road.colorIndex,
          edge: road.edgeId,
          dir,
          t: 0.35 + rand() * 0.3,
          wait: rand() * 1.2,
          yaw: (ends?.angle ?? 0) + (dir < 0 ? Math.PI : 0),
          lat: dir * TRADER_KEEP_RIGHT,
          stride: rand() * 6,
          seed,
          turns: 0,
          scale: 0.92 + rand() * 0.14,
        });
      }
      next.push(...keep);
    }
    this.traders = next.slice(0, TRADER_MAX);
    const color = new THREE.Color();
    for (const part of this.traderParts) {
      if (!part.tint) continue;
      this.traders.forEach((tr, i) => part.mesh.setColorAt(i, color.set(this.playerColor(tr.colorIndex))));
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
    this.placeTraders();
  }

  /**
   * 교역인이 걷는 변 끝(꼭짓점 v)에서 할 일과 멈출 자리 (꼭짓점에서 떨어진 몫, 변 길이 대비).
   * 내 마을·도시 앞에서는 잠깐 머물렀다 돌아선다. 내 길이 이어지면 지나가고 길 끝이나 남의 마을·도시 앞에서는 돌아선다.
   */
  private traderEnd(tr: Trader, v: string, len: number): { stop: number; kind: 'pass' | 'house' | 'turn' } {
    const b = this.buildingAtV.get(v);
    if (b) {
      const wall = b.kind === 'city' ? TRADER_CITY_STOP / len : 0;
      return b.owner === tr.owner ? { stop: Math.max(TRADER_HOUSE_STOP / len, wall), kind: 'house' } : { stop: Math.max(ROAD_GAP + 0.04, wall), kind: 'turn' };
    }
    const roads = this.roadNet.get(tr.owner)?.get(v)?.length ?? 0;
    return roads >= 2 ? { stop: 0, kind: 'pass' } : { stop: ROAD_GAP + 0.05, kind: 'turn' };
  }

  /** 교역인 한 걸음: 이어진 길을 따라 걷다 갈림길에서는 다음 길을 번갈아 고르고 마을·도시와 길 끝에서는 돌아선다. */
  private updateTraders(dt: number): void {
    for (const tr of this.traders) {
      if (tr.wait > 0) {
        tr.wait -= dt;
        continue;
      }
      const e = this.geo.edgeMap[tr.edge];
      const ends = this.edgeEnds(tr.edge);
      if (!e || !ends) continue;
      tr.t += (tr.dir * TRADER_SPEED * dt) / ends.len;
      tr.stride += dt * 10;
      const v = tr.dir > 0 ? e.b : e.a;
      const end = this.traderEnd(tr, v, ends.len);
      const limit = tr.dir > 0 ? 1 - end.stop : end.stop;
      if (tr.dir > 0 ? tr.t < limit : tr.t > limit) continue;
      tr.t = limit;
      const options = end.kind === 'pass' ? (this.roadNet.get(tr.owner)?.get(v) ?? []).filter((id) => id !== tr.edge) : [];
      if (options.length) {
        const nextId = options[(tr.seed + tr.turns++) % options.length];
        const ne = this.geo.edgeMap[nextId];
        tr.edge = nextId;
        tr.dir = ne.a === v ? 1 : -1;
        tr.t = ne.a === v ? 0 : 1;
        continue;
      }
      tr.dir = tr.dir > 0 ? -1 : 1;
      tr.wait = end.kind === 'house' ? 0.9 + ((tr.seed + tr.turns++) % 5) * 0.3 : 0.35;
    }
    this.placeTraders(dt);
  }

  /** 교역인을 자리에 그린다. 걷는 동안은 통통 튀며 좌우로 뒤뚱이고 걷는 쪽으로 천천히 돌아선다. dt 가 0 이면 자리만 다시 잡는다. */
  private placeTraders(dt = 0): void {
    const shadow = this.traderShadow;
    if (!shadow) return;
    let i = 0;
    for (const tr of this.traders) {
      const ends = this.edgeEnds(tr.edge);
      if (!ends || i >= TRADER_MAX) continue;
      const heading = ends.angle + (tr.dir < 0 ? Math.PI : 0);
      const walking = tr.wait <= 0;
      if (dt > 0) {
        const turn = Math.atan2(Math.sin(heading - tr.yaw), Math.cos(heading - tr.yaw));
        tr.yaw += turn * Math.min(1, dt * (walking ? 7 : 4));
        tr.lat += (tr.dir * TRADER_KEEP_RIGHT - tr.lat) * Math.min(1, dt * 4);
      }
      const dx = ends.b.x - ends.a.x;
      const dz = ends.b.z - ends.a.z;
      const x = ends.a.x + dx * tr.t + (-dz / ends.len) * tr.lat;
      const z = ends.a.z + dz * tr.t + (dx / ends.len) * tr.lat;
      const step = walking && this.motion ? 1 : 0;
      const bob = step * Math.abs(Math.sin(tr.stride)) * 0.012;
      const roll = step * Math.sin(tr.stride) * 0.12;
      const s = TRADER_SCALE * tr.scale;
      tmpQ.setFromAxisAngle(yAxis, tr.yaw).multiply(tmpQ2.setFromAxisAngle(xAxis, roll));
      tmpM.compose(tmpV.set(x, TRADER_FOOT + bob, z), tmpQ, tmpS.set(s, s, s));
      for (const part of this.traderParts) part.mesh.setMatrixAt(i, tmpM);
      shadow.setMatrixAt(i, compose(x + SHADOW_SHIFT.x * 0.25, TRADER_FOOT + 0.006, z + SHADOW_SHIFT.y * 0.25, tr.yaw, 0.15 * s, 1, 0.11 * s));
      i++;
    }
    for (const part of this.traderParts) {
      part.mesh.count = i;
      part.mesh.instanceMatrix.needsUpdate = true;
    }
    shadow.count = i;
    shadow.instanceMatrix.needsUpdate = true;
  }

  /** 눌린 자리에 짧은 반응: 타일이면 소품이 톡 튀고(동상이 선 칸이면 동상도 살짝 뛴다), 마을·도시·길이면 그 조각이 한 번 부풀었다 돌아온다. */
  private pokeAt(sel: BoardSelection): void {
    if (!this.ready) return;
    if (sel.kind === 'tile') {
      this.bouncing.set(sel.id, performance.now());
      if (sel.id === this.statueTile) this.hopStatue();
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

  private own<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(x: T): T {
    if (x instanceof THREE.BufferGeometry) this.owned.geometries.push(x);
    else if (x instanceof THREE.Texture) this.owned.textures.push(x);
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

    // 땅: 바깥 타일 둘레(바닷가 변)를 따라 조금 넓힌 흙 땅. 타일 사이 틈은 흙 땅 위로 샛길이 나고, 둘레는 모래밭과 얕은 물로 이어진다.
    // 바닷가 고리: 첫 고리가 바깥 둘레이고, 대형 맵처럼 가운데가 바다인 판은 그 바다 둘레 고리가 더 있다.
    const coasts = this.coastLoops();
    const toV2 = (pts: Pt[]) => pts.map((q) => new THREE.Vector2(q.x, -q.z));
    // 바다: 흙 땅 → 물 밑으로 비스듬히 잠기는 모래밭 → 옥빛 얕은 물 → 차츰 짙어지는 깊은 물.
    // 높이가 뚝 끊기는 곳이 없어야 후처리 먹선이 바닷가에 울퉁불퉁한 테두리를 긋지 않는다.
    for (const c of coasts) this.buildBeachSlope(c);
    this.buildSea(coasts);
    const landShape = new THREE.Shape(toV2(offsetLoop(coasts[0], LAND_MARGIN)));
    // 가운데 바다는 흙 땅에 뚫린 구멍이다 (안쪽 고리도 바다 쪽으로 같은 폭만큼 넓힌다).
    for (const hole of coasts.slice(1)) landShape.holes.push(new THREE.Path(toV2(offsetLoop(hole, LAND_MARGIN))));
    const landGeo = this.own(new THREE.ExtrudeGeometry(landShape, { depth: PLATFORM_TOP, bevelEnabled: false }).rotateX(-Math.PI / 2));
    scaleUV(landGeo, 0.5);
    // 윗면에는 빈 변마다 희끄무레한 샛길을 함께 칠한다 (따로 그리는 띠가 없어 그리기 호출이 늘지 않는다).
    const dirtTop = this.withFootpaths(this.groundMaterial('ground_dirt', GROUND_FALLBACK.dirt));
    const dirtSide = this.own(paintMaterial({ color: '#9a7752', map: this.art?.ground('ground_dirt') ?? null }));
    const landMesh = new THREE.Mesh(landGeo, [dirtTop, dirtSide]);
    landMesh.userData.ground = true;
    this.scene.add(landMesh);

    // 육각 타일 판 (종류별로 하나의 InstancedMesh). 옆면은 지형마다 흙·풀 둑 색이라 샛길보다 한 뼘 높은 둑처럼 보인다.
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
    const edgeMat = this.own(greyWhenLocked(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false })));
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
   * 모래밭: 흙 땅 가장자리 밑(BEACH_TOP 높이)에서 바다 쪽으로 비스듬히 내려가 물 밑(BEACH_LOW)으로 잠기는 띠.
   * 물과 만나는 줄(물가)에는 높이 차가 없어 모래가 그대로 물속으로 이어져 보인다.
   */
  private buildBeachSlope(coast: CoastLoop): void {
    const inner = chaikin(offsetLoop(coast, BEACH_IN), 3);
    const outer = chaikin(offsetLoop(coast, BEACH_OUT), 3);
    const n = inner.length;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = inner[i];
      const b = outer[i];
      pos.push(a.x, BEACH_TOP, a.z, b.x, BEACH_LOW, b.z);
      // 모래 텍스처는 바닥 좌표로 붙여 띠를 따라 늘어나지 않게 한다.
      uv.push(a.x * 0.5, a.z * 0.5, b.x * 0.5, b.z * 0.5);
      const j = (i + 1) % n;
      idx.push(i * 2, j * 2, i * 2 + 1, i * 2 + 1, j * 2, j * 2 + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // 감김 방향과 상관없이 위에서 보이게 양면으로 칠한다.
    const mat = this.groundMaterial('ground_sand', GROUND_FALLBACK.sand);
    mat.side = THREE.DoubleSide;
    const beach = new THREE.Mesh(this.own(geo), mat);
    beach.userData.ground = true;
    this.scene.add(beach);
  }

  /**
   * 바다 한 장: 보드 밖 화면 끝까지 덮는 평면에 물빛을 칠한 캔버스를 입힌다.
   * 물가에서 바깥으로 갈수록 젖은 모래빛 → 옥빛 → 얕은 물 → 장면 배경과 같은 깊은 물로 부드럽게 짙어진다.
   * 빛을 받지 않는 재질이라 가장 바깥 색이 배경색과 똑같아 경계가 보이지 않는다.
   */
  private buildSea(coasts: CoastLoop[]): void {
    const shores = coasts.map((c) => chaikin(offsetLoop(c, WATERLINE), 3));
    const shore = shores[0];
    const pad = SEA_REACH + 0.6;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of shore) {
      minX = Math.min(minX, p.x - pad);
      maxX = Math.max(maxX, p.x + pad);
      minZ = Math.min(minZ, p.z - pad);
      maxZ = Math.max(maxZ, p.z + pad);
    }
    const w = maxX - minX;
    const h = maxZ - minZ;
    const ppu = Math.min(64, 1400 / Math.max(w, h));
    const cw = Math.round(w * ppu);
    const ch = Math.round(h * ppu);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // 바닷가 고리를 한 경로에 모두 담는다. 채울 때는 짝홀 규칙이라 가운데 바다(안쪽 고리 안)는 물로 남는다.
    const path = new Path2D();
    for (const s of shores) {
      s.forEach((p, i) => (i ? path.lineTo((p.x - minX) * ppu, (p.z - minZ) * ppu) : path.moveTo((p.x - minX) * ppu, (p.z - minZ) * ppu)));
      path.closePath();
    }
    ctx.fillStyle = WATER_COLOR;
    ctx.fillRect(0, 0, cw, ch);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // 바깥에서 안쪽으로, 좁아지는 띠를 차례로 덧칠하면 물가에서 떨어진 거리만큼 색이 바뀐다 (둥근 모서리로 오목한 곳도 고르게).
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const d = SEA_REACH * (1 - i / steps);
      ctx.fillStyle = ctx.strokeStyle = seaColor(d);
      ctx.lineWidth = Math.max(0.5, d * 2 * ppu);
      ctx.stroke(path);
      ctx.fill(path, 'evenodd');
    }
    // 물가의 흰 물거품과 조금 떨어진 잔물결
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 0.07 * ppu;
    ctx.stroke(path);
    ctx.lineWidth = 0.045 * ppu;
    ctx.setLineDash([0.55 * ppu, 0.35 * ppu]);
    [0.3, 0.62].forEach((d, k) => {
      const p2 = new Path2D();
      for (const c of coasts) {
        const ring = chaikin(offsetLoop(c, WATERLINE + d), 3);
        ring.forEach((p, i) => (i ? p2.lineTo((p.x - minX) * ppu, (p.z - minZ) * ppu) : p2.moveTo((p.x - minX) * ppu, (p.z - minZ) * ppu)));
        p2.closePath();
      }
      ctx.lineDashOffset = k * 0.4 * ppu;
      ctx.strokeStyle = `rgba(255, 255, 255, ${k ? 0.14 : 0.24})`;
      ctx.stroke(p2);
    });
    ctx.setLineDash([]);
    const tex = this.own(new THREE.CanvasTexture(canvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    // 평면은 화면 끝 너머까지 넓게 깔고, 캔버스는 물가 둘레만 덮는다 (바깥은 가장자리 색 = 깊은 물이 늘어난다).
    const size = 140;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    tex.repeat.set(size / w, size / h);
    tex.offset.set((cx - minX) / w - (0.5 * size) / w, 1 - (cz - minZ) / h - (0.5 * size) / h);
    const mat = this.own(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const sea = new THREE.Mesh(this.own(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2)), mat);
    sea.position.set(cx, 0, cz);
    sea.renderOrder = -1;
    this.scene.add(sea);
  }

  /**
   * 빈 변의 샛길 중심선: 변 양 끝(꼭짓점)에서는 꼭짓점에 딱 붙고, 가운데로 갈수록 옆으로 조금 휘었다 돌아온다.
   * 변마다 휘는 방향·박자가 달라 정리되지 않은 오솔길처럼 보인다.
   */
  private footpathLine(e: { id: string; a: string; b: string }): Pt[] {
    const a = this.vertexWorld(e.a)!;
    const b = this.vertexWorld(e.b)!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const nx = -(b.z - a.z) / len;
    const nz = (b.x - a.x) / len;
    const rand = mulberry32(hashString(e.id) + 41);
    const big = PATH_WANDER * (0.7 + 0.3 * rand());
    const small = PATH_WANDER * (0.18 + 0.12 * rand());
    const f1 = 1 + rand();
    const f2 = 2.3 + 1.2 * rand();
    const p1 = rand() * Math.PI * 2;
    const p2 = rand() * Math.PI * 2;
    const n = 20;
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const env = Math.sin(Math.PI * t);
      const off = env * (big * Math.sin(Math.PI * f1 * t + p1) + small * Math.sin(Math.PI * 2 * f2 * t + p2));
      pts.push({ x: a.x + (b.x - a.x) * t + nx * off, z: a.z + (b.z - a.z) * t + nz * off });
    }
    return pts;
  }

  /**
   * 샛길 거리장: 바닥 좌표마다 가장 가까운 샛길 중심선까지의 거리를 담은 한 채널 텍스처.
   * 갈래끼리는 부드러운 최솟값으로 합쳐 갈림길이 조금 넓게 다져진 빈터처럼 이어진다. 보드를 만들 때 한 번만 계산한다.
   */
  private footpathField(): { texture: THREE.DataTexture; box: THREE.Vector4 } {
    const lines = this.geo.edges.map((e) => this.footpathLine(e));
    const reach = PATH_FIELD_REACH;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const line of lines)
      for (const p of line) {
        minX = Math.min(minX, p.x - reach);
        maxX = Math.max(maxX, p.x + reach);
        minZ = Math.min(minZ, p.z - reach);
        maxZ = Math.max(maxZ, p.z + reach);
      }
    const ppu = PATH_FIELD_PPU;
    const w = Math.ceil((maxX - minX) * ppu);
    const h = Math.ceil((maxZ - minZ) * ppu);
    // 갈래마다 exp(-d/k) 를 더해 두었다가 -k·ln 으로 되돌리면 부드러운 최솟값이 된다.
    const acc = new Float32Array(w * h);
    const k = PATH_JOIN;
    for (const line of lines) {
      let lx0 = Infinity;
      let lx1 = -Infinity;
      let lz0 = Infinity;
      let lz1 = -Infinity;
      for (const p of line) {
        lx0 = Math.min(lx0, p.x);
        lx1 = Math.max(lx1, p.x);
        lz0 = Math.min(lz0, p.z);
        lz1 = Math.max(lz1, p.z);
      }
      const i0 = Math.max(0, Math.floor((lx0 - reach - minX) * ppu));
      const i1 = Math.min(w - 1, Math.ceil((lx1 + reach - minX) * ppu));
      const j0 = Math.max(0, Math.floor((lz0 - reach - minZ) * ppu));
      const j1 = Math.min(h - 1, Math.ceil((lz1 + reach - minZ) * ppu));
      // 변(곧은 선) 기준 좌표로 먼저 걸러 내고, 중심선은 변을 따라 고르게 나뉘어 있으니 가까운 마디 몇 개만 본다.
      const a = line[0];
      const ax = line[line.length - 1].x - a.x;
      const az = line[line.length - 1].z - a.z;
      const len = Math.hypot(ax, az);
      const segs = line.length - 1;
      const band = reach + PATH_WANDER * 1.5;
      for (let j = j0; j <= j1; j++) {
        const z = minZ + (j + 0.5) / ppu;
        for (let i = i0; i <= i1; i++) {
          const x = minX + (i + 0.5) / ppu;
          const along = ((x - a.x) * ax + (z - a.z) * az) / len;
          const across = Math.abs((x - a.x) * az - (z - a.z) * ax) / len;
          if (across > band || along < -reach || along > len + reach) continue;
          const c = Math.max(0, Math.min(segs - 1, Math.floor((along / len) * segs)));
          let best = Infinity;
          for (let s = Math.max(0, c - 3); s <= Math.min(segs - 1, c + 3); s++) {
            const p = line[s];
            const q = line[s + 1];
            const dx = q.x - p.x;
            const dz = q.z - p.z;
            const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / (dx * dx + dz * dz)));
            const ex = p.x + dx * t - x;
            const ez = p.z + dz * t - z;
            best = Math.min(best, ex * ex + ez * ez);
          }
          const d = Math.sqrt(best);
          if (d < reach) acc[j * w + i] += Math.exp(-d / k);
        }
      }
    }
    const data = new Uint8Array(w * h);
    for (let i = 0; i < acc.length; i++) {
      const d = acc[i] > 0 ? -k * Math.log(acc[i]) : reach;
      data[i] = Math.round(Math.max(0, Math.min(1, d / reach)) * 255);
    }
    const tex = this.own(new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType));
    tex.unpackAlignment = 1;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return { texture: tex, box: new THREE.Vector4(minX, minZ, ppu / w, ppu / h) };
  }

  /**
   * 흙 땅 윗면 재질에 샛길을 더 칠한다. 희끄무레한 길 바닥이 짙어진 길가 흙 위로 떠올라 빈 변이 어디인지 보이고,
   * 플레이어 색 판자 길은 그 위에 도드라진다. 길 판자가 놓이면 판자가 샛길을 덮는다.
   */
  private withFootpaths(m: THREE.MeshToonMaterial): THREE.MeshToonMaterial {
    const field = this.footpathField();
    const uniforms = {
      uPathField: { value: field.texture },
      uPathBox: { value: field.box },
      uPathReach: { value: PATH_FIELD_REACH },
      uPathHalf: { value: PATH_HALF },
      uPathLight: { value: new THREE.Color('#f1ead9') },
      uPathDark: { value: new THREE.Color('#cdc1a7') },
      uPathVerge: { value: new THREE.Color('#c2ad8c') },
    };
    const base = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      base.call(m, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>${FOOTPATH_UNIFORMS}`)
        .replace('#include <map_fragment>', `#include <map_fragment>${FOOTPATH_FRAGMENT}`);
    };
    const key = m.customProgramCacheKey();
    m.customProgramCacheKey = () => `${key}-footpath`;
    return m;
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
      // 그림자는 검정 대신 서늘한 보라빛 물감으로 칠한다. 기사단 동상이 선 칸 안에서는 바닥과 함께 잿빛이 된다.
      greyWhenLocked(
        new THREE.MeshBasicMaterial({
          color: '#2c2747',
          alphaMap: this.art?.ground('contact_shadow') ?? null,
          transparent: true,
          opacity,
          depthWrite: false,
          toneMapped: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
        }),
      ),
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
        if (key === 'sheep') mesh.userData.moving = true;
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

  /**
   * 마을(집)·도시·길을 미리 만든 인스턴스 묶음에 담는다. 플레이어 색은 지붕·판자에 인스턴스 색으로 곱한다.
   * 묶음 크기는 보드의 자리 수로 잡는다 (길은 변 수, 마을·도시·이음목은 꼭짓점 수). 예전처럼 길 64개로 정해 두면
   * 대형 맵·8명·개수 제한 없음 판에서 그 뒤에 지은 길(대개 바깥 바닷가)이 그려지지 않는다.
   */
  private buildPiecePools(): void {
    const art = this.art!;
    const nv = this.geo.vertices.length;
    const ne = this.geo.edges.length;
    const pools: [BoardPieceKind, PropKey, number][] = [
      ['village', 'house', nv],
      ['city', 'city', nv],
      ['road', 'road', ne],
      ['joint', 'roadjoint', nv],
    ];
    for (const [kind, key, capacity] of pools) {
      // 플레이어 조각은 기사단 동상이 선 칸 가장자리에 있어도 제 색을 지킨다.
      const template = art.prop(key, 0, true);
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
    this.pieceShadow = new THREE.InstancedMesh(quad, this.shadowMaterial(0.55), nv);
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
    // 점은 희끄무레한 샛길 위에 찍히므로 고리보다 진한 적갈색으로 칠해 길 바닥에 묻히지 않게 한다.
    const hintDotMat = this.own(hintMat.clone());
    hintDotMat.color.set('#8f3f10');
    this.hintDots = new THREE.InstancedMesh(this.own(new THREE.CircleGeometry(0.042, 12).rotateX(-Math.PI / 2)), hintDotMat, ne * 3);
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

  /** 달성 연출: 조각 아래 바닥에 번지는 금빛(더하기 섞기)과 화면을 향한 반짝이 별. 둘 다 그리기 호출 한 번씩이다. */
  private buildAwardFx(): void {
    const glowMat = this.own(
      new THREE.MeshBasicMaterial({
        map: this.own(glowTexture()),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    // 빛나는 자리: 길(변)·이음목과 마을·도시(꼭짓점)·동상이 한꺼번에 빛나도 모자라지 않게
    const glowCapacity = this.geo.edges.length + 2 * this.geo.vertices.length + 4;
    this.glowMesh = new THREE.InstancedMesh(this.own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), glowMat, glowCapacity);
    const sparkleMat = this.own(
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
    );
    this.sparkleMesh = new THREE.InstancedMesh(this.own(sparkleGeometry()), sparkleMat, SPARKLE_MAX);
    for (const m of [this.glowMesh, this.sparkleMesh]) {
      for (let i = 0; i < m.count; i++) m.setColorAt(i, new THREE.Color('#000000'));
      m.count = 0;
      m.renderOrder = 6;
      m.frustumCulled = false;
      this.scene.add(m);
    }
  }

  /** 날아가는 생산물: 자원마다 작은 소품(통나무·볏단·양·벽돌·돌덩이)을 인스턴스 메시로 묶는다. 칸 위를 지나도 제 색을 지킨다. */
  private buildGoods(): void {
    for (const r of RESOURCES) {
      const meshes = this.art!.prop('goods', GOODS_VARIANT[r], true).parts.map((part) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, GOODS_CAPACITY);
        mesh.count = 0;
        mesh.visible = false;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        return mesh;
      });
      this.goods.set(r, meshes);
    }
  }

  /** 길 위 교역인: 부품마다 인스턴스 메시 하나, 겉옷(지붕 재질)에 플레이어 색을 곱한다. 발밑에 작은 그림자. */
  private buildTraders(): void {
    for (const part of this.art!.prop('trader', 0, true).parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, TRADER_MAX);
      mesh.count = 0;
      if (part.tint) for (let i = 0; i < TRADER_MAX; i++) mesh.setColorAt(i, new THREE.Color('#ffffff'));
      mesh.frustumCulled = false;
      this.traderParts.push({ mesh, tint: part.tint });
      this.scene.add(mesh);
    }
    this.traderShadow = new THREE.InstancedMesh(this.own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), this.shadowMaterial(0.42), TRADER_MAX);
    this.traderShadow.count = 0;
    this.traderShadow.frustumCulled = false;
    this.traderShadow.renderOrder = 1;
    this.scene.add(this.traderShadow);
  }

  /** 해상 교역 배: 부품마다 인스턴스 메시 하나, 돛(깃발 재질)에 플레이어 색을 곱한다. 연출할 때만 보인다. */
  private buildShips(): void {
    for (const part of this.art!.prop('ship', 0, true).parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, SHIP_MAX);
      mesh.count = 0;
      if (part.tint) for (let i = 0; i < SHIP_MAX; i++) mesh.setColorAt(i, new THREE.Color('#ffffff'));
      mesh.frustumCulled = false;
      this.shipParts.push({ mesh, tint: part.tint });
      this.scene.add(mesh);
    }
  }

  /**
   * 최강 기사단 사열 병사: 몸과 칼 든 팔을 부품마다 인스턴스 메시 하나로 만든다.
   * 겉옷·망토·방패·깃털(지붕 재질)에 플레이어 색을 곱한다. 대열 하나만 서므로 대열 인원만큼 담는다.
   */
  private buildSoldiers(): void {
    const t = paradeTiming(false);
    const capacity = t.ranks * t.files;
    const make = (key: PropKey) =>
      this.art!.prop(key, 0, true).parts.map((part) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
        mesh.count = 0;
        if (part.tint) for (let i = 0; i < capacity; i++) mesh.setColorAt(i, new THREE.Color('#ffffff'));
        mesh.frustumCulled = false;
        // 잠깐 나타났다 사라지는 연출이라 그림자 지도에 넣지 않는다.
        mesh.userData.moving = true;
        this.scene.add(mesh);
        return { mesh, tint: part.tint };
      });
    this.soldierParts = make('soldier');
    this.soldierArmParts = make('soldierarm');
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
    this.planTraders();

    // 마을·도시 위 소유자 표식 (HTML: 색 + 모양). 늘 떠 있으면 바로 위쪽 길을 가리므로
    // 평소에는 지붕 색으로만 구별하고 누른 마을·도시 위에만 표식을 띄운다.
    const sel = s.selected?.kind === 'vertex' ? s.selected.id : null;
    const picked = sel ? s.buildings.find((b) => b.vertexId === sel) : undefined;
    const pickedAt = picked ? this.vertexWorld(picked.vertexId) : null;
    for (const [id, item] of this.badges) {
      if (id !== picked?.vertexId || !pickedAt) {
        item.el.remove();
        this.badges.delete(id);
      }
    }
    let newBadge = false;
    if (picked && pickedAt) {
      let item = this.badges.get(picked.vertexId);
      if (!item) {
        const el = document.createElement('div');
        el.className = 'owner-badge';
        this.overlay.appendChild(el);
        item = { el, world: pickedAt.clone(), anchor: 'translate(-50%, -100%)' };
        this.badges.set(picked.vertexId, item);
        newBadge = true;
      }
      item.world.set(pickedAt.x, pickedAt.y + BADGE_LIFT[picked.kind], pickedAt.z);
      const key = `${picked.owner}:${picked.colorIndex}:${picked.kind}`;
      if (item.el.dataset.key !== key) {
        item.el.dataset.key = key;
        // 안쪽 조각이 톡 떠오른다 (바깥 상자의 transform 은 화면 위치에 쓴다).
        item.el.innerHTML = `<div class="owner-badge-chip">${this.options.ownerMarkup(picked.colorIndex)}</div>`;
        item.el.title = picked.label;
        item.el.classList.toggle('owner-badge-city', picked.kind === 'city');
      }
    }
    this.syncNumbers();
    this.syncHarbors();
    this.syncRobber();
    this.updateHighlights();
    // 새로 띄운 표식은 다음 그림을 기다리지 않고 바로 제자리에 놓는다 (화면 구석에 잠깐 비치지 않게).
    if (newBadge) this.updateOverlay();
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
    this.shadowDirty = true;
    const color = new THREE.Color();
    const gold = new THREE.Color(AWARD_GOLD);
    /** 플레이어 색. 달성 연출로 빛나는 조각은 금빛을 섞어 밝힌다. */
    const tint = (colorIndex: number, glowKey: string) => {
      color.set(this.playerColor(colorIndex));
      const g = this.glow.get(glowKey) ?? 0;
      if (g > 0) color.lerp(gold, Math.min(0.7, 0.55 * g)).multiplyScalar(1 + 0.8 * g);
      return color;
    };
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
    const gap = ROAD_GAP;
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
          if (part.tint) part.mesh.setColorAt(i, tint(r.colorIndex, `r:${r.edgeId}`));
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
            if (part.tint) part.mesh.setColorAt(i, tint(road.colorIndex, `v:${v}`));
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
          if (part.tint) part.mesh.setColorAt(i, tint(b.colorIndex, `b:${b.vertexId}`));
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
        // 그림자는 집 크기에 맞춰 커진다 (마을 0.96배, 도시는 탑까지 덮게 1.25배).
        const base = b.kind === 'city' ? CITY_SCALE * 1.25 : VILLAGE_SCALE * 0.96;
        const g = (this.growing.get(`b:${b.vertexId}`) ?? 1) * base;
        const shift = base * 1.1;
        this.pieceShadow.setMatrixAt(i, compose(p.x + SHADOW_SHIFT.x * shift, TILE_TOP + 0.006, p.z + SHADOW_SHIFT.y * shift, 0, 0.98 * g, 1, 0.8 * g));
        i++;
      }
      this.pieceShadow.count = i;
      this.pieceShadow.instanceMatrix.needsUpdate = true;
    }
    this.syncGlow();
  }

  /** 빛나는 조각 자리 바닥에 금빛을 번지게 한다: 길은 변을 따라 길쭉하게, 이음목은 작게, 마을·도시와 동상은 둥글게 크게. */
  private syncGlow(): void {
    const mesh = this.glowMesh;
    if (!mesh) return;
    const color = new THREE.Color();
    const gold = new THREE.Color(AWARD_GOLD);
    let i = 0;
    for (const [key, g] of this.glow) {
      if (g < 0.01 || i >= mesh.instanceMatrix.count) continue;
      const id = key.slice(2);
      if (key.startsWith('r:')) {
        const ew = this.edgeWorld(id);
        if (!ew) continue;
        mesh.setMatrixAt(i, compose(ew.mid.x, PLATFORM_TOP + ROAD_DECK_TOP + 0.02, ew.mid.z, ew.angle, ew.length * 1.1, 1, 0.66));
      } else if (key === 's') {
        const at = this.statue?.position;
        if (!at || !this.statue?.visible) continue;
        mesh.setMatrixAt(i, compose(at.x, TILE_TOP + 0.012, at.z, 0, 1.15, 1, 1.15));
      } else {
        const p = this.vertexWorld(id);
        if (!p) continue;
        // 커진 마을·도시를 둘러쌀 만큼 둥글게 번진다. 이음목(v:)은 길 폭만큼.
        const s = key.startsWith('b:') ? 1.45 : 0.62;
        mesh.setMatrixAt(i, compose(p.x, key.startsWith('b:') ? TILE_TOP + 0.012 : PLATFORM_TOP + ROAD_DECK_TOP + 0.02, p.z, 0, s, 1, s));
      }
      mesh.setColorAt(i, color.copy(gold).multiplyScalar(1.2 * g));
      i++;
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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
      const built = new Map(this.state.buildings.map((b) => [b.vertexId, b.kind]));
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
        // 마을·도시가 선 자리는 고리가 집 밑에 숨지 않게 집 둘레만큼 키운다.
        const around = built.get(v.id) === 'city' ? 2 : built.has(v.id) ? 1.6 : 1;
        const s = kind ? (selected ? 1.2 : 1) * around : 0;
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
      const roadEdges = new Set(this.state.roads.map((r) => r.edgeId));
      this.geo.edges.forEach((e, i) => {
        const ew = this.edgeWorld(e.id)!;
        const selected = same(sel, 'edge', e.id);
        const kind: keyof typeof HIGHLIGHT_COLOR | null = selected ? 'selected' : he.has(e.id) && hl ? hl.kind : same(hov, 'edge', e.id) ? 'hover' : null;
        const len = kind ? ew.length * 0.66 : 0;
        // 빈 변은 길 판자 높이에 띠를 그린다. 길이 놓인 변은 판자 아래에 더 넓게 깔아 판자 둘레로 빛 테두리가 비친다.
        const road = roadEdges.has(e.id);
        const wide = kind ? (selected ? 1.3 : 1) * (road ? 3.4 : 1.6) : 0;
        const y = road ? PLATFORM_TOP + 0.02 : PLATFORM_TOP + ROAD_DECK_TOP + 0.012;
        edgeMark.setMatrixAt(i, compose(ew.mid.x, y, ew.mid.z, ew.angle, road ? ew.length * 0.74 : len, 1, wide));
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
        const e = this.geo.edgeMap[id];
        if (!e) continue;
        // 점은 구불구불한 샛길 중심선을 따라 찍는다.
        const line = this.footpathLine(e);
        for (const t of [0.3, 0.5, 0.7]) {
          const p = line[Math.round(t * (line.length - 1))];
          this.hintDots.setMatrixAt(nd++, compose(p.x, PLATFORM_TOP + 0.09, p.z, 0, 1.3, 1, 1.3));
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
        this.traceMark.setMatrixAt(nt++, compose(ew.mid.x, PLATFORM_TOP + ROAD_DECK_TOP + 0.01, ew.mid.z, ew.angle, ew.length * 0.82, 1, 1.45));
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

  /**
   * 생산물 하나를 날린다. 날아가는 방향에 수직인 가로 축으로 앞으로 구르며 간다.
   * 통나무는 길이 방향을 가는 쪽으로 두고 앞뒤로 뒤집혀 나이테 단면이 번갈아 보인다. 양은 가는 쪽을 보고 앞으로 재주를 넘는다.
   */
  private launchGoods(resource: Resource, from: THREE.Vector3, to: THREE.Vector3, start: number, duration: number, arc: number): void {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    const axis = len > 0.01 ? new THREE.Vector3(dz / len, 0, -dx / len) : new THREE.Vector3(1, 0, 0).applyAxisAngle(yAxis, Math.random() * Math.PI * 2);
    let yaw = Math.random() * Math.PI * 2;
    // 소품의 +x 를 가는 방향(구르는 축에 수직)으로 돌린다.
    if (resource === 'wood' || resource === 'wool') yaw = Math.atan2(-axis.x, -axis.z);
    const turns = GOODS_TURNS[resource] * (len > 0.01 ? 1 : 0.6) * (0.9 + Math.random() * 0.2);
    this.tokens.push({ start, duration, from, to, arc, resource, axis, yaw, spin: turns * Math.PI * 2 });
  }

  /** 라운드 시작 공동 생산 연출: 마을·도시에서 생산물이 빙글 돌며 솟아오른다. */
  playProduction(items: { vertexId: string; resource: Resource; amount: number }[]): void {
    if (!this.ready) return;
    const now = performance.now();
    items.forEach((item, idx) => {
      const at = this.vertexWorld(item.vertexId);
      if (!at) return;
      for (let k = 0; k < item.amount; k++) {
        const from = at.clone().add(new THREE.Vector3((k - (item.amount - 1) / 2) * 0.24, 0.6, 0.08));
        this.launchGoods(item.resource, from, from.clone().add(new THREE.Vector3(0, 0.85, 0)), now + idx * 90 + k * 140, 1100, 0);
      }
      this.spawnFloating(at.clone().add(new THREE.Vector3(0, 1.1, 0)), `+${item.amount}`, `float-label float-${item.resource}`, idx * 90);
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
    if (!this.goods.size || (!this.tokens.length && !this.goodsShown)) return false;
    const counts = new Map<Resource, number>();
    const pos = new THREE.Vector3();
    this.tokens = this.tokens.filter((tk) => now < tk.start + tk.duration);
    for (const tk of this.tokens) {
      if (now < tk.start) continue;
      const meshes = this.goods.get(tk.resource);
      const n = counts.get(tk.resource) ?? 0;
      if (!meshes || n >= GOODS_CAPACITY) continue;
      const t = Math.min(1, (now - tk.start) / tk.duration);
      const e = easeInOut(t);
      pos.lerpVectors(tk.from, tk.to, e);
      pos.y += Math.sin(Math.PI * e) * tk.arc;
      // 톡 튀어나와 커졌다가 마을·도시에 닿으며 작아진다.
      const s = GOODS_SIZE[tk.resource] * (t < 0.16 ? Math.max(0.01, easeOutBack(t / 0.16)) : 1) * (t > 0.8 ? Math.max(0.01, (1 - t) / 0.2) : 1);
      tmpQ2.setFromAxisAngle(yAxis, tk.yaw);
      tmpQ.setFromAxisAngle(tk.axis, t * tk.spin).multiply(tmpQ2);
      tmpM.compose(pos, tmpQ, tmpS.setScalar(s));
      for (const m of meshes) m.setMatrixAt(n, tmpM);
      counts.set(tk.resource, n + 1);
    }
    let shown = false;
    for (const [r, meshes] of this.goods) {
      const n = counts.get(r) ?? 0;
      if (n) shown = true;
      for (const m of meshes) {
        m.count = n;
        m.visible = n > 0;
        m.instanceMatrix.needsUpdate = true;
      }
    }
    this.goodsShown = shown;
    return this.tokens.length > 0;
  }

  /** 반짝이 별 하나를 띄운다 (delay 뒤에 커졌다 돌며 조금 떠올라 사라진다). */
  private spawnSparkle(at: THREE.Vector3, delay = 0, size = 0.1): void {
    if (this.sparkles.length >= SPARKLE_MAX) return;
    this.sparkles.push({
      start: performance.now() + delay,
      duration: 540 + Math.random() * 260,
      pos: at.clone(),
      size: size * (0.75 + Math.random() * 0.5),
      spin: (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random() * 1.5),
      rise: 0.1 + Math.random() * 0.12,
    });
    this.requestRender();
  }

  /** 길 한 칸 위에 반짝이를 흩뿌린다 */
  private sparkEdge(edgeId: string, delay = 0, count = 3): void {
    const ew = this.edgeWorld(edgeId);
    if (!ew) return;
    for (let k = 0; k < count; k++) {
      const p = ew.a.clone().lerp(ew.b, 0.18 + Math.random() * 0.64);
      p.set(p.x + (Math.random() - 0.5) * 0.14, PLATFORM_TOP + ROAD_DECK_TOP + 0.05 + Math.random() * 0.12, p.z + (Math.random() - 0.5) * 0.14);
      this.spawnSparkle(p, delay + k * 70, 0.1);
    }
  }

  /** 반짝이 둘레로 터뜨리기 (마을·도시 지붕, 동상 머리 위) */
  private sparkBurst(at: THREE.Vector3, delay: number, count: number, radius: number, size = 0.1): void {
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + Math.random() * 0.6;
      const r = radius * (0.5 + Math.random() * 0.5);
      this.spawnSparkle(at.clone().add(new THREE.Vector3(Math.cos(a) * r, (Math.random() - 0.3) * radius, Math.sin(a) * r * 0.8)), delay + k * 55, size);
    }
  }

  private updateSparkles(now: number): boolean {
    const mesh = this.sparkleMesh;
    if (!mesh || (!this.sparkles.length && !mesh.count)) return false;
    this.sparkles = this.sparkles.filter((s) => now < s.start + s.duration);
    const color = new THREE.Color();
    let n = 0;
    for (const s of this.sparkles) {
      if (now < s.start || n >= SPARKLE_MAX) continue;
      const t = (now - s.start) / s.duration;
      const k = t < 0.22 ? easeOutBack(t / 0.22) : 1 - smoothstep(0.35, 1, t);
      tmpQ.setFromAxisAngle(VIEW_AXIS, s.spin * t);
      mesh.setMatrixAt(n, tmpM.compose(tmpV.set(s.pos.x, s.pos.y + s.rise * t, s.pos.z), tmpQ, tmpS.setScalar(Math.max(0.001, s.size * k))));
      mesh.setColorAt(n, color.setRGB(1, 0.92, 0.66).multiplyScalar(Math.min(1, 1.5 * (1 - t))));
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return this.sparkles.length > 0;
  }

  // ───────────────────────── 바닷가·교역로 ─────────────────────────

  /**
   * 바닷가 변(타일 하나에만 닿은 변)을 이어 만든 고리들. 변마다 바다 쪽 방향(그 타일 중심에서 멀어지는 쪽)을 함께 준다.
   * 첫 고리가 보드 바깥 둘레이고, 가운데가 바다인 판이면 그 바다 둘레 고리가 뒤에 온다.
   */
  private coastLoops(): CoastLoop[] {
    const coast = this.geo.edges.filter((e) => e.tiles.length === 1);
    const byVertex = new Map<string, typeof coast>();
    for (const e of coast) for (const v of [e.a, e.b]) byVertex.set(v, [...(byVertex.get(v) ?? []), e]);
    const used = new Set<string>();
    const loops: CoastLoop[] = [];
    for (const start of coast) {
      if (used.has(start.id)) continue;
      loops.push(this.traceCoast(start, byVertex, used));
    }
    // 가장 넓게 퍼진 고리(바깥 둘레)를 앞에 둔다.
    const reach = (l: CoastLoop) => Math.max(0, ...l.pts.map((p) => Math.hypot(p.x, p.z)));
    loops.sort((a, b) => reach(b) - reach(a));
    return loops.length ? loops : [{ pts: [], normals: [] }];
  }

  private traceCoast(start: EdgeDef, byVertex: Map<string, EdgeDef[]>, used: Set<string>): CoastLoop {
    const pts: Pt[] = [];
    const normals: Pt[] = [];
    let edge = start;
    let from = edge.a;
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
        item = { el, world: new THREE.Vector3(c.x + TOKEN_FACE.x, TILE_TOP + 0.02, c.z + TOKEN_FACE.z), anchor: 'translate(-50%, -50%) scale(var(--tz, 1))' };
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
    // 동상·사슬·자물쇠는 잠긴 칸 위에 서도 제 색을 지킨다.
    const group = (key: PropKey) => {
      const g = new THREE.Group();
      for (const part of art.prop(key, 0, true).parts) g.add(new THREE.Mesh(part.geometry, part.material));
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

    // 잠금: 칸 둘레 사슬 + 앞 오른쪽 변의 자물쇠. 칸의 바닥과 소품은 paintLock 으로 무채색이 된다.
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
    this.lockRoot.add(this.lockChain, this.padlock);
    this.scene.add(this.lockRoot);
  }

  /** 동상이 제자리에서 살짝 뛰었다가 쿵 내려앉는다 (눌렀을 때). 날아가는 중이거나 이미 뛰는 중이면 겹치지 않는다. */
  private hopStatue(): void {
    const statue = this.statue;
    if (!statue?.visible || this.statueHopping || !this.statueTile) return;
    this.statueHopping = true;
    const base = this.statueSpot(this.statueTile);
    this.addAnim({
      duration: 520,
      update: (t) => {
        // 웅크렸다가(0~0.18) 뛰어올라(0.18~0.8) 내려앉으며 눌린다(0.8~1).
        const up = t < 0.18 ? 0 : t < 0.8 ? Math.sin(((t - 0.18) / 0.62) * Math.PI) : 0;
        const squash = t < 0.18 ? Math.sin((t / 0.18) * Math.PI) * 0.6 : t > 0.8 ? Math.sin(((t - 0.8) / 0.2) * Math.PI) : 0;
        this.placeStatue(base, up * 0.32);
        statue.scale.set(STATUE_SCALE * (1 + 0.1 * squash), STATUE_SCALE * (1 - 0.14 * squash + 0.06 * up), STATUE_SCALE * (1 + 0.1 * squash));
        statue.rotation.y = Math.sin(up * Math.PI) * 0.18;
      },
      done: () => {
        this.statueHopping = false;
        // 그사이 다른 칸으로 옮겨 갔으면 그쪽 연출이 자리를 잡는다.
        if (this.statueTile && this.statueSpot(this.statueTile).equals(base)) this.placeStatue(base, 0);
        statue.scale.setScalar(STATUE_SCALE);
        statue.rotation.y = 0;
      },
    });
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

  /**
   * 칸에 잠금을 채우거나 푼다. 사슬과 자물쇠를 세우고 그 칸의 바닥과 소품(나무·양·밀·바위 등)을 무채색으로 칠한다.
   * 잠글 때는 칸 가운데부터 색이 빠져 가장자리로 번진다. 풀 때는 가장자리부터 색이 돌아온다.
   * 광장은 생산하지 않는 칸이라 잠그지 않는다.
   */
  private setLock(tile: string | null, animate: boolean): void {
    const root = this.lockRoot;
    const chain = this.lockChain;
    const padlock = this.padlock;
    if (!root || !chain || !padlock) return;
    const gen = ++this.lockGen;
    const live = () => gen === this.lockGen;
    const grey = paintLock;
    const t = tile ? this.tileById.get(tile) : null;
    if (!t || t.kind === 'plaza') {
      if (!root.visible) {
        grey.amount.value = 0;
        return;
      }
      if (!animate) {
        root.visible = false;
        grey.amount.value = 0;
        return;
      }
      const reach = grey.reach.value;
      this.addAnim({
        duration: 620,
        update: (k) => {
          if (!live()) return;
          const shrink = Math.max(0.001, 1 - Math.min(1, k / 0.45));
          chain.scale.set(CHAIN_RADIUS, CHAIN_RADIUS * shrink, CHAIN_RADIUS);
          padlock.scale.setScalar(PADLOCK_SCALE * shrink);
          grey.reach.value = reach * (1 - easeInOut(k));
        },
        done: () => {
          if (!live()) return;
          root.visible = false;
          grey.amount.value = 0;
        },
      });
      return;
    }
    const c = tileCenter(t, this.metrics);
    root.position.set(c.x, TILE_TOP, c.z);
    root.visible = true;
    padlock.rotation.z = 0;
    grey.center.value.set(c.x, c.z);
    grey.amount.value = 1;
    if (!animate) {
      chain.scale.setScalar(CHAIN_RADIUS);
      padlock.scale.setScalar(PADLOCK_SCALE);
      padlock.position.y = 0;
      padlock.visible = true;
      grey.reach.value = LOCK_REACH;
      return;
    }
    padlock.visible = false;
    grey.reach.value = 0;
    this.addAnim({
      duration: 900,
      update: (k) => {
        if (!live()) return;
        chain.scale.set(CHAIN_RADIUS, CHAIN_RADIUS * Math.max(0.001, easeOutBack(Math.min(1, k / 0.47))), CHAIN_RADIUS);
        grey.reach.value = LOCK_REACH * (1 - Math.pow(1 - k, 2.2));
      },
    });
    this.addAnim({
      delay: 240,
      duration: 620,
      update: (k) => {
        if (!live()) return;
        padlock.visible = true;
        padlock.scale.setScalar(PADLOCK_SCALE);
        const fall = Math.min(1, k / 0.45);
        padlock.position.y = 0.6 * (1 - fall * fall);
        padlock.rotation.z = k > 0.45 ? Math.sin((k - 0.45) * Math.PI * 7) * 0.3 * (1 - k) : 0;
      },
      done: () => {
        if (!live()) return;
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

  /**
   * 내 자원이 나온 칸만 바닥이 따뜻한 빛으로 환해졌다가 천천히 돌아온다 (약 1.6초).
   * 보드 전체가 아니라 그 칸만 밝아져 어디서 자원이 나왔는지 보인다.
   */
  glowTiles(tileIds: readonly string[], delay = 0): void {
    if (!this.ready) return;
    for (const id of new Set(tileIds)) {
      const tile = this.tileById.get(id);
      if (!tile) continue;
      // 같은 칸이 이미 빛나는 중이면 그 자리를, 아니면 빈 자리를 쓴다 (모자라면 건너뛴다).
      let slot = this.glowSlots.indexOf(id);
      if (slot < 0) slot = this.glowSlots.indexOf(null);
      if (slot < 0) continue;
      this.glowSlots[slot] = id;
      // 같은 칸이 다시 빛나면 나중 연출만 값을 바꾼다.
      const token = ++this.glowSeq;
      this.glowTokens[slot] = token;
      const c = tileCenter(tile, this.metrics);
      const v = paintGlow.tiles.value[slot];
      v.set(c.x, c.z, v.z);
      this.addAnim({
        delay,
        duration: 1600,
        update: (t) => {
          if (this.glowTokens[slot] !== token) return;
          // 빨리 차오르고 천천히 빠진다.
          v.z = t < 0.15 ? smoothstep(0, 0.15, t) : 1 - smoothstep(0.35, 1, t);
        },
        done: () => {
          if (this.glowTokens[slot] !== token) return;
          v.z = 0;
          this.glowSlots[slot] = null;
        },
      });
    }
    this.requestRender();
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
   * 그다음 그 칸에서 생산물(통나무·볏단·작은 양·벽돌·돌덩이)이 솟아 구르며 닿은 마을·도시로 날아간다.
   * 동상에 막힌 칸은 붉게 빛나고 자물쇠가 덜컹인다.
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
      const from = new THREE.Vector3(c.x + TOKEN_FACE.x, TILE_TOP + 0.3, c.z + TOKEN_FACE.z);
      for (let k = 0; k < it.amount; k++) {
        const target = to.clone().add(new THREE.Vector3((k - (it.amount - 1) / 2) * 0.2, 0.55, 0));
        this.launchGoods(it.resource, from.clone(), target, now + 420 + idx * 110 + k * 130, 950, 0.75);
      }
      this.spawnFloating(to.clone().add(new THREE.Vector3(0, 1.05, 0)), `+${it.amount}`, `float-label float-${it.resource}`, 1000 + idx * 110);
    });
    this.requestRender();
  }

  /**
   * 한 사람의 가장 긴 길을 이루는 변과 그 길이 지나는 꼭짓점 (둘 다 길 순서대로).
   * 게임 규칙의 longestRoadPath 를 이 판의 꼭짓점·변으로 돌린다 (맵 모양이 달라도, 실험실의 작은 판이어도 같다).
   */
  private longestPath(playerId: string): { edges: string[]; vertices: string[] } {
    const edges = longestRoadPath(
      this.geo,
      this.state.roads.map((r) => ({ edgeId: r.edgeId, owner: r.owner, builtTurn: 0 })),
      this.state.buildings.map((b) => ({ vertexId: b.vertexId, owner: b.owner, kind: b.kind, builtTurn: 0 })),
      playerId,
    ).filter((id) => this.geo.edgeMap[id]);
    if (!edges.length) return { edges, vertices: [] };
    const first = this.geo.edgeMap[edges[0]];
    const second = edges.length > 1 ? this.geo.edgeMap[edges[1]] : null;
    let cur = second && (first.a === second.a || first.a === second.b) ? first.b : first.a;
    const vertices = [cur];
    for (const id of edges) {
      const e = this.geo.edgeMap[id];
      cur = e.a === cur ? e.b : e.a;
      vertices.push(cur);
    }
    return { edges, vertices };
  }

  /**
   * 최장 교역로: 그 사람의 가장 긴 길을 따라 금빛이 한 칸씩 훑고 지나간다. 빛이 닿은 판자는 금빛으로 밝아지며 반짝이가 튄다.
   * 지나간 자리는 은은하게 남았다가 끝에서 길 전체가 한 번 더 반짝인 뒤 사그라든다. 길에 닿은 내 마을·도시 지붕도 함께 빛난다.
   */
  private sweepLongestRoad(playerId: string): void {
    const { edges, vertices } = this.longestPath(playerId);
    const n = edges.length;
    if (!n) return;
    const own = new Set(this.state.buildings.filter((b) => b.owner === playerId).map((b) => b.vertexId));
    const vKeys = vertices.map((v) => (own.has(v) ? `b:${v}` : `v:${v}`));
    const sweepMs = Math.min(2600, Math.max(900, n * 200));
    const holdMs = 520;
    const fadeMs = 700;
    const total = sweepMs + holdMs + fadeMs;
    // 빛의 머리가 앞 꼭짓점 조금 앞에서 출발해 마지막 꼭짓점 너머까지 간다 (단위: 길 칸 수).
    const from = -0.5;
    const to = n + 0.6;
    // 머리가 다가오면 빠르게 밝아지고 지나간 뒤에는 은은하게(0.4) 남는다.
    const level = (d: number) => (d < -0.7 ? 0 : d < 0 ? 1 + d / 0.7 : Math.max(0.4, Math.exp(-d * 1.3)));
    let sparked = 0;
    let finale = false;
    this.addAnim({
      duration: total,
      update: (t) => {
        const ms = t * total;
        const head = from + (to - from) * Math.min(1, ms / sweepMs);
        const after = ms - sweepMs;
        // 다 훑은 뒤 길 전체가 한 번 더 반짝였다가 사그라든다.
        const swell = after > 0 ? 0.35 * Math.sin(Math.min(1, after / holdMs) * Math.PI) : 0;
        const fade = after > holdMs ? 1 - (after - holdMs) / fadeMs : 1;
        edges.forEach((id, i) => this.glow.set(`r:${id}`, Math.max(0, Math.min(1, level(head - (i + 0.5)) + swell)) * fade));
        vertices.forEach((_, j) => this.glow.set(vKeys[j], Math.max(0, Math.min(1, level(head - j) + swell)) * fade * (vKeys[j].startsWith('b:') ? 0.8 : 1)));
        while (sparked < n && head >= sparked + 0.5) this.sparkEdge(edges[sparked++]);
        if (!finale && after > 0) {
          finale = true;
          edges.forEach((id, i) => this.sparkEdge(id, i * 30, 1));
        }
        this.updatePieceInstances();
      },
      done: () => {
        for (const id of edges) this.glow.delete(`r:${id}`);
        for (const k of vKeys) this.glow.delete(k);
        this.updatePieceInstances();
      },
    });
  }

  /**
   * 최강 기사단: 기사단 동상이 제자리에서 뛰어올라 한 바퀴 돌며 발밑이 금빛으로 빛나고 그 사람의 마을·도시가
   * 왼쪽부터 차례로 금빛으로 밝아지며 지붕 위에 반짝이가 터진다. 그와 함께 빈 광장에 그 사람의 병사들이 사열한다 (playParade).
   */
  /**
   * 황금 기사단: 최강 기사단을 가진 사람이 기사를 쓰면 동상이 금빛으로 달아올라 높이 뛰어 두 바퀴 돌고,
   * 둘레에 금빛 반짝이가 크게 터지며 그 사람의 마을·도시가 금빛으로 빛난다 (달성 연출보다 크고 길다).
   * 광장의 사열 병사들도 금빛이 섞인 옷으로 서서 경례를 더 오래 한다.
   */
  playGoldenKnight(playerId: string): void {
    if (!this.ready) return;
    this.glowArmy(playerId, true);
    this.playParade(playerId, true);
  }

  private glowArmy(playerId: string, golden = false): void {
    const mine = this.state.buildings
      .filter((b) => b.owner === playerId)
      .map((b) => ({ b, p: this.vertexWorld(b.vertexId) }))
      .filter((x): x is { b: BoardBuildingView; p: THREE.Vector3 } => !!x.p)
      .sort((x, y) => x.p.x - y.p.x);
    const each = golden ? 150 : 230;
    const rise = 950;
    const fadeMs = golden ? 900 : 650;
    const start = 300;
    const total = start + mine.length * each + rise + fadeMs;
    const sparked = new Set<number>();
    const statue = this.statue?.visible ? this.statue : null;
    this.addAnim({
      duration: total,
      update: (t) => {
        const ms = t * total;
        const fade = ms > total - fadeMs ? (total - ms) / fadeMs : 1;
        mine.forEach(({ b, p }, i) => {
          const u = (ms - start - i * each) / rise;
          const g = u < 0 ? 0 : u < 0.25 ? u / 0.25 : Math.max(0.45, 1 - ((u - 0.25) / 0.75) * 0.55);
          this.glow.set(`b:${b.vertexId}`, g * fade);
          if (u >= 0 && !sparked.has(i)) {
            sparked.add(i);
            this.sparkBurst(p.clone().add(new THREE.Vector3(0, BADGE_LIFT[b.kind] * 0.78, 0)), 0, 5, 0.28);
          }
        });
        if (statue) this.glow.set('s', Math.min(1, ms / 300) * fade * (golden ? 1.35 : 1));
        this.updatePieceInstances();
      },
      done: () => {
        for (const { b } of mine) this.glow.delete(`b:${b.vertexId}`);
        this.glow.delete('s');
        this.updatePieceInstances();
      },
    });
    if (!statue) return;
    const base = statue.position.clone();
    const tile0 = this.statueTile;
    this.statueHopping = true;
    this.addAnim({
      duration: golden ? 1300 : 900,
      update: (t) => {
        // 그사이 동상을 다른 칸으로 옮기면 날아가는 연출에 자리를 넘긴다.
        if (this.statueTile !== tile0) return;
        statue.position.y = base.y + Math.sin(Math.PI * t) * (golden ? 0.85 : 0.45);
        statue.rotation.y = easeInOut(t) * Math.PI * (golden ? 4 : 2);
        if (golden) statue.scale.setScalar(STATUE_SCALE * (1 + 0.28 * Math.sin(Math.PI * t)));
        this.syncGlow();
      },
      done: () => {
        if (this.statueTile === tile0) {
          statue.position.copy(base);
          statue.rotation.y = 0;
        }
        statue.scale.setScalar(STATUE_SCALE);
        this.statueHopping = false;
      },
    });
    if (golden) {
      // 땅에서 한 번, 가장 높이 떴을 때 한 번 더 크게 터진다.
      this.sparkBurst(base.clone().add(new THREE.Vector3(0, 0.2, 0)), 0, 12, 0.6, 0.13);
      this.sparkBurst(base.clone().add(new THREE.Vector3(0, 1.3, 0)), 560, 16, 0.55, 0.15);
      this.spawnFloating(base.clone().add(new THREE.Vector3(0, 1.45, 0)), '황금 기사단', 'float-label float-golden', 450);
      return;
    }
    this.sparkBurst(base.clone().add(new THREE.Vector3(0, 0.95, 0)), 380, 7, 0.32, 0.12);
    this.spawnFloating(base.clone().add(new THREE.Vector3(0, 1.0, 0)), '최강 기사단', 'float-label float-award', 300);
  }

  /**
   * 최강 기사단 사열: 빈 광장(동상이 떠난 광장, 여럿이면 그 사람의 마을·도시에 가까운 곳)의 돌 단 위에
   * 그 사람 색 옷과 방패를 든 병사들이 앞줄부터 한 줄씩 북소리에 맞춰 들어서고(3줄 × 4명, 카메라 쪽을 본다),
   * 다 함께 칼을 하늘로 치켜들어 경례한 뒤 칼을 내리고 제자리걸음을 하다가 작아지며 사라진다.
   * 동상이 광장에 서 있으면 돌 단 둘레에 둥글게 서서 동상을 보고 경례한다. 박자는 board/parade.ts (효과음과 같다).
   */
  private playParade(playerId: string, golden: boolean): void {
    if (!this.soldierParts.length) return;
    const plazas = this.options.tiles.filter((t) => t.kind === 'plaza');
    if (!plazas.length) return;
    const homes = this.state.buildings.filter((b) => b.owner === playerId).map((b) => this.vertexWorld(b.vertexId)).filter((p): p is THREE.Vector3 => !!p);
    const home = homes.length ? homes.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / homes.length) : new THREE.Vector3();
    const near = (list: TileDef[]) =>
      list.reduce((best, t) => {
        const c = tileCenter(t, this.metrics);
        const cb = tileCenter(best, this.metrics);
        return Math.hypot(c.x - home.x, c.z - home.z) < Math.hypot(cb.x - home.x, cb.z - home.z) ? t : best;
      });
    const empty = plazas.filter((t) => t.id !== this.statueTile || !this.statue?.visible);
    const tile = near(empty.length ? empty : plazas);
    const ring = !empty.includes(tile);
    const c = tileCenter(tile, this.metrics);
    const dais = new THREE.Vector3(c.x + PLAZA_STATUE_SPOT.x, TILE_TOP, c.z + PLAZA_STATUE_SPOT.z);
    const timing = paradeTiming(golden);
    const { ranks, files } = timing;
    const members: Parade['members'] = [];
    for (let rank = 0; rank < ranks; rank++) {
      for (let file = 0; file < files; file++) {
        let x: number;
        let z: number;
        let yaw = 0;
        if (ring) {
          // 앞쪽(카메라 쪽) 무리부터 둥글게 들어서서 가운데 동상을 본다.
          const i = rank * files + file;
          const a = Math.PI / 2 + ((i - (files - 1) / 2) / (ranks * files)) * Math.PI * 2;
          x = Math.cos(a) * PARADE_RING;
          z = Math.sin(a) * PARADE_RING;
          yaw = Math.atan2(-x, -z);
        } else {
          x = (file - (files - 1) / 2) * PARADE_FILE_GAP;
          z = ((ranks - 1) / 2 - rank) * PARADE_RANK_GAP;
        }
        const d = Math.hypot(x, z);
        const lift = ring ? 0 : d < DAIS_TOP_R ? DAIS_HEIGHT : d < DAIS_LOW_R ? DAIS_HEIGHT / 2 : 0;
        members.push({ at: dais.clone().add(new THREE.Vector3(x, lift, z)), yaw, rank, file });
      }
    }
    const colorIndex = this.state.buildings.find((b) => b.owner === playerId)?.colorIndex ?? 0;
    const parade: Parade = { members, colorIndex, timing, golden, sparked: new Set() };
    this.parade = parade;
    this.addAnim({
      duration: timing.end,
      update: (t) => {
        if (this.parade === parade) this.syncParade(parade, t * timing.end);
      },
      done: () => {
        if (this.parade !== parade) return;
        this.parade = null;
        this.syncParade(null, 0);
      },
    });
  }

  /** 사열 병사들을 ms 때의 자세로 놓는다 (parade 가 없으면 모두 감춘다) */
  private syncParade(parade: Parade | null, ms: number): void {
    const color = new THREE.Color();
    const gold = new THREE.Color(AWARD_GOLD);
    const body = new THREE.Matrix4();
    const arm = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const cap = this.soldierParts[0]?.mesh.instanceMatrix.count ?? 0;
    let n = 0;
    if (parade) {
      const T = parade.timing;
      color.set(this.playerColor(parade.colorIndex));
      if (parade.golden) color.lerp(gold, 0.35).multiplyScalar(1.15);
      const fade = ms > T.fade ? Math.max(0, 1 - (ms - T.fade) / (T.end - T.fade)) : 1;
      // 칼: 내린 차렷 → 다 함께 치켜든 경례 → 내림
      let a = SOLDIER_ARM_REST;
      if (ms > T.salute && ms <= T.salute + 320) a = SOLDIER_ARM_REST + (SOLDIER_ARM_SALUTE - SOLDIER_ARM_REST) * easeOutBack((ms - T.salute) / 320);
      else if (ms > T.salute + 320 && ms <= T.lower) a = SOLDIER_ARM_SALUTE;
      else if (ms > T.lower) a = SOLDIER_ARM_SALUTE + (SOLDIER_ARM_REST - SOLDIER_ARM_SALUTE) * easeInOut(Math.min(1, (ms - T.lower) / PARADE_LOWER_MS));
      // 칼을 내린 뒤 사라질 때까지 다 함께 제자리걸음: 한 걸음마다 들썩이며 좌우로 살짝 기운다.
      const marchFrom = T.lower + PARADE_LOWER_MS;
      const phase = ms > marchFrom ? ((ms - marchFrom) / T.step) * Math.PI : 0;
      const bob = ms > marchFrom ? Math.abs(Math.sin(phase)) * 0.022 : 0;
      const roll = ms > marchFrom ? Math.sin(phase) * 0.07 : 0;
      parade.members.forEach((m, i) => {
        const appear = T.start + m.rank * T.gap + m.file * 45;
        const u = ms - appear;
        if (u <= 0 || n >= cap) return;
        const pop = Math.min(1, u / 280);
        const s = SOLDIER_SCALE * Math.max(0.01, easeOutBack(pop)) * Math.max(0.01, easeInOut(fade));
        pos.copy(m.at);
        pos.y += bob - (1 - pop) * 0.06 - (1 - fade) * 0.08;
        q.setFromAxisAngle(yAxis, m.yaw).multiply(tmpQ2.setFromAxisAngle(zAxis, roll));
        body.compose(pos, q, tmpS.setScalar(s));
        arm.makeRotationX(a).setPosition(SOLDIER_SHOULDER[0], SOLDIER_SHOULDER[1], SOLDIER_SHOULDER[2]).premultiply(body);
        for (const part of this.soldierParts) {
          part.mesh.setMatrixAt(n, body);
          if (part.tint) part.mesh.setColorAt(n, color);
        }
        for (const part of this.soldierArmParts) {
          part.mesh.setMatrixAt(n, arm);
          if (part.tint) part.mesh.setColorAt(n, color);
        }
        if (ms > T.salute + 300 && !parade.sparked.has(i)) {
          parade.sparked.add(i);
          const tip = new THREE.Vector3(0, 0, SOLDIER_REACH).applyMatrix4(arm);
          if (parade.golden) this.sparkBurst(tip, i * 25, 2, 0.1, 0.09);
          else this.spawnSparkle(tip, i * 25, 0.09);
        }
        n++;
      });
    }
    for (const part of [...this.soldierParts, ...this.soldierArmParts]) {
      part.mesh.count = n;
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * 해상 교역로 교환 연출: 그 사람이 쓴 교역로(낸 자원마다 비율이 맞는 2:1·3:1 부두)마다 배가 들어와 짐을 주고받는다.
   * give·get 은 게임 기록의 bank_trade 묶음 그대로다. 교역로를 쓰지 않은 몫(은행 4:1)은 배 없이 지나간다.
   */
  playHarborTrade(playerId: string, give: Bundle, get: Bundle): void {
    if (!this.ready) return;
    const owns = (edgeId: string) => {
      const e = this.geo.edgeMap[edgeId];
      return !!e && this.state.buildings.some((b) => b.owner === playerId && (b.vertexId === e.a || b.vertexId === e.b));
    };
    harborLegs(this.state.harbors ?? [], owns, give, get).forEach((leg, i) => this.playHarborShip(leg.edgeId, playerId, leg.give, leg.get, i * 420));
  }

  /**
   * 교역로 부두 하나에 그 사람 색 돛을 단 배가 빠르게 들어와 옆에 대고, 낸 자원을 마을·도시에서 배로 싣고
   * 받은 자원을 배에서 마을·도시로 내려 준 뒤 바다로 떠난다. 약 2.8초.
   */
  playHarborShip(edgeId: string, playerId: string, give: readonly Resource[] = [], get: readonly Resource[] = [], delay = 0): void {
    if (!this.ready || !this.shipParts.length) return;
    const spot = this.harborSpot(edgeId);
    const e = this.geo.edgeMap[edgeId];
    if (!spot || !e) return;
    // 부두 바다 쪽 끝에 바닷가와 나란히 댄다. 붙박이 쪽배가 있는 교역로는 쪽배 반대쪽으로 조금 비켜 댄다.
    const idx = (this.state.harbors ?? []).findIndex((h) => h.edgeId === edgeId);
    const sgn = idx % 4 === 0 ? -1 : 1;
    const side = new THREE.Vector3(spot.n.z, 0, -spot.n.x).multiplyScalar(sgn);
    const berth = spot.dock.clone().addScaledVector(side, 0.14).addScaledVector(spot.n, 0.44).setY(0.02);
    // 호수·가운데 바다처럼 안쪽 물에 있는 교역로는 물이 좁아 맞은편 땅을 넘지 않게 가까이에서 들어오고 나간다.
    const inner = innerCoastEdges(this.geo).includes(edgeId);
    const reach = inner ? 0.75 : 1.9;
    const swing = inner ? 0.35 : 0.8;
    const sea = berth.clone().addScaledVector(spot.n, reach).addScaledVector(side, swing);
    const away = berth.clone().addScaledVector(spot.n, reach).addScaledVector(side, -swing);
    const forward = side.clone().negate();
    const home = this.state.buildings.find((b) => b.owner === playerId && (b.vertexId === e.a || b.vertexId === e.b));
    const colorIndex = home?.colorIndex ?? this.state.buildings.find((b) => b.owner === playerId)?.colorIndex ?? 0;
    const ship: Ship = {
      t: 0,
      sea,
      berth,
      away,
      dockYaw: Math.atan2(-forward.z, forward.x),
      colorIndex,
      seed: (hashString(edgeId) % 100) / 10,
    };
    this.addAnim({
      delay,
      duration: SHIP_MS,
      update: (t) => {
        if (!this.ships.includes(ship)) this.ships.push(ship);
        ship.t = t;
        this.syncShips();
      },
      done: () => {
        this.ships = this.ships.filter((s) => s !== ship);
        this.syncShips();
      },
    });
    // 짐: 배가 댄 뒤 낸 자원이 집에서 배로 날아가고, 이어서 받은 자원이 배에서 집으로 날아온다.
    const deck = berth.clone().add(new THREE.Vector3(0, 0.26, 0));
    const house = home ? this.vertexWorld(home.vertexId)!.add(new THREE.Vector3(0, 0.5, 0)) : spot.dock.clone().setY(0.4);
    const docked = performance.now() + delay + SHIP_MS * SHIP_IN;
    give.slice(0, 6).forEach((r, k) => this.launchGoods(r, house.clone(), deck.clone().add(new THREE.Vector3(0, 0, (k % 2) * 0.06)), docked + 40 + k * 70, 520, 0.38));
    const unload = docked + 40 + Math.min(6, give.length) * 70 + 380;
    get.slice(0, 4).forEach((r, k) => {
      const to = house.clone().add(new THREE.Vector3((k - (Math.min(4, get.length) - 1) / 2) * 0.2, 0.05, 0));
      this.launchGoods(r, deck.clone(), to, unload + k * 110, 620, 0.45);
    });
    if (home && get.length) {
      const at = this.vertexWorld(home.vertexId)!.add(new THREE.Vector3(0, 1.05, 0));
      this.spawnFloating(at, `+${get.length}`, `float-label float-${get[0]}`, Math.max(0, unload + 500 - performance.now()));
    }
  }

  /** 떠 있는 배들을 그린다: 바다에서 미끄러져 들어와 부두에 나란히 대고, 다시 돌아 나가며 작아져 사라진다. */
  private syncShips(): void {
    const now = performance.now();
    const color = new THREE.Color();
    const pos = new THREE.Vector3();
    const turnTo = (a: number, b: number, k: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
    let i = 0;
    for (const s of this.ships) {
      if (i >= SHIP_MAX) break;
      let yaw = s.dockYaw;
      let scale = SHIP_SCALE;
      if (s.t < SHIP_IN) {
        const u = s.t / SHIP_IN;
        pos.lerpVectors(s.sea, s.berth, 1 - (1 - u) ** 3);
        const travel = Math.atan2(-(s.berth.z - s.sea.z), s.berth.x - s.sea.x);
        yaw = turnTo(travel, s.dockYaw, smoothstep(0.55, 1, u));
        scale *= Math.max(0.01, easeOutBack(Math.min(1, u / 0.3)));
      } else if (s.t < SHIP_OUT) {
        pos.copy(s.berth);
      } else {
        const u = (s.t - SHIP_OUT) / (1 - SHIP_OUT);
        pos.lerpVectors(s.berth, s.away, u * u);
        const travel = Math.atan2(-(s.away.z - s.berth.z), s.away.x - s.berth.x);
        yaw = turnTo(s.dockYaw, travel, smoothstep(0, 0.45, u));
        scale *= Math.max(0.01, 1 - smoothstep(0.62, 1, u));
      }
      // 물결에 살짝 오르내리며 옆으로 흔들린다.
      pos.y += Math.sin(now * 0.006 + s.seed) * 0.012;
      const roll = Math.sin(now * 0.0045 + s.seed) * 0.07;
      tmpQ.setFromAxisAngle(yAxis, yaw).multiply(tmpQ2.setFromAxisAngle(xAxis, roll));
      tmpM.compose(pos, tmpQ, tmpS.setScalar(scale));
      for (const part of this.shipParts) {
        part.mesh.setMatrixAt(i, tmpM);
        if (part.tint) part.mesh.setColorAt(i, color.set(this.playerColor(s.colorIndex)));
      }
      i++;
    }
    for (const part of this.shipParts) {
      part.mesh.count = i;
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * 달성 연출. 최장 교역로는 그 사람의 가장 긴 길을 따라 금빛이 훑고 지나가며 반짝인다. 최강 기사단은 기사단 동상이 뛰어올라
   * 돌며 그 사람의 마을·도시가 차례로 금빛으로 빛난다. 조각을 늘이거나 부풀리지 않는다.
   */
  playAward(award: 'longest_road' | 'largest_army', _colorIndex: number, playerId: string): void {
    if (!this.ready) return;
    if (award === 'largest_army') {
      this.glowArmy(playerId);
      this.playParade(playerId, false);
      return;
    }
    // 달성을 만든 길이 막 솟아오르는 중일 수 있으니 잠깐 기다렸다가, 그때의 상태로 가장 긴 길을 찾는다.
    window.setTimeout(() => {
      if (!this.disposed) this.sweepLongestRoad(playerId);
    }, 320);
    const mids = this.state.roads
      .filter((r) => r.owner === playerId)
      .map((r) => this.edgeWorld(r.edgeId)?.mid)
      .filter((m): m is THREE.Vector3 => !!m);
    if (mids.length) {
      const at = mids.reduce((a, m) => a.add(m), new THREE.Vector3()).multiplyScalar(1 / mids.length);
      this.spawnFloating(at.add(new THREE.Vector3(0, 0.8, 0)), '최장 교역로', 'float-label float-award', 300);
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
    this.applyShadows();
    this.painter.setSamples(mode === 'low' ? 0 : 4);
    this.pixelStep = 0;
    this.perf.resetRecent();
    this.applyPixelRatio();
    this.requestRender();
  }

  /** 물체 그림자를 켜고 끈다 (품질이 낮음이면 켜도 그리지 않는다). */
  setShadows(on: boolean): void {
    this.shadowsWanted = on;
    this.applyShadows();
    this.requestRender();
  }

  private applyShadows(): void {
    const on = this.shadowsWanted && this.quality !== 'low';
    if (this.sun.castShadow !== on) {
      this.sun.castShadow = on;
      this.shadowDirty = true;
    }
    const size = SHADOW_MAP_SIZE[this.quality];
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      // 다음 그림자 갱신 때 새 크기로 다시 만든다.
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.shadowDirty = true;
    }
  }

  /** 보드가 바뀌었으면 이번 그림에서 그림자 맵을 한 번 다시 그린다. */
  private flushShadows(): void {
    if (!this.shadowDirty || !this.sun.castShadow) return;
    this.shadowDirty = false;
    this.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * 그림자를 드리우고 받는 물체를 정한다. 만화 음영 재질을 쓰는 지형·소품·조각은 모두 받고,
   * 그중 멈춰 있는 것만 드리운다. 땅·모래·바다는 받기만 하고, 양·교역인·날아가는 생산물·배·연기·동상은
   * 움직이므로 지금처럼 바닥에 깐 그림자 얼룩만 쓴다.
   */
  private tagShadows(): void {
    const moving = new Set<THREE.Object3D>([
      ...[...this.goods.values()].flat(),
      ...this.traderParts.map((x) => x.mesh),
      ...this.shipParts.map((x) => x.mesh),
      ...(this.smokeMesh ? [this.smokeMesh] : []),
    ]);
    const skip = (o: THREE.Object3D): boolean => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) {
        if (p === this.statue || p === this.lockRoot || moving.has(p) || p.userData.moving) return true;
      }
      return false;
    };
    this.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const toon = mats.some((m) => m instanceof THREE.MeshToonMaterial);
      o.receiveShadow = toon;
      o.castShadow = toon && !o.userData.ground && !skip(o);
    });
    this.shadowDirty = true;
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
    const w = this.spotWorld(kind, id);
    if (!w) return null;
    const p = w.project(this.camera);
    return { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height };
  }

  /** 칸 가운데(타일 윗면), 꼭짓점(마을 몸통 높이), 변 가운데(길 윗면)의 세계 좌표 */
  private spotWorld(kind: 'tile' | 'vertex' | 'edge', id: string): THREE.Vector3 | null {
    if (kind === 'tile') {
      const t = this.tileById.get(id);
      return t ? tileCenter(t, this.metrics).setY(TILE_TOP) : null;
    }
    if (kind === 'vertex') return this.vertexWorld(id)?.add(new THREE.Vector3(0, 0.16, 0)) ?? null;
    return this.edgeWorld(id)?.mid.setY(PLATFORM_TOP + ROAD_DECK_TOP) ?? null;
  }

  /**
   * 보드 위 자리를 따라다니는 빈 HTML 칸을 만든다. 보드를 끌거나 확대해도 그 자리 바로 위에 붙어 있다.
   * 안은 React 가 createPortal 로 채우고, 다 쓰면 unpin 으로 뗀다. 칸의 아래 가운데가 자리에 닿는다 (center 면 칸 한가운데가 닿는다).
   */
  pin(kind: 'tile' | 'vertex' | 'edge', id: string, center = false): HTMLElement | null {
    const world = this.spotWorld(kind, id);
    if (!world || this.disposed) return null;
    const el = document.createElement('div');
    el.className = center ? 'board-pin-center' : `board-pin board-pin-${kind}`;
    this.overlay.appendChild(el);
    this.pins.push({ el, world, anchor: center ? 'translate(-50%, -50%)' : 'translate(-50%, -100%)' });
    this.updateOverlay();
    return el;
  }

  unpin(el: HTMLElement): void {
    this.pins = this.pins.filter((p) => p.el !== el);
    el.remove();
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
      // 자동 품질은 프레임을 다 그린 뒤 해상도를 낮춘다. 캔버스 크기를 바꾸면 그림이 지워지니 그 자리에서 다시 그린다.
      this.drawNow();
    }
  }

  /**
   * 보드 칸의 크기가 바뀌었을 때. 캔버스 크기를 바꾸면 그려 둔 그림이 지워지는데, 크기 변경 알림(ResizeObserver)은
   * 그 프레임의 그리기 예약(requestAnimationFrame)이 끝난 뒤에 오므로 다음 프레임까지 빈 캔버스가 비쳐 깜빡인다.
   * 그래서 크기가 실제로 달라졌을 때만 캔버스를 바꾸고, 바꾼 자리에서 바로 한 장을 그린다.
   */
  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const ratio = this.pixelRatioTarget();
    const same = this.sized && w === this.width && h === this.height && Math.abs(this.renderer.getPixelRatio() - ratio) < 0.01;
    this.width = w;
    this.height = h;
    this.sized = true;
    if (!same) {
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
      this.painter.setSize(w, h, this.renderer.getPixelRatio());
    }
    this.fitCamera();
    if (!same) this.drawNow();
    this.requestRender();
  }

  /** 지금 바로 한 장을 그린다 (캔버스 크기를 바꾼 직후, 화면에 칠해지기 전에 다시 채운다). */
  private drawNow(): void {
    if (this.disposed) return;
    this.renderer.info.reset();
    this.flushShadows();
    this.painter.render(this.scene, this.camera);
    this.updateOverlay();
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
    // 보드를 실제로 끌어 움직이면 마우스 올림 표시와 알림을 닫는다 (위치가 맞지 않게 되므로).
    // 누르기만 해서는 닫지 않는다. 누를 때마다 테두리가 꺼졌다 켜지면 화면이 깜빡여 보인다.
    if (this.interacting && this.hovered) {
      this.hovered = null;
      this.updateHighlights();
      this.emitHover();
    }
  };

  private onControlsStart = (): void => {
    this.interacting = true;
    this.requestRender();
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
    const high = new THREE.Vector3();
    if (!ray.intersectPlane(new THREE.Plane(yAxis, -TILE_TOP), low)) return null;
    // 집·도시는 높이가 있어 몸통이나 지붕을 누르면 바닥보다 뒤쪽이 맞는다. 꼭짓점은 몸통 높이에서도 재고,
    // 마을·도시가 선 꼭짓점은 지붕 높이에서도 잰다.
    ray.intersectPlane(new THREE.Plane(yAxis, -(TILE_TOP + 0.16)), mid);
    ray.intersectPlane(new THREE.Plane(yAxis, -(TILE_TOP + 0.36)), high);
    const worldPerPixel = (this.camera.right - this.camera.left) / this.camera.zoom / Math.max(1, rect.width);
    // 손가락 크기(약 24px)로 잡되, 멀리 축소해도 이웃 꼭짓점(1.32 떨어짐)까지 넘보지 않게 상한을 둔다.
    const reach = Math.min(0.42, Math.max(0.16, 24 * worldPerPixel));
    const flat = (p: THREE.Vector3, q: THREE.Vector3) => Math.hypot(p.x - q.x, p.z - q.z);
    const built = new Map(this.state.buildings.map((b) => [b.vertexId, b.kind]));
    const nearestVertex = (ids: readonly string[]) => {
      let best: { id: string; d: number } | null = null;
      for (const id of ids) {
        const p = this.vertexWorld(id);
        if (!p) continue;
        let d = Math.min(flat(p, mid), flat(p, low));
        // 커다란 마을·도시는 몸통 어디를 눌러도 그 꼭짓점이 잡히게 몸통 크기만큼 거리를 덜어 준다.
        const kind = built.get(id);
        if (kind) d = Math.max(0, Math.min(d, flat(p, high)) - PIECE_PICK_BONUS[kind]);
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
    // 기사단 동상 몸통을 누르면 (바닥으로는 뒤쪽 칸이 맞더라도) 동상이 선 칸을 고른다. 누르면 동상이 살짝 뛴다.
    if (this.statue?.visible && this.statueTile && ray.intersectsBox(new THREE.Box3().setFromObject(this.statue).expandByScalar(0.03))) {
      return { kind: 'tile', id: this.statueTile };
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
      this.options.onTap?.(sel, { alt: e.altKey });
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
    const busy = this.interacting || this.anims.length > 0 || this.tokens.length > 0 || this.sparkles.length > 0 || this.bouncing.size > 0;
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
    if (this.updateSparkles(now)) animating = true;
    if (this.ready && (ambient || this.bouncing.size) && this.updateMotion(now)) animating = true;
    const moving = this.controls.update();
    const t0 = performance.now();
    this.renderer.info.reset();
    this.flushShadows();
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
    this.pins.forEach(place);
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
    for (const t of this.owned.textures) t.dispose();
    paintLock.amount.value = 0;
    for (const v of paintGlow.tiles.value) v.z = 0;
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
