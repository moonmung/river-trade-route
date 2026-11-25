// 브라우저 쪽 연결 관리. 서버가 보낸 화면 정보(RoomView)를 보관하고 React 에 알린다.
import { io, type Socket } from 'socket.io-client';
import type {
  AckResult,
  ClientToServerEvents,
  HandshakeAuth,
  RoomListing,
  RoomPeek,
  RoomSettingsPatch,
  RoomView,
  SeatHandover,
  ServerToClientEvents,
  SessionInfo,
} from '../../shared/protocol';
import type { GameAction } from '../../shared/types';
import { clearSession, clearTabSession, loadTabSession, saveNickname, saveSession, type StoredSession } from './session';

export type ConnState = 'connecting' | 'connected' | 'disconnected';

export interface Interruption {
  kind: 'invalid' | 'replaced' | 'kicked' | 'closed';
  message: string;
  roomCode: string | null;
  /** 연결이 넘어간 자리. "이 화면에서 계속하기"는 정확히 이 자리로만 돌아간다. */
  session?: StoredSession;
}

export interface ClientSnapshot {
  conn: ConnState;
  session: StoredSession | null;
  view: RoomView | null;
  interruption: Interruption | null;
  /** 서버와 마지막으로 연결된 뒤 몇 번째 연결인지 (재접속 감지용) */
  connectCount: number;
}

const ACK_TIMEOUT_MS = 10_000;
const OFFLINE: AckResult = { ok: false, error: '서버와 연결이 끊겨 있습니다. 다시 연결되면 시도하세요.', code: 'OFFLINE' };
const TIMEOUT: AckResult = { ok: false, error: '서버 응답이 없습니다. 와이파이 연결을 확인하세요.', code: 'TIMEOUT' };

type Listener = () => void;

export class GameClient {
  private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private snap: ClientSnapshot;
  private readonly listeners = new Set<Listener>();
  private requestCounter = 0;
  /** 세션 저장보다 먼저 도착한 화면 정보를 잠시 보관한다. */
  private lastState: RoomView | null = null;

  constructor() {
    this.snap = { conn: 'connecting', session: loadTabSession(), view: null, interruption: null, connectCount: 0 };
    this.socket = io({
      autoConnect: false,
      // 연결(재연결)할 때마다 현재 탭의 참가 토큰을 보낸다. 서버는 이것으로 기존 자리를 찾아 준다.
      auth: (cb) => {
        const s = this.snap.session;
        const auth: HandshakeAuth = s ? { roomCode: s.roomCode, token: s.token } : {};
        cb(auth as Record<string, unknown>);
      },
      reconnectionDelay: 400,
      reconnectionDelayMax: 2500,
      timeout: 8000,
    });

    this.socket.on('connect', () => this.set({ conn: 'connected', connectCount: this.snap.connectCount + 1 }));
    this.socket.on('disconnect', (reason) => {
      this.set({ conn: 'disconnected' });
      // 서버가 끊은 경우에는 자동 재연결이 일어나지 않으므로 직접 다시 연결한다.
      if (reason === 'io server disconnect') this.socket.connect();
    });
    this.socket.on('connect_error', () => this.set({ conn: 'disconnected' }));
    this.socket.on('state', (view) => {
      this.lastState = view;
      if (!this.snap.session || view.code !== this.snap.session.roomCode || view.you !== this.snap.session.playerId) return;
      this.set({ view });
    });
    this.socket.on('session:invalid', ({ reason }) => {
      const code = this.snap.session?.roomCode ?? null;
      if (code) clearSession(code);
      this.set({ session: null, view: null, interruption: { kind: 'invalid', message: reason, roomCode: code } });
    });
    this.socket.on('session:replaced', () => {
      const session = this.snap.session ?? undefined;
      clearTabSession();
      this.set({
        session: null,
        view: null,
        interruption: {
          kind: 'replaced',
          message: '다른 탭이나 기기에서 같은 자리로 접속해 연결이 그쪽으로 넘어갔습니다.',
          roomCode: session?.roomCode ?? null,
          session,
        },
      });
    });
    this.socket.on('room:closed', (info?: { by?: 'host' | 'server' }) => {
      const code = this.snap.session?.roomCode ?? null;
      if (code) clearSession(code);
      this.set({
        session: null,
        view: null,
        interruption: {
          kind: 'closed',
          message: info?.by === 'server' ? '서버를 켠 PC에서 이 방을 지웠습니다.' : '방장이 방을 닫았습니다.',
          roomCode: code,
        },
      });
    });
    this.socket.on('kicked', () => {
      const code = this.snap.session?.roomCode ?? null;
      if (code) clearSession(code);
      this.set({
        session: null,
        view: null,
        interruption: { kind: 'kicked', message: '방장이 대기실에서 내보냈습니다.', roomCode: code },
      });
    });

    // 휴대폰 화면을 다시 켜거나 탭으로 돌아오면 재연결 대기 시간을 건너뛰고 바로 붙는다.
    const wake = () => {
      if (document.visibilityState === 'visible' && !this.socket.connected) this.socket.connect();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);

    this.socket.connect();
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): ClientSnapshot => this.snap;

