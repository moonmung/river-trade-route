import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STANDARD_BOARD } from '../src/shared/board';
import { BRAG_GAP_MS, CHAT_EMOTES, CHAT_HISTORY, CHAT_MAX_LENGTH, PING_LIMIT } from '../src/shared/constants';
import type { ChatBrag, ChatEmote, ChatMessage, ChatPing, SessionInfo } from '../src/shared/protocol';
import type { GameState } from '../src/shared/rules';
import { normalizeChatText } from '../src/shared/validate';
import { startServer, type RunningServer } from '../src/server/app';
import { CHAT_LIMITS, ChatHub } from '../src/server/chat';
import type { Room, RoomPlayer } from '../src/server/rooms';
import { NAMES, TestClient, startedRoom } from './helpers';

function fakeRoom(): { room: Room; a: RoomPlayer; b: RoomPlayer } {
  const player = (id: string, nickname: string, colorIndex: number): RoomPlayer => ({
    id,
    token: `t-${id}`,
    nickname,
    colorIndex,
    ready: false,
    connected: true,
    socketId: null,
    recent: new Map(),
  });
  const a = player('pa', '강나루', 0);
  const b = player('pb', '버들', 1);
  const room: Room = {
    code: 'TEST',
    hostId: a.id,
    players: [a, b],
    phase: 'lobby',
    game: null,
    gameNumber: 1,
    winPoints: 10,
    handLimit: 7,
    turnSeconds: 60,
    map: { shape: 'hex', arrange: 'golden' },
    resourceCards: 19,
    devCards: 25,
    createdAt: 0,
    touchedAt: 0,
  };
  return { room, a, b };
}

describe('채팅 글 다듬기', () => {
  it('제어 문자와 방향 뒤집기 문자를 빼고 공백을 줄이며 길이를 제한한다', () => {
    expect(normalizeChatText('  안녕\n\n하세요  ')).toBe('안녕 하세요');
    expect(normalizeChatText('a‮b\u0007c')).toBe('abc');
    expect(normalizeChatText('👍🏽 좋아요 👨‍👩‍👧')).toBe('👍🏽 좋아요 👨‍👩‍👧');
    expect(normalizeChatText('   ')).toBeNull();
    expect(normalizeChatText(42)).toBeNull();
    expect(normalizeChatText('가'.repeat(CHAT_MAX_LENGTH))).toHaveLength(CHAT_MAX_LENGTH);
    expect(normalizeChatText('가'.repeat(CHAT_MAX_LENGTH + 1))).toBeNull();
  });
});

