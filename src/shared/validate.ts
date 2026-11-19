// 네트워크로 들어온 값은 형식부터 확인한다. 통과하지 못하면 null.
import { CONTRACT_MAP, MAX_TRADE_AMOUNT, NICKNAME_MAX, RESOURCES, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, TILE_MAP } from './constants';
import type { Bundle, ContractId, GameAction, Resource } from './types';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isResource(v: unknown): v is Resource {
  return typeof v === 'string' && (RESOURCES as readonly string[]).includes(v);
}

function isTileId(v: unknown): v is string {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TILE_MAP, v);
}

function isContractId(v: unknown): v is ContractId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(CONTRACT_MAP, v);
}

function parseBundle(v: unknown): Bundle | null {
  if (!isObj(v)) return null;
  const out: Bundle = { wood: 0, grain: 0, stone: 0 };
  for (const r of RESOURCES) {
    const n = v[r] ?? 0;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_TRADE_AMOUNT) return null;
    out[r] = n;
  }
  return out;
}

function isTradeId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

export function parseAction(raw: unknown): GameAction | null {
  if (!isObj(raw)) return null;
  switch (raw.type) {
    case 'place':
    case 'build':
      return isTileId(raw.tileId) ? { type: raw.type, tileId: raw.tileId } : null;
    case 'market':
      return isResource(raw.give) && isResource(raw.get) ? { type: 'market', give: raw.give, get: raw.get } : null;
    case 'deliver':
      return isContractId(raw.contractId) ? { type: 'deliver', contractId: raw.contractId } : null;
    case 'trade_propose': {
      const give = parseBundle(raw.give);
      const get = parseBundle(raw.get);
      if (typeof raw.to !== 'string' || raw.to.length > 64 || !give || !get) return null;
      return { type: 'trade_propose', to: raw.to, give, get };
    }
    case 'trade_accept':
    case 'trade_reject':
    case 'trade_cancel':
      return isTradeId(raw.tradeId) ? { type: raw.type, tradeId: raw.tradeId } : null;
    case 'end_turn':
      return { type: 'end_turn' };
    default:
      return null;
  }
}

/**
 * 제어 문자·폭 없는 문자·한글 채움 문자처럼 화면에 보이지 않는 글자.
 * 빈 닉네임이나, 보기에는 같은데 다른 닉네임(예: 끝에 보이지 않는 글자를 붙인 이름)을 막는다.
 */
function isInvisible(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xad || // 소프트 하이픈
    cp === 0x34f || // 결합 문자소 연결자
    cp === 0x61c || // 아랍 문자 표시
    cp === 0x115f || // 한글 초성 채움 문자
    cp === 0x1160 || // 한글 중성 채움 문자
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    (cp >= 0x180b && cp <= 0x180f) || // 몽골 문자 변형 선택자·모음 구분자
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x2800 || // 점자 빈칸
    cp === 0x3164 || // 한글 채움 문자
    (cp >= 0xfe00 && cp <= 0xfe0f) || // 변형 선택자
    cp === 0xfeff ||
    cp === 0xffa0 || // 반각 한글 채움 문자
    (cp >= 0xfff0 && cp <= 0xfff8) ||
    (cp >= 0x1d173 && cp <= 0x1d17a) ||
    (cp >= 0xe0000 && cp <= 0xe0fff) // 태그 문자·변형 선택자 보충
  );
}

/** 앞뒤 공백 제거, 제어 문자 제거, 연속 공백 정리. 1~12자가 아니면 null */
export function normalizeNickname(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  // 조합형(NFD)으로 들어온 한글도 같은 이름으로 보도록 완성형(NFC)으로 맞춘다.
  const cleaned = Array.from(raw.normalize('NFC'))
    .filter((ch) => !isInvisible(ch.codePointAt(0) ?? 0))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const length = Array.from(cleaned).length;
  if (length < 1 || length > NICKNAME_MAX) return null;
  return cleaned;
}

export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/\s+/g, '').toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export function isRequestId(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 4 && v.length <= 64;
}
