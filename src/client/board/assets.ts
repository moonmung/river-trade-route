// 3D 에셋 불러오기.
//  1) public/art/manifest.json 에 적힌 GLB 모델과 KTX2 텍스처를 방장 PC 서버에서 받는다 (외부 CDN 없음).
//  2) KTX2 는 public/vendor/basis 의 Basis 트랜스코더로 기기에 맞는 GPU 압축 형식으로 푼다.
//  3) 파일이 없거나 이 기기에서 풀 수 없으면, 같은 모양을 코드로 만든 단색 대체 모델을 쓴다.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildProp, propAssetName, type PropKey } from './art/builders';
import { MATERIALS, materialKeyFromName, type MaterialKey } from './art/materials';
import { paintMaterial, paintVariant } from './paint';

// 보드 밖은 무늬 없는 물이라 풀밭(ground_grass)·물결(water_normal) 텍스처는 불러오지 않는다.
// 빈 변은 흙 땅 셰이더가 희끄무레한 샛길로 칠하므로 예전 흙길 띠(ground_road)도 불러오지 않는다. 세 파일과 manifest 항목은 남아 있다.
// 모래(ground_sand)는 바닷가 모래밭에 쓴다.
export type GroundTextureKey =
  | 'ground_dirt'
  | 'ground_forest'
  | 'ground_field'
  | 'ground_quarry'
  | 'ground_pasture'
  | 'ground_clay'
  | 'ground_cobble'
  | 'ground_sand'
  | 'contact_shadow';

export interface ManifestEntry {
  url: string;
  /** 여러 소품을 담은 GLB 에서 이 소품의 노드 이름 (없으면 파일 전체) */
  node?: string;
  /** 최종 에셋이 아니라 임시로 만든 에셋인지 */
  temporary?: boolean;
  note?: string;
}

export interface ArtManifest {
  version: number;
  generatedBy?: string;
  models: Record<string, ManifestEntry>;
  textures: Record<string, ManifestEntry>;
}

export interface TemplatePart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  tint: boolean;
}

export interface PropTemplate {
  parts: TemplatePart[];
  source: 'glb' | 'fallback';
}

export interface ArtReport {
  manifestFound: boolean;
  glbModels: number;
  ktx2Textures: number;
  fallbackModels: string[];
  fallbackTextures: string[];
  temporaryAssets: number;
  errors: string[];
}

export interface ArtLibrary {
  /**
   * 소품 하나의 도형과 재질. keepColor 면 기사단 동상이 선 칸 안에서도 무채색이 되지 않는 재질을 쓴다
   * (도형은 같고 재질만 따로 만든다): 플레이어 조각, 동상·사슬·자물쇠, 교역인, 날아가는 생산물.
   */
  prop(key: PropKey, variant: number, keepColor?: boolean): PropTemplate;
  ground(key: GroundTextureKey): THREE.Texture | null;
  report: ArtReport;
  dispose(): void;
}

const ART_BASE = '/art/';
const TRANSCODER_PATH = '/vendor/basis/';

const fallbackMaterials = new Map<MaterialKey, THREE.Material>();

/** 바람에 흔들리는 재질과 세기: 나뭇잎·덤불, 밀 이삭, 깃발. 눈에 겨우 띌 만큼만 흔들린다. */
const SWAY: Partial<Record<MaterialKey, number>> = { foliage: 0.025, leaf: 0.035, wheat: 0.22, banner: 0.2 };

/** 재질 키에 맞는 만화 음영 재질. 텍스처 없이 재질 색 × 꼭짓점 색으로 칠한다. */
function fallbackMaterial(key: MaterialKey): THREE.Material {
  let m = fallbackMaterials.get(key);
  if (!m) {
    const spec = MATERIALS[key];
    m = paintMaterial({
      name: `M_${key}`,
      color: spec.color,
      vertexColors: true,
      side: spec.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      sway: SWAY[key] ?? 0,
    });
    fallbackMaterials.set(key, m);
  }
  return m;
}

