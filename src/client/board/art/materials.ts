// 소품 재질 목록. GLB 안의 재질 이름은 `M_<키>` 규칙을 따른다 (예: M_roof).
// Blender 로 최종 모델을 만들 때도 같은 재질 이름을 쓰면 플레이어 색 입히기(tint)가 그대로 동작한다.

export type MaterialKey =
  | 'wood'
  | 'bark'
  | 'endgrain'
  | 'foliage'
  | 'leaf'
  | 'wheat'
  | 'cloth'
  | 'stripe'
  | 'plaster'
  | 'roof'
  | 'banner'
  | 'stone'
  | 'metal'
  | 'clay'
  | 'dark';

/** 소품 재질이 쓰는 KTX2 텍스처 키 (public/art/textures/<키>.ktx2) */
export type PropTextureKey =
  | 'wood_color'
  | 'wood_normal'
  | 'wood_rough'
  | 'bark_color'
  | 'bark_normal'
  | 'stone_color'
  | 'stone_normal'
  | 'stone_rough'
  | 'cloth_color'
  | 'cloth_normal'
  | 'plaster_color'
  | 'roof_color'
  | 'roof_normal'
  | 'foliage_color'
  | 'leaf_color';

export interface MaterialSpec {
  /** 텍스처가 없을 때 쓰는 기본 색 (sRGB) */
  color: string;
  roughness: number;
  metalness?: number;
  /** 플레이어 색을 인스턴스마다 곱해서 입힌다 (지붕, 깃발) */
  tint?: boolean;
  doubleSided?: boolean;
  map?: PropTextureKey;
  normalMap?: PropTextureKey;
  /** glTF metallicRoughness 텍스처 (G 채널 = 거칠기) */
  roughnessMap?: PropTextureKey;
}

export const MATERIALS: Record<MaterialKey, MaterialSpec> = {
  wood: { color: '#9a6a3c', roughness: 0.82, map: 'wood_color', normalMap: 'wood_normal', roughnessMap: 'wood_rough' },
  bark: { color: '#6d4a2c', roughness: 0.92, map: 'bark_color', normalMap: 'bark_normal' },
  endgrain: { color: '#d8b07a', roughness: 0.85 },
  foliage: { color: '#3f6e37', roughness: 0.9, map: 'foliage_color' },
  leaf: { color: '#5f8d3e', roughness: 0.88, map: 'leaf_color' },
  wheat: { color: '#e2b746', roughness: 0.8 },
  cloth: { color: '#dccaa1', roughness: 0.95, map: 'cloth_color', normalMap: 'cloth_normal' },
  stripe: { color: '#ffffff', roughness: 0.9, normalMap: 'cloth_normal' },
  plaster: { color: '#efe5cf', roughness: 0.95, map: 'plaster_color' },
  roof: { color: '#ffffff', roughness: 0.85, tint: true, map: 'roof_color', normalMap: 'roof_normal' },
  banner: { color: '#ffffff', roughness: 0.75, tint: true, doubleSided: true, normalMap: 'cloth_normal' },
  stone: { color: '#a3a7ab', roughness: 0.9, map: 'stone_color', normalMap: 'stone_normal', roughnessMap: 'stone_rough' },
  metal: { color: '#5b5650', roughness: 0.45, metalness: 0.7 },
  clay: { color: '#a98f6c', roughness: 0.55 },
  dark: { color: '#3a2d22', roughness: 0.9 },
};

export const MATERIAL_KEYS = Object.keys(MATERIALS) as MaterialKey[];

export function materialName(key: MaterialKey): string {
  return `M_${key}`;
}

export function materialKeyFromName(name: string): MaterialKey | null {
  const m = /^M_([a-z]+)/i.exec(name);
  if (!m) return null;
  const key = m[1].toLowerCase() as MaterialKey;
  return key in MATERIALS ? key : null;
}
