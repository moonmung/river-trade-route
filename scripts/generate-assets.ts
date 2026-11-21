// 임시 3D 에셋 생성기:  npm run assets   (미리보기 PNG 도 원하면: npm run assets -- --preview <폴더>)
//
// 만드는 파일
//   public/art/models/village_kit.glb   소품 전체 (노드 이름 = 소품 이름, 재질 이름 = M_<키>)
//                                      수채화풍 재질은 색과 꼭짓점 색만 쓴다. 재질 목록에 텍스처를 지정하면
//                                      KHR_texture_basisu(KTX2)로 GLB 안에 한 번씩만 들어간다.
//   public/art/textures/*.ktx2          수채화 붓질로 칠한 바닥 텍스처와 접촉 그림자
//   public/art/manifest.json            위 파일 목록. temporary: true 는 최종 모델로 바꿔야 할 임시 에셋 표시
//
// Blender 에서 최종 모델을 만들면 같은 노드 이름으로 GLB 를 내보낸 뒤 manifest.json 의 url/node 를 바꾸고
// temporary 를 false 로 고친다. 이 스크립트를 다시 실행하면 manifest 가 다시 쓰이므로 주의한다.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO, type Material, type Texture } from '@gltf-transform/core';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, prune, weld } from '@gltf-transform/functions';
import { encodeToKTX2 } from 'ktx2-encoder';
import * as THREE from 'three';
import { PROP_KEYS, PROP_VARIANTS, buildProp, propAssetName } from '../src/client/board/art/builders';
import { MATERIALS, materialName, type MaterialKey, type PropTextureKey } from '../src/client/board/art/materials';
import { encodePNG } from './lib/png';
import * as T from './lib/texgen';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/art');
const previewArg = process.argv.indexOf('--preview');
const previewDir = previewArg >= 0 ? resolve(process.argv[previewArg + 1]) : null;

type Kind = 'color' | 'linear' | 'normal';
interface TexJob {
  img: T.Img;
  kind: Kind;
}

const KTX_CONSOLE = console.log;

/** KTX2 로 압축: 색은 ETC1S(sRGB), 거칠기·그림자는 ETC1S(선형), 노멀 맵은 UASTC + Zstandard */
async function encode(name: string, job: TexJob): Promise<Uint8Array> {
  const data = job.img.toRGBA8();
  if (previewDir) writeFileSync(resolve(previewDir, `${name}.png`), encodePNG(data, job.img.w, job.img.h));
  const common = {
    isKTX2File: true,
    generateMipmap: true,
    imageDecoder: async () => ({ width: job.img.w, height: job.img.h, data }),
  };
  // Basis 인코더가 표준 출력에 진행 상황을 많이 찍으므로 잠시 막는다.
  console.log = () => {};
  try {
    if (job.kind === 'normal') {
      return await encodeToKTX2(new Uint8Array(1), {
        ...common,
        isUASTC: true,
        isNormalMap: true,
        isPerceptual: false,
        isSetKTX2SRGBTransferFunc: false,
        needSupercompression: true,
        uastcLDRQualityLevel: 1,
      });
    }
    return await encodeToKTX2(new Uint8Array(1), {
      ...common,
      isUASTC: false,
      isPerceptual: job.kind === 'color',
      isSetKTX2SRGBTransferFunc: job.kind === 'color',
      qualityLevel: 180,
      compressionLevel: 2,
    });
  } finally {
    console.log = KTX_CONSOLE;
  }
}