  private set(patch: Partial<ClientSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  private emit<T extends object>(event: keyof ClientToServerEvents, payload: unknown): Promise<AckResult<T>> {
    if (!this.socket.connected) return Promise.resolve(OFFLINE as AckResult<T>);
    return new Promise((resolve) => {
      (this.socket.timeout(ACK_TIMEOUT_MS) as unknown as Socket).emit(event, payload, (err: unknown, res: AckResult<T>) => {
        resolve(err ? (TIMEOUT as AckResult<T>) : res);
      });
    });
  }

  private adopt(info: SessionInfo): void {
    const session = saveSession({ roomCode: info.roomCode, playerId: info.playerId, token: info.token, nickname: info.nickname });
    saveNickname(info.nickname);
    const last = this.lastState;
    const view = last && last.code === info.roomCode && last.you === info.playerId ? last : null;
    this.set({ session, view, interruption: null });
  }

  async createRoom(nickname: string, winPoints?: number): Promise<AckResult<SessionInfo>> {
    const res = await this.emit<SessionInfo>('room:create', { nickname, winPoints });
    if (res.ok) this.adopt(res);
    return res;
  }

  async joinRoom(code: string, nickname: string): Promise<AckResult<SessionInfo>> {
    const res = await this.emit<SessionInfo>('room:join', { code, nickname });
    if (res.ok) this.adopt(res);
    return res;
  }

  peek(code: string): Promise<AckResult<RoomPeek>> {
    return this.emit<RoomPeek>('room:peek', { code });
  }

  /** 서버를 켠 PC 에서만: 남은 방 목록. 다른 기기에서는 서버가 거절한다. */
  listRooms(): Promise<AckResult<{ rooms: RoomListing[] }>> {
    return this.emit<{ rooms: RoomListing[] }>('rooms:list', {});
  }

  /** 서버를 켠 PC 에서만: 고른 방들을 지운다. 이 기기에 남아 있던 그 방의 참가 토큰도 지운다. */
  async removeRooms(codes: string[]): Promise<AckResult<{ removed: string[] }>> {
    const res = await this.emit<{ removed: string[] }>('rooms:remove', { codes });
    if (res.ok) {
      for (const code of res.removed) clearSession(code);
      // 내가 들어가 있던 방을 지웠으면 '방이 닫혔다'는 안내는 띄우지 않는다 (내가 지운 것이므로).
      const it = this.snap.interruption;
      if (it?.roomCode && res.removed.includes(it.roomCode)) this.set({ interruption: null });
    }
    return res;
  }

  /** 방장: 연결이 끊긴 자리를 다른 기기로 넘길 일회용 코드를 받는다. */
  handover(playerId: string): Promise<AckResult<SeatHandover>> {
    return this.emit<SeatHandover>('seat:handover', { playerId });
  }

  /** 새 기기: 방장에게 받은 코드로 그 자리를 넘겨받는다. */
  async claimSeat(code: string, seatCode: string): Promise<AckResult<SessionInfo>> {
    let res = await this.emit<SessionInfo>('seat:claim', { code, seatCode });
    // QR 로 열자마자 보내면 첫 연결이 자리를 잡는 사이에 끊겨 응답을 못 받을 수 있다. 다시 연결되면 한 번 더 보낸다.
    for (let attempt = 0; attempt < 2 && !res.ok && (res.code === 'TIMEOUT' || res.code === 'OFFLINE'); attempt++) {
      if (!(await this.waitConnected(10_000))) break;
      res = await this.emit<SessionInfo>('seat:claim', { code, seatCode });
    }
    if (res.ok) this.adopt(res);
    return res;
  }

  /** 저장된 참가 토큰으로 자리를 되찾는다. 연결을 새로 맺으면서 토큰을 보낸다. */
  resume(session: StoredSession): void {
    saveSession(session);
    this.set({ session, view: null, interruption: null });
    this.socket.disconnect();
    this.socket.connect();
  }

  clearInterruption(): void {
    this.set({ interruption: null });
  }

  setReady(ready: boolean): Promise<AckResult> {
    return this.emit('room:ready', { ready });
  }

  /** 대기실에서 내 색 바꾸기 */
  setColor(colorIndex: number): Promise<AckResult> {
    return this.emit('room:color', { colorIndex });
  }

  /** 게임 중 자리 비움(자동): 켜 두면 서버가 내 대신 둔다 */
  setAuto(on: boolean): Promise<AckResult> {
    return this.emit('room:auto', { on });
  }

  setWinPoints(winPoints: number): Promise<AckResult> {
    return this.setSettings({ winPoints });
  }

  /** 방장: 대기실에서 승리 점수·자원 보유 한도·차례 시간을 바꾼다 */
  setSettings(patch: RoomSettingsPatch): Promise<AckResult> {
    return this.emit('room:settings', patch);
  }

  start(): Promise<AckResult> {
    return this.emit('room:start', {});
  }

  rematch(): Promise<AckResult> {
    return this.emit('room:rematch', {});
  }

  kick(playerId: string): Promise<AckResult> {
    return this.emit('room:kick', { playerId });
  }

  /** 방장이 방을 닫는다. 다른 사람들은 'room:closed' 를 받고 처음 화면 안내로 넘어간다. */
  async close(): Promise<AckResult> {
    const code = this.snap.session?.roomCode;
    const res = await this.emit('room:close', {});
    if (res.ok && code) {
      clearSession(code);
      this.set({ session: null, view: null });
    }
    return res;
  }

  async leave(): Promise<AckResult> {
    const code = this.snap.session?.roomCode;
    const res = await this.emit('room:leave', {});
    if (res.ok && code) {
      clearSession(code);
      this.set({ session: null, view: null });
    }
    return res;
  }

  /** 이 탭에서 방 화면을 벗어난다. 자리는 서버에 남아 있어 나중에 돌아올 수 있다. */
  detach(): void {
    clearTabSession();
    this.set({ session: null, view: null });
    this.socket.disconnect();
    this.socket.connect();
  }

  async act(action: GameAction): Promise<AckResult> {
    this.requestCounter += 1;
    const requestId = `${Date.now().toString(36)}-${this.requestCounter}-${Math.random().toString(36).slice(2, 8)}`;
    let res = await this.emit('game:action', { requestId, action });
    // 응답이 늦게 오거나 연결이 잠깐 끊긴 경우(휴대폰 화면 꺼짐, 와이파이 끊김):
    // 같은 요청 ID로 다시 보낸다. 서버는 같은 ID를 한 번만 처리하고 처음 결과를 돌려주므로
    // 이미 반영된 행동(예: 시장 교환)이 두 번 반영되지 않는다.
    for (let attempt = 0; attempt < 2 && !res.ok && res.code === 'TIMEOUT'; attempt++) {
      if (!(await this.waitConnected(10_000))) break;
      res = await this.emit('game:action', { requestId, action });
    }
    return res;
  }

  /** 방 채팅 보내기 (서버가 길이·간격을 다시 확인한다) */
  sendChat(text: string): Promise<AckResult> {
    return this.emit('chat:send', { text });
  }

  sendEmote(emote: string): Promise<AckResult> {
    return this.emit('chat:emote', { emote });
  }

  sendPing(kind: 'tile' | 'vertex' | 'edge', target: string): Promise<AckResult> {
    return this.emit('chat:ping', { kind, target });
  }

  sendBrag(award: 'longest_road' | 'largest_army'): Promise<AckResult> {
    return this.emit('chat:brag', { award });
  }

  /** 화면 정보(state)와 따로 오는 서버 메시지 (채팅, 이모티콘, 핑, 자랑) */
  onServer<E extends 'chat:history' | 'chat:message' | 'chat:emote' | 'chat:ping' | 'chat:brag'>(event: E, fn: ServerToClientEvents[E]): () => void {
    const socket = this.socket as unknown as { on: (e: string, f: unknown) => void; off: (e: string, f: unknown) => void };
    socket.on(event, fn);
    return () => socket.off(event, fn);
  }

  private waitConnected(ms: number): Promise<boolean> {
    if (this.socket.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onConnect = () => {
        window.clearTimeout(timer);
        resolve(true);
      };
      const timer = window.setTimeout(() => {
        this.socket.off('connect', onConnect);
        resolve(false);
      }, ms);
      this.socket.once('connect', onConnect);
    });
  }
}

export const client = new GameClient();
// 테스트·디버깅용 핸들. 서버가 모든 요청을 다시 판정하므로 이것으로 할 수 있는 일은 화면 버튼과 같다.
(window as unknown as { __rrClient?: GameClient }).__rrClient = client;