/**
 * GLB 재질을 같은 그림체의 만화 음영 재질로 바꾼다.
 * 이름이 M_<키> 인 재질은 재질 목록의 색을 쓰고, 그 밖의 재질은 GLB 의 색과 텍스처를 그대로 옮긴다.
 */
function paintedFromGltf(material: THREE.Material): THREE.Material {
  const key = materialKeyFromName(material.name);
  if (key) return fallbackMaterial(key);
  const src = material as THREE.MeshStandardMaterial;
  return paintMaterial({
    name: material.name,
    color: src.color ?? '#ffffff',
    map: src.map ?? null,
    vertexColors: !!src.vertexColors,
    side: material.side,
  });
}

export function fallbackTemplate(key: PropKey, variant: number): PropTemplate {
  const parts = buildProp(key, variant).map((p) => ({
    geometry: p.geometry,
    material: fallbackMaterial(p.material),
    tint: !!MATERIALS[p.material].tint,
  }));
  return { parts, source: 'fallback' };
}

/**
 * GLB 의 한 노드(소품)를 재질별로 합쳐 인스턴싱하기 좋은 형태로 바꾼다.
 * 노드 안쪽 변환은 도형에 미리 적용하고, 소품 노드 자체의 위치(키트 안 배치)는 무시한다.
 */
function templateFromObject(root: THREE.Object3D, sharedMaterials: Map<string, THREE.Material>): PropTemplate {
  root.updateWorldMatrix(true, true);
  const toLocal = root.matrixWorld.clone().invert();
  const byMaterial = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const material = materials[0];
    const name = material.name || 'M_unnamed';
    let shared = sharedMaterials.get(name);
    if (!shared) {
      shared = paintedFromGltf(material);
      sharedMaterials.set(name, shared);
      if (shared !== material) material.dispose();
    }
    const g = mesh.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld));
    // 같은 이름의 재질을 공유할 때, 꼭짓점 색이 없는 모델이 검게 그려지지 않게 흰색을 채운다.
    if (shared.vertexColors && !g.attributes.color) {
      const white = new Float32Array(g.attributes.position.count * 3).fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(white, 3));
    }
    const entry = byMaterial.get(name) ?? { material: shared, geometries: [] };
    entry.geometries.push(g);
    byMaterial.set(name, entry);
  });
  const parts: TemplatePart[] = [];
  for (const [name, { material, geometries }] of byMaterial) {
    const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const key = materialKeyFromName(name);
    parts.push({ geometry: merged, material, tint: key ? !!MATERIALS[key].tint : false });
  }
  return { parts, source: 'glb' };
}

/** 대체용 접촉 그림자: 캔버스에 부드러운 원을 한 번 그려 둔다 (매 프레임 계산하지 않음). */
function fallbackShadowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(200,200,200,1)');
  g.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

export interface LoadProgress {
  done: number;
  total: number;
}