/** 소품 텍스처 만드는 법. 재질 목록(materials.ts)이 실제로 가리키는 것만 만든다. */
function propTextureJobs(): Record<PropTextureKey, () => TexJob> {
  return {
    wood_color: () => ({ img: T.woodPlanks(256).color, kind: 'color' }),
    wood_normal: () => ({ img: T.heightToNormal(T.woodPlanks(256).height, 256, 3), kind: 'normal' }),
    wood_rough: () => ({ img: T.roughToImg(T.woodPlanks(256).rough, 256), kind: 'linear' }),
    bark_color: () => ({ img: T.bark(256).color, kind: 'color' }),
    bark_normal: () => ({ img: T.heightToNormal(T.bark(256).height, 256, 3), kind: 'normal' }),
    stone_color: () => ({ img: T.stone(256).color, kind: 'color' }),
    stone_normal: () => ({ img: T.heightToNormal(T.stone(256).height, 256, 4), kind: 'normal' }),
    stone_rough: () => ({ img: T.roughToImg(T.stone(256).rough, 256), kind: 'linear' }),
    cloth_color: () => ({ img: T.cloth(256).color, kind: 'color' }),
    cloth_normal: () => ({ img: T.heightToNormal(T.cloth(256).height, 256, 2.5), kind: 'normal' }),
    plaster_color: () => ({ img: T.plaster(256).color, kind: 'color' }),
    roof_color: () => ({ img: T.shingles(256).color, kind: 'color' }),
    roof_normal: () => ({ img: T.heightToNormal(T.shingles(256).height, 256, 3), kind: 'normal' }),
    foliage_color: () => ({ img: T.foliage(256, '#264d27', '#4f8540', 91).color, kind: 'color' }),
    leaf_color: () => ({ img: T.foliage(256, '#3c6e2c', '#86b553', 95).color, kind: 'color' }),
  };
}

const GROUND_JOBS: Record<string, () => TexJob> = {
  ground_grass: () => ({ img: T.groundGrass(512), kind: 'color' }),
  ground_dirt: () => ({ img: T.groundDirt(512), kind: 'color' }),
  ground_forest: () => ({ img: T.groundForest(512), kind: 'color' }),
  ground_field: () => ({ img: T.groundField(512), kind: 'color' }),
  ground_quarry: () => ({ img: T.groundQuarry(512), kind: 'color' }),
  ground_pasture: () => ({ img: T.groundPasture(512), kind: 'color' }),
  ground_clay: () => ({ img: T.groundClay(512), kind: 'color' }),
  ground_cobble: () => ({ img: T.groundCobble(512), kind: 'color' }),
  ground_sand: () => ({ img: T.groundSand(512), kind: 'color' }),
  ground_road: () => ({ img: T.groundRoad(512, 128), kind: 'color' }),
  water_normal: () => ({ img: T.waterNormal(256), kind: 'normal' }),
  contact_shadow: () => ({ img: T.contactShadow(128), kind: 'linear' }),
};

function linearFactor(hexColor: string): [number, number, number, number] {
  const c = new THREE.Color(hexColor); // three 의 색 관리: sRGB 16진수 → 선형
  return [c.r, c.g, c.b, 1];
}