describe('ChatHub', () => {
  it('최근 메시지만 보관하고 보낸 사람의 이름·색을 함께 적는다', () => {
    const hub = new ChatHub();
    const { room, a } = fakeRoom();
    let now = 1_000_000;
    for (let i = 0; i < CHAT_HISTORY + 5; i++) {
      now += CHAT_LIMITS.windowMs;
      expect(hub.post(room, a, `글 ${i}`, now).ok).toBe(true);
    }
    const history = hub.history(room);
    expect(history).toHaveLength(CHAT_HISTORY);
    expect(history[0]).toMatchObject({ text: '글 5', from: 'pa', nickname: '강나루', colorIndex: 0 });
    expect(history.at(-1)!.id).toBe(CHAT_HISTORY + 5);
    // 다른 방의 기록과 섞이지 않는다
    expect(hub.history(fakeRoom().room)).toEqual([]);
  });

  it('너무 빠르거나 너무 많이 보내면 막고 사람마다 따로 센다', () => {
    const hub = new ChatHub();
    const { room, a, b } = fakeRoom();
    const t0 = 5_000_000;
    expect(hub.post(room, a, '하나', t0).ok).toBe(true);
    expect(hub.post(room, a, '둘', t0 + 100)).toMatchObject({ ok: false, code: 'CHAT_SLOW' });
    expect(hub.post(room, b, '다른 사람은 괜찮다', t0 + 100).ok).toBe(true);
    let t = t0;
    for (let i = 1; i < CHAT_LIMITS.textPerWindow; i++) {
      t += CHAT_LIMITS.textGapMs;
      expect(hub.post(room, a, `연달아 ${i}`, t).ok).toBe(true);
    }
    t += CHAT_LIMITS.textGapMs;
    expect(hub.post(room, a, '넘침', t)).toMatchObject({ ok: false, code: 'CHAT_SLOW' });
    expect(hub.post(room, a, '시간이 지나면 다시', t0 + CHAT_LIMITS.windowMs + 1).ok).toBe(true);
    expect(hub.post(room, a, '   ', t0 + 60_000)).toMatchObject({ ok: false, code: 'CHAT_EMPTY' });
    expect(hub.post(room, a, 'x'.repeat(CHAT_MAX_LENGTH + 1), t0 + 70_000)).toMatchObject({ ok: false, code: 'CHAT_TOO_LONG' });
  });

  it('이모티콘은 정해진 것만 받고 보관하지 않는다', () => {
    const hub = new ChatHub();
    const { room, a } = fakeRoom();
    expect(hub.emote(room, a, CHAT_EMOTES[0], 1000)).toMatchObject({ ok: true, emote: { from: 'pa', emote: CHAT_EMOTES[0] } });
    expect(hub.emote(room, a, '💩', 5000)).toMatchObject({ ok: false, code: 'CHAT_BAD_EMOTE' });
    expect(hub.emote(room, a, CHAT_EMOTES[1], 1000 + CHAT_LIMITS.emoteGapMs - 1)).toMatchObject({ ok: false, code: 'CHAT_SLOW' });
    expect(hub.history(room)).toEqual([]);
  });

  it('핑은 게임 중인 방의 보드에 있는 자리만 받고 한 사람이 연달아 3번, 그 뒤로는 1초에 한 번씩, 사람마다 따로 센다', () => {
    const hub = new ChatHub();
    const { room, a, b } = fakeRoom();
    const tile = STANDARD_BOARD.tiles[0].id;
    const vertex = STANDARD_BOARD.vertices[0].id;
    const edge = STANDARD_BOARD.edges[0].id;
    expect(hub.ping(room, a, { kind: 'tile', target: tile }, 0)).toMatchObject({ ok: false, code: 'PING_NO_GAME' });
    room.phase = 'game';
    room.game = { tiles: STANDARD_BOARD.tiles } as unknown as GameState;
    for (const bad of [{ kind: 'tile', target: 'ZZ' }, { kind: 'vertex', target: '__proto__' }, { kind: 'road', target: edge }, null, 'x']) {
      expect(hub.ping(room, a, bad, 0)).toMatchObject({ ok: false, code: 'PING_BAD_TARGET' });
    }
    const t0 = 10_000;
    expect(hub.ping(room, a, { kind: 'tile', target: tile }, t0)).toMatchObject({ ok: true, ping: { id: 1, from: 'pa', kind: 'tile', target: tile } });
    expect(hub.ping(room, a, { kind: 'vertex', target: vertex }, t0 + 10)).toMatchObject({ ok: true, ping: { id: 2, kind: 'vertex' } });
    expect(hub.ping(room, a, { kind: 'edge', target: edge }, t0 + 20)).toMatchObject({ ok: true, ping: { id: 3, kind: 'edge' } });
    // 연달아 3번을 쓰면 네 번째는 막힌다 (서버는 지연 차이로 100ms 를 너그럽게 센다)
    expect(hub.ping(room, a, { kind: 'edge', target: edge }, t0 + 30)).toMatchObject({ ok: false, code: 'PING_SLOW' });
    // 다른 사람은 따로 센다
    expect(hub.ping(room, b, { kind: 'edge', target: edge }, t0 + 40)).toMatchObject({ ok: true, ping: { from: 'pb' } });
    // 그 뒤로는 1초에 한 번씩
    const t1 = t0 + 20 + PING_LIMIT.refillMs;
    expect(hub.ping(room, a, { kind: 'tile', target: tile }, t1 - 200)).toMatchObject({ ok: false, code: 'PING_SLOW' });
    expect(hub.ping(room, a, { kind: 'tile', target: tile }, t1)).toMatchObject({ ok: true });
    expect(hub.ping(room, a, { kind: 'tile', target: tile }, t1 + 300)).toMatchObject({ ok: false, code: 'PING_SLOW' });
    expect(hub.ping(room, a, { kind: 'tile', target: tile }, t1 + PING_LIMIT.refillMs)).toMatchObject({ ok: true });
    // 오래 쉬면 다시 연달아 3번까지 모인다 (그 이상은 모이지 않는다)
    const t2 = t1 + 60_000;
    for (let i = 0; i < PING_LIMIT.burst; i++) expect(hub.ping(room, a, { kind: 'tile', target: tile }, t2 + i)).toMatchObject({ ok: true });
    expect(hub.ping(room, a, { kind: 'tile', target: tile }, t2 + 5)).toMatchObject({ ok: false, code: 'PING_SLOW' });
    // 거절된 핑을 연타해도 횟수가 늘지 않는다 (서버의 지연 여유는 쌓이지 않는다)
    for (let i = 1; i <= 20; i++) expect(hub.ping(room, a, { kind: 'tile', target: tile }, t2 + 5 + i * 10)).toMatchObject({ ok: false, code: 'PING_SLOW' });
    expect(hub.history(room)).toEqual([]);
  });

  it('자랑은 게임 중에 지금 가진 달성만, 한 사람이 5초에 한 번 뽐낼 수 있다', () => {
    const hub = new ChatHub();
    const { room, a, b } = fakeRoom();
    expect(hub.brag(room, a, { award: 'longest_road' }, 0)).toMatchObject({ ok: false, code: 'BRAG_NO_GAME' });
    room.phase = 'game';
    room.game = {
      phase: 'playing',
      longestRoad: { holder: 'pa', length: 6 },
      largestArmy: { holder: 'pb', size: 4 },
    } as unknown as GameState;
    for (const bad of [{ award: 'biggest_city' }, null, 'longest_road', { award: '__proto__' }]) {
      expect(hub.brag(room, a, bad, 0)).toMatchObject({ ok: false, code: 'BRAG_BAD' });
    }
    // 남의 달성은 뽐낼 수 없다
    expect(hub.brag(room, a, { award: 'largest_army' }, 0)).toMatchObject({ ok: false, code: 'BRAG_NOT_HOLDER' });
    const t0 = 100_000;
    expect(hub.brag(room, a, { award: 'longest_road' }, t0)).toEqual({ ok: true, brag: { from: 'pa', award: 'longest_road', size: 6, at: t0 } });
    expect(hub.brag(room, a, { award: 'longest_road' }, t0 + 1000)).toMatchObject({ ok: false, code: 'BRAG_SLOW' });
    // 다른 사람은 따로 센다
    expect(hub.brag(room, b, { award: 'largest_army' }, t0 + 1000)).toMatchObject({ ok: true, brag: { from: 'pb', size: 4 } });
    expect(hub.brag(room, a, { award: 'longest_road' }, t0 + BRAG_GAP_MS)).toMatchObject({ ok: true });
    // 게임이 끝나면 자랑하지 않는다
    (room.game as unknown as { phase: string }).phase = 'finished';
    expect(hub.brag(room, a, { award: 'longest_road' }, t0 + BRAG_GAP_MS * 3)).toMatchObject({ ok: false, code: 'BRAG_NO_GAME' });
  });
});