export async function loadArtLibrary(
  renderer: THREE.WebGLRenderer,
  propList: { key: PropKey; variant: number }[],
  onProgress?: (p: LoadProgress) => void,
): Promise<ArtLibrary> {
  const report: ArtReport = {
    manifestFound: false,
    glbModels: 0,
    ktx2Textures: 0,
    fallbackModels: [],
    fallbackTextures: [],
    temporaryAssets: 0,
    errors: [],
  };
  const templates = new Map<string, PropTemplate>();
  const textures = new Map<GroundTextureKey, THREE.Texture>();
  const sharedMaterials = new Map<string, THREE.Material>();
  const keptMaterials = new Map<THREE.Material, THREE.Material>();
  const keptTemplates = new Map<string, PropTemplate>();
  const keepColor = (m: THREE.Material) => {
    let v = keptMaterials.get(m);
    if (!v) {
      v = paintVariant(m, { lock: false });
      keptMaterials.set(m, v);
    }
    return v;
  };
  let ktx2: KTX2Loader | null = null;

  let manifest: ArtManifest | null = null;
  try {
    const res = await fetch(`${ART_BASE}manifest.json`, { cache: 'no-cache' });
    // 파일이 없으면 개발 서버가 index.html 을 돌려줄 수 있으므로 JSON 인지 확인한다.
    if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) manifest = (await res.json()) as ArtManifest;
  } catch (e) {
    report.errors.push(`manifest: ${(e as Error).message}`);
  }
  report.manifestFound = !!manifest;

  const groundKeys: GroundTextureKey[] = [
    'ground_dirt',
    'ground_forest',
    'ground_field',
    'ground_quarry',
    'ground_pasture',
    'ground_clay',
    'ground_cobble',
    'ground_sand',
    'contact_shadow',
  ];
  const uniqueProps = [...new Map(propList.map((p) => [propAssetName(p.key, p.variant), p])).values()];
  const total = uniqueProps.length + groundKeys.length;
  let done = 0;
  const tick = () => onProgress?.({ done: ++done, total });

  if (manifest) {
    ktx2 = new KTX2Loader().setTranscoderPath(TRANSCODER_PATH).detectSupport(renderer);
    const gltfLoader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
    const m = manifest;
    // 같은 GLB 를 가리키는 소품은 파일을 한 번만 받는다.
    const files = new Map<string, Promise<GLTF>>();
    const loadFile = (url: string) => {
      let p = files.get(url);
      if (!p) {
        p = gltfLoader.loadAsync(ART_BASE + url);
        files.set(url, p);
      }
      return p;
    };
    const anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

    await Promise.all([
      ...uniqueProps.map(async ({ key, variant }) => {
        const name = propAssetName(key, variant);
        const entry = m.models[name];
        if (entry) {
          try {
            const gltf = await loadFile(entry.url);
            const node = entry.node ? gltf.scene.getObjectByName(entry.node) : gltf.scene;
            if (!node) throw new Error(`노드 ${entry.node} 를 찾을 수 없습니다`);
            templates.set(name, templateFromObject(node, sharedMaterials));
            report.glbModels++;
            if (entry.temporary) report.temporaryAssets++;
          } catch (e) {
            report.errors.push(`${name} (${entry.url}): ${(e as Error).message}`);
          }
        }
        tick();
      }),
      ...groundKeys.map(async (key) => {
        const entry = m.textures[key];
        if (entry && ktx2) {
          try {
            const tex = await ktx2.loadAsync(ART_BASE + entry.url);
            tex.wrapS = tex.wrapT = key === 'contact_shadow' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
            tex.anisotropy = anisotropy;
            textures.set(key, tex);
            report.ktx2Textures++;
            if (entry.temporary) report.temporaryAssets++;
          } catch (e) {
            report.errors.push(`${key}.ktx2: ${(e as Error).message}`);
          }
        }
        tick();
      }),
    ]);
  } else {
    done = total;
    onProgress?.({ done, total });
  }

  for (const p of uniqueProps) {
    const name = propAssetName(p.key, p.variant);
    if (!templates.has(name)) {
      templates.set(name, fallbackTemplate(p.key, p.variant));
      report.fallbackModels.push(name);
    }
  }
  for (const key of groundKeys) {
    if (!textures.has(key)) {
      report.fallbackTextures.push(key);
      if (key === 'contact_shadow') textures.set(key, fallbackShadowTexture());
    }
  }

  return {
    prop(key, variant, keep = false) {
      const name = propAssetName(key, variant);
      let t = templates.get(name);
      if (!t) {
        t = fallbackTemplate(key, variant);
        templates.set(name, t);
      }
      if (!keep) return t;
      let kept = keptTemplates.get(name);
      if (!kept) {
        kept = { source: t.source, parts: t.parts.map((p) => ({ ...p, material: keepColor(p.material) })) };
        keptTemplates.set(name, kept);
      }
      return kept;
    },
    ground(key) {
      return textures.get(key) ?? null;
    },
    report,
    dispose() {
      for (const t of templates.values()) for (const p of t.parts) p.geometry.dispose();
      for (const m of sharedMaterials.values()) disposeMaterial(m);
      for (const [from, kept] of keptMaterials) if (kept !== from) kept.dispose();
      for (const t of textures.values()) t.dispose();
      ktx2?.dispose();
    },
  };
}

export function disposeMaterial(m: THREE.Material): void {
  for (const value of Object.values(m)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  m.dispose();
}
