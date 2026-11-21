// 참가 토큰 보관.
//  - sessionStorage: 이 탭의 현재 자리. 새로고침하면 자동으로 같은 자리로 돌아간다.
//  - localStorage: 이 기기에서 들어갔던 방 목록. 탭이 닫혔다가 링크를 다시 열었을 때 "이전 자리로 돌아가기"를 제안한다.
// 저장소를 쓸 수 없는 브라우저(사생활 보호 모드 등)에서도 게임은 계속 진행되도록 모든 접근을 try/catch 로 감싼다.

export interface StoredSession {
  roomCode: string;
  playerId: string;
  token: string;
  nickname: string;
  savedAt: number;
}

const TAB_KEY = 'rr.tabSession';
const DEVICE_KEY = 'rr.deviceSessions';
const NICK_KEY = 'rr.nickname';
const DEVICE_TTL_MS = 48 * 60 * 60 * 1000;

function read<T>(storage: () => Storage, key: string): T | null {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: unknown): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, JSON.stringify(value));
  } catch {
    /* 저장소를 쓸 수 없으면 무시한다 */
  }
}

const tab = () => window.sessionStorage;
const device = () => window.localStorage;

function isSession(v: unknown): v is StoredSession {
  const s = v as StoredSession;
  return !!s && typeof s.roomCode === 'string' && typeof s.token === 'string' && typeof s.playerId === 'string';
}

export function loadTabSession(): StoredSession | null {
  const s = read<StoredSession>(tab, TAB_KEY);
  return isSession(s) ? s : null;
}

function loadDeviceSessions(): Record<string, StoredSession> {
  const all = read<Record<string, StoredSession>>(device, DEVICE_KEY) ?? {};
  const now = Date.now();
  const fresh: Record<string, StoredSession> = {};
  for (const [code, s] of Object.entries(all)) {
    if (isSession(s) && now - s.savedAt < DEVICE_TTL_MS) fresh[code] = s;
  }
  return fresh;
}

export function deviceSessionFor(roomCode: string): StoredSession | null {
  return loadDeviceSessions()[roomCode] ?? null;
}

/** 이 기기에서 들어갔던 방들 (최근 것부터). 처음 화면의 "진행 중인 게임으로 돌아가기"에 쓴다. */
export function listDeviceSessions(): StoredSession[] {
  return Object.values(loadDeviceSessions()).sort((a, b) => b.savedAt - a.savedAt);
}

export function saveSession(s: Omit<StoredSession, 'savedAt'>): StoredSession {
  const full: StoredSession = { ...s, savedAt: Date.now() };
  write(tab, TAB_KEY, full);
  const all = loadDeviceSessions();
  all[s.roomCode] = full;
  write(device, DEVICE_KEY, all);
  return full;
}

export function clearSession(roomCode: string): void {
  const t = loadTabSession();
  if (t?.roomCode === roomCode) write(tab, TAB_KEY, null);
  const all = loadDeviceSessions();
  delete all[roomCode];
  write(device, DEVICE_KEY, all);
}

/** 이 탭에서만 자리를 놓는다 (기기 목록은 유지 → 나중에 돌아가기 가능). */
export function clearTabSession(): void {
  write(tab, TAB_KEY, null);
}

export function loadNickname(): string {
  return read<string>(device, NICK_KEY) ?? '';
}

export function saveNickname(nickname: string): void {
  write(device, NICK_KEY, nickname);
}