async function main(): Promise<void> {
  const t0 = Date.now();
  rmSync(resolve(outDir, 'models'), { recursive: true, force: true });
  rmSync(resolve(outDir, 'textures'), { recursive: true, force: true });
  mkdirSync(resolve(outDir, 'models'), { recursive: true });
  mkdirSync(resolve(outDir, 'textures'), { recursive: true });
  if (previewDir) mkdirSync(previewDir, { recursive: true });

  // 1) 바닥 텍스처 (KTX2 파일)
  const groundSizes: Record<string, number> = {};
  for (const [name, make] of Object.entries(GROUND_JOBS)) {
    const bytes = await encode(name, make());
    writeFileSync(resolve(outDir, 'textures', `${name}.ktx2`), bytes);
    groundSizes[name] = bytes.length;
  }

  // 2) 소품 텍스처 (GLB 안에 넣는다). 수채화풍 재질은 텍스처 없이 색만 쓰므로 지금은 만들 것이 없다.
  const propJobs = propTextureJobs();
  const usedProp = new Set<PropTextureKey>();
  for (const spec of Object.values(MATERIALS)) {
    for (const key of [spec.map, spec.normalMap, spec.roughnessMap]) if (key) usedProp.add(key);
  }
  const propBytes = new Map<PropTextureKey, Uint8Array>();
  for (const name of usedProp) propBytes.set(name, await encode(name, propJobs[name]()));

  // 3) 소품 키트 GLB
  const doc = new Document();
  doc.getRoot().getAsset().generator = 'river-trade-route scripts/generate-assets.ts (임시 에셋)';
  doc.getRoot().setExtras({ temporary: true, note: '코드로 만든 임시 모델입니다. Blender 최종 모델로 교체하세요.' });
  const buffer = doc.createBuffer('village_kit');
  if (usedProp.size) doc.createExtension(KHRTextureBasisu).setRequired(true);
  const scene = doc.createScene('village_kit');
  doc.getRoot().setDefaultScene(scene);

  const textures = new Map<PropTextureKey, Texture>();
  const texture = (key: PropTextureKey): Texture => {
    let t = textures.get(key);
    if (!t) {
      t = doc.createTexture(key).setImage(propBytes.get(key)!).setMimeType('image/ktx2').setURI(`${key}.ktx2`);
      textures.set(key, t);
    }
    return t;
  };
  const materials = new Map<MaterialKey, Material>();
  const material = (key: MaterialKey): Material => {
    let m = materials.get(key);
    if (m) return m;
    const spec = MATERIALS[key];
    m = doc
      .createMaterial(materialName(key))
      .setBaseColorFactor(spec.map || spec.tint ? [1, 1, 1, 1] : linearFactor(spec.color))
      .setRoughnessFactor(spec.roughnessMap ? 1 : spec.roughness)
      .setMetallicFactor(spec.metalness ?? 0)
      .setDoubleSided(!!spec.doubleSided);
    if (spec.map) m.setBaseColorTexture(texture(spec.map));
    if (spec.normalMap) m.setNormalTexture(texture(spec.normalMap)).setNormalScale(0.9);
    if (spec.roughnessMap) m.setMetallicRoughnessTexture(texture(spec.roughnessMap));
    if (spec.tint) m.setExtras({ tint: true });
    materials.set(key, m);
    return m;
  };
  const accessor = (type: 'VEC2' | 'VEC3', array: ArrayLike<number>) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(array)).setBuffer(buffer);

  const propNames: string[] = [];
  let index = 0;
  for (const key of PROP_KEYS) {
    for (let v = 0; v < PROP_VARIANTS[key]; v++) {
      const name = propAssetName(key, v);
      propNames.push(name);
      const mesh = doc.createMesh(`${name}_mesh`);
      for (const part of buildProp(key, v)) {
        const g = part.geometry;
        mesh.addPrimitive(
          doc
            .createPrimitive()
            .setAttribute('POSITION', accessor('VEC3', g.attributes.position.array))
            .setAttribute('NORMAL', accessor('VEC3', g.attributes.normal.array))
            .setAttribute('TEXCOORD_0', accessor('VEC2', g.attributes.uv.array))
            .setAttribute('COLOR_0', accessor('VEC3', g.attributes.color.array))
            .setMaterial(material(part.material)),
        );
        g.dispose();
      }
      // Blender 에서 열어 보기 좋게 격자로 늘어놓는다 (게임은 노드 기준 상대 좌표만 쓴다).
      const node = doc.createNode(name).setMesh(mesh).setTranslation([(index % 8) * 1.6, 0, Math.floor(index / 8) * 1.6]);
      scene.addChild(node);
      index++;
    }
  }
  await doc.transform(dedup(), weld(), prune());
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const glb = await io.writeBinary(doc);
  writeFileSync(resolve(outDir, 'models', 'village_kit.glb'), glb);

  // 4) 목록
  const manifest = {
    version: 1,
    generatedBy: 'scripts/generate-assets.ts',
    generatedAt: new Date().toISOString(),
    note: 'temporary: true 인 항목은 코드로 만든 임시 에셋입니다. 최종 모델·텍스처로 바꾸면 false 로 고치세요.',
    models: Object.fromEntries(
      propNames.map((n) => [n, { url: 'models/village_kit.glb', node: n, temporary: true, note: '코드로 만든 임시 모델' }]),
    ),
    textures: Object.fromEntries(
      Object.keys(GROUND_JOBS).map((n) => [n, { url: `textures/${n}.ktx2`, temporary: true, note: '절차적으로 만든 임시 텍스처' }]),
    ),
  };
  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;
  console.log(`village_kit.glb: ${kb(glb.length)} (소품 ${propNames.length}종, 재질 ${materials.size}개, 텍스처 ${textures.size}장)`);
  console.log(`바닥 텍스처: ${Object.entries(groundSizes).map(([k, v]) => `${k} ${kb(v)}`).join(', ')}`);
  console.log(`완료 (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
}

main().catch((e) => {
  console.log = KTX_CONSOLE;
  console.error(e);
  process.exit(1);
});