describe('채팅 소켓', () => {
  let server: RunningServer;
  let url: string;

  beforeAll(async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', clientDir: null });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('같은 방 사람에게만 보내고 다시 접속하면 최근 대화를 받는다', async () => {
    const host = new TestClient(url);
    await host.connected();
    const created = await host.emit<SessionInfo>('room:create', { nickname: NAMES[0] });
    if (!created.ok) throw new Error(created.error);
    host.session = created;
    const guest = new TestClient(url);
    await guest.connected();
    const joined = await guest.emit<SessionInfo>('room:join', { code: created.roomCode, nickname: NAMES[1] });
    if (!joined.ok) throw new Error(joined.error);
    guest.session = joined;
    // 다른 방 사람은 받지 않는다
    const stranger = new TestClient(url);
    await stranger.connected();
    expect((await stranger.emit<SessionInfo>('room:create', { nickname: NAMES[2] })).ok).toBe(true);

    const got = guest.waitEvent('chat:message');
    expect(await host.emit('chat:send', { text: '  안녕하세요‮  ' })).toEqual({ ok: true });
    const [msg] = (await got) as [{ code: string; message: ChatMessage }];
    expect(msg.code).toBe(created.roomCode);
    expect(msg.message).toMatchObject({ from: created.playerId, nickname: NAMES[0], text: '안녕하세요' });
    expect((await host.emit('chat:send', { text: '바로 또' })) as { code?: string }).toMatchObject({ ok: false, code: 'CHAT_SLOW' });

    const emoted = guest.waitEvent('chat:emote');
    expect(await host.emit('chat:emote', { emote: CHAT_EMOTES[4] })).toEqual({ ok: true });
    const [em] = (await emoted) as [{ code: string; emote: ChatEmote }];
    expect(em.emote).toMatchObject({ from: created.playerId, emote: CHAT_EMOTES[4] });
    expect(await host.emit('chat:emote', { emote: '<script>' })).toMatchObject({ ok: false });

    // 새로고침: 같은 참가 토큰으로 다시 붙으면 최근 대화가 온다
    guest.close();
    const again = new TestClient(url, { roomCode: created.roomCode, token: joined.token });
    const [history] = (await again.waitEvent('chat:history')) as [{ code: string; messages: ChatMessage[] }];
    expect(history.code).toBe(created.roomCode);
    expect(history.messages.map((m) => m.text)).toEqual(['안녕하세요']);
    expect(stranger.received.some((m) => m.event === 'chat:message' || m.event === 'chat:emote')).toBe(false);
    // 참가 토큰은 채팅 메시지에 실리지 않는다
    const chatPackets = [...again.received, ...host.received].filter((m) => m.event.startsWith('chat:'));
    expect(chatPackets.length).toBeGreaterThan(0);
    for (const m of chatPackets) expect(JSON.stringify(m.args)).not.toContain(created.token);

    // 방에 붙지 않은 연결은 보낼 수 없다
    const loose = new TestClient(url);
    await loose.connected();
    expect(await loose.emit('chat:send', { text: '누구세요' })).toMatchObject({ ok: false });
    for (const c of [host, again, stranger, loose]) c.close();
  });

  it('핑은 같은 방 모두에게 가고 연달아 3번을 넘기면 거절한다', async () => {
    const { clients } = await startedRoom(url, 2);
    const [host, guest] = clients;
    const tile = host.latest!.game!.tiles[0].id;
    const got = guest.waitEvent('chat:ping');
    expect(await host.emit('chat:ping', { kind: 'tile', target: tile })).toEqual({ ok: true });
    const [payload] = (await got) as [{ code: string; ping: ChatPing }];
    expect(payload.ping).toMatchObject({ from: host.id, kind: 'tile', target: tile });
    expect(await host.emit('chat:ping', { kind: 'tile', target: tile })).toEqual({ ok: true });
    expect(await host.emit('chat:ping', { kind: 'tile', target: tile })).toEqual({ ok: true });
    expect(await host.emit('chat:ping', { kind: 'tile', target: tile })).toMatchObject({ ok: false, code: 'PING_SLOW' });
    expect(await guest.emit('chat:ping', { kind: 'vertex', target: 'nowhere' })).toMatchObject({ ok: false, code: 'PING_BAD_TARGET' });
    for (const c of clients) c.close();
  });

  it('자랑은 같은 방 모두에게 가고, 달성을 가지지 않은 사람은 거절한다', async () => {
    const { clients, code } = await startedRoom(url, 2);
    const [host, guest] = clients;
    expect(await host.emit('chat:brag', { award: 'longest_road' })).toMatchObject({ ok: false });
    const room = server.rooms.rooms.get(code)!;
    room.game!.phase = 'playing';
    room.game!.longestRoad = { holder: host.id!, length: 5 };
    const got = guest.waitEvent('chat:brag');
    expect(await host.emit('chat:brag', { award: 'longest_road' })).toEqual({ ok: true });
    const [payload] = (await got) as [{ code: string; brag: ChatBrag }];
    expect(payload.brag).toMatchObject({ from: host.id, award: 'longest_road', size: 5 });
    expect(await host.emit('chat:brag', { award: 'longest_road' })).toMatchObject({ ok: false, code: 'BRAG_SLOW' });
    expect(await guest.emit('chat:brag', { award: 'longest_road' })).toMatchObject({ ok: false, code: 'BRAG_NOT_HOLDER' });
    for (const c of clients) c.close();
  });
});
