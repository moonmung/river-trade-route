// Socket.IO 메시지 처리. 브라우저는 하려는 행동만 보내고, 판정은 모두 서버(RoomManager → rules)가 한다.
import type { Server, Socket } from 'socket.io';
import type {
  AckResult,
  ClientToServerEvents,
  HandshakeAuth,
  ServerToClientEvents,
  SessionInfo,
} from '../shared/protocol';
import { SEAT_CODE_LENGTH, normalizeSeatCode } from '../shared/protocol';
import { isRequestId, normalizeNickname, normalizeRoomCode, parseAction } from '../shared/validate';
import { ChatHub } from './chat';
import { isRoomError, type Room, type RoomManager, type RoomPlayer } from './rooms';
import { buildRoomView } from './view';

interface SocketData {
  roomCode?: string;
  playerId?: string;
}

type IOServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

function safeAck(ack: unknown): (r: AckResult<object>) => void {
  return typeof ack === 'function' ? (r) => (ack as (r: AckResult<object>) => void)(r) : () => {};
}

function fail(error: string, code?: string): AckResult {
  return { ok: false, error, code };
}

export function attachSocketHandlers(io: IOServer, rooms: RoomManager, log: (msg: string) => void): void {
  /** 방 채팅 (방마다 최근 메시지 보관, 도배 방지) */
  const chat = new ChatHub();

  /** 각 참가자에게 그 사람용 화면 정보를 따로 보낸다. 방 전체에 같은 데이터를 뿌리지 않는다. */
  function broadcast(room: Room): void {
    room.touchedAt = Date.now();
    for (const p of room.players) {
      if (p.socketId) io.to(p.socketId).emit('state', buildRoomView(room, p.id));
    }
  }

  function unbind(socket: IOSocket): void {
    if (socket.data.roomCode) socket.leave(socket.data.roomCode);
    socket.data.roomCode = undefined;
    socket.data.playerId = undefined;
  }

  function bind(socket: IOSocket, room: Room, player: RoomPlayer, notify = true): void {
    // 이 소켓이 이미 다른 자리에 붙어 있었다면 그 자리를 먼저 놓는다.
    if (socket.data.roomCode && (socket.data.roomCode !== room.code || socket.data.playerId !== player.id)) {
      releaseSeat(socket);
    }
    // 같은 자리를 쓰던 예전 연결(다른 탭·기기)이 있으면 연결을 넘겨받는다.
    if (player.socketId && player.socketId !== socket.id) {
      const old = io.sockets.sockets.get(player.socketId);
      if (old) {
        unbind(old);
        old.emit('session:replaced');
      }
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    // 새로고침·재접속해도 대화가 보이도록 방에 붙을 때마다 최근 채팅을 보낸다.
    socket.emit('chat:history', { code: room.code, messages: chat.history(room) });
    if (notify) broadcast(room);
  }

  /** 소켓이 붙어 있던 자리를 '연결 끊김' 상태로 바꾼다. */
  function releaseSeat(socket: IOSocket): void {
    const { roomCode, playerId } = socket.data;
    unbind(socket);
    if (!roomCode || !playerId) return;
    const room = rooms.rooms.get(roomCode);
    const player = room?.players.find((p) => p.id === playerId);
    if (room && player && player.socketId === socket.id) {
      player.socketId = null;
      player.connected = false;
      broadcast(room);
    }
  }

  function current(socket: IOSocket): { room: Room; player: RoomPlayer } | null {
    const { roomCode, playerId } = socket.data;
    if (!roomCode || !playerId) return null;
    const room = rooms.rooms.get(roomCode);
    const player = room?.players.find((p) => p.id === playerId);
    if (!room || !player || player.socketId !== socket.id) return null;
    return { room, player };
  }

  function sessionOf(room: Room, player: RoomPlayer): SessionInfo {
    return { roomCode: room.code, playerId: player.id, token: player.token, nickname: player.nickname };
  }

  io.on('connection', (socket: IOSocket) => {
    // 재접속: 연결할 때 보낸 참가 토큰으로 기존 자리를 찾는다.
    const auth = (socket.handshake.auth ?? {}) as HandshakeAuth;
    if (auth.roomCode || auth.token) {
      const code = normalizeRoomCode(auth.roomCode);
      const found = code && typeof auth.token === 'string' ? rooms.authenticate(code, auth.token) : null;
      if (found) {
        bind(socket, found.room, found.player);
        log(`[재접속] ${found.room.code} ${found.player.nickname}`);
      } else {
        socket.emit('session:invalid', {
          reason:
            code && rooms.rooms.has(code)
              ? '이 자리는 다른 기기로 넘어갔습니다. 이 기기에서 이어 하려면 방장에게 자리 넘기기 코드를 받으세요.'
              : '방을 찾을 수 없습니다. 게임이 끝났거나 하루 넘게 쓰지 않아 방이 닫혔을 수 있습니다.',
        });
      }
    }

    socket.on('room:create', (payload, ack) => {
      const reply = safeAck(ack);
      const nickname = normalizeNickname((payload as { nickname?: unknown } | undefined)?.nickname);
      if (!nickname) return reply(fail('닉네임은 1~12자로 입력하세요.'));
      // 혼자 있던 대기실을 두고 새 방을 만들면 이전 대기실은 닫는다 (빈 방이 쌓이지 않게).
      const prev = current(socket);
      if (prev && rooms.closeIfLoneLobby(prev.room, prev.player.id)) unbind(socket);
      const winPoints = (payload as { winPoints?: unknown } | undefined)?.winPoints;
      const res = rooms.create(nickname, winPoints ?? undefined);
      if (isRoomError(res)) return reply(fail(res.error, res.code));
      // 참가 토큰(응답)이 화면 정보보다 먼저 도착하도록 응답 후에 알린다.
      bind(socket, res.room, res.player, false);
      log(`[방 생성] ${res.room.code} 방장 ${nickname}`);
      reply({ ok: true, ...sessionOf(res.room, res.player) });
      broadcast(res.room);
    });

    socket.on('room:peek', (payload, ack) => {
      const reply = safeAck(ack);
      const code = normalizeRoomCode((payload as { code?: unknown } | undefined)?.code);
      if (!code) return reply(fail('방 코드는 4자리입니다.'));
      const info = rooms.peek(code);
      if (!info) return reply(fail('방을 찾을 수 없습니다. 방 코드를 확인하세요.', 'NO_ROOM'));
      reply({ ok: true, ...info });
    });

    // 자리 넘기기: 방장이 끊긴 자리의 일회용 코드를 만들고, 새 기기가 그 코드로 자리를 받는다.
    socket.on('seat:handover', (payload, ack) => {
      const reply = safeAck(ack);
      const cur = current(socket);
      if (!cur) return reply(fail('방에 연결되어 있지 않습니다.'));
      const targetId = (payload as { playerId?: unknown } | undefined)?.playerId;
      if (typeof targetId !== 'string') return reply(fail('잘못된 요청입니다.'));
      const res = rooms.issueHandover(cur.room, cur.player.id, targetId);
      if (isRoomError(res)) return reply(fail(res.error, res.code));
      reply({ ok: true, ...res });
    });

    socket.on('seat:claim', (payload, ack) => {
      const reply = safeAck(ack);
      const p = (payload ?? {}) as { code?: unknown; seatCode?: unknown };
      const code = normalizeRoomCode(p.code);
      if (!code) return reply(fail('방 코드는 4자리입니다.'));
      const seatCode = normalizeSeatCode(p.seatCode);
      if (!seatCode) return reply(fail(`자리 넘기기 코드는 숫자 ${SEAT_CODE_LENGTH}자리입니다.`, 'SEAT_CODE'));
      const prev = current(socket);
      const res = rooms.claimHandover(code, seatCode);
      if (isRoomError(res)) return reply(fail(res.error, res.code));
      if (prev && prev.room.code !== code && rooms.closeIfLoneLobby(prev.room, prev.player.id)) unbind(socket);
      bind(socket, res.room, res.player, false);
      log(`[자리 넘김] ${code} ${res.player.nickname}`);
      reply({ ok: true, ...sessionOf(res.room, res.player) });
      broadcast(res.room);
    });

    socket.on('room:join', (payload, ack) => {
      const reply = safeAck(ack);
      const p = (payload ?? {}) as { code?: unknown; nickname?: unknown };
      const code = normalizeRoomCode(p.code);
      if (!code) return reply(fail('방 코드는 4자리입니다.'));
      const nickname = normalizeNickname(p.nickname);
      if (!nickname) return reply(fail('닉네임은 1~12자로 입력하세요.'));
      const prev = current(socket);
      const res = rooms.join(code, nickname);
      if (isRoomError(res)) return reply(fail(res.error, res.code));
      if (prev && prev.room.code !== code && rooms.closeIfLoneLobby(prev.room, prev.player.id)) unbind(socket);
      bind(socket, res.room, res.player, false);
      log(`[참가] ${code} ${nickname} (${res.room.players.length}명)`);
      reply({ ok: true, ...sessionOf(res.room, res.player) });
      broadcast(res.room);
    });

    socket.on('room:ready', (payload, ack) => {
      const reply = safeAck(ack);
      const cur = current(socket);
      if (!cur) return reply(fail('방에 연결되어 있지 않습니다.'));
      const ready = (payload as { ready?: unknown } | undefined)?.ready;
      if (typeof ready !== 'boolean') return reply(fail('잘못된 요청입니다.'));
      const err = rooms.setReady(cur.room, cur.player.id, ready);
      if (err) return reply(fail(err.error));
      broadcast(cur.room);
      reply({ ok: true });
    });

    socket.on('room:settings', (payload, ack) => {
      const reply = safeAck(ack);
      const cur = current(socket);
      if (!cur) return reply(fail('방에 연결되어 있지 않습니다.'));
      const err = rooms.setWinPoints(cur.room, cur.player.id, (payload as { winPoints?: unknown } | undefined)?.winPoints);
      if (err) return reply(fail(err.error));
      broadcast(cur.room);
      reply({ ok: true });
    });

    socket.on('room:start', (_payload, ack) => {
      const reply = safeAck(ack);
      const cur = current(socket);
      if (!cur) return reply(fail('방에 연결되어 있지 않습니다.'));
      const err = rooms.start(cur.room, cur.player.id);
      if (err) return reply(fail(err.error));
      log(`[시작] ${cur.room.code} ${cur.room.players.length}명`);
      broadcast(cur.room);
      reply({ ok: true });
    });

    socket.on('room:leave', (_payload, ack) => {
      const reply = safeAck(ack);
      const cur = current(socket);
      if (!cur) return reply({ ok: true });
      const err = rooms.leave(cur.room, cur.player.id);
      if (err) return reply(fail(err.error));
      unbind(socket);
      broadcast(cur.room);
      reply({ ok: true });
    });

    socket.on('room:kick', (payload, ack) => {
      const reply = safeAck(ack);
      const cur = current(socket);
      if (!cur) return reply(fail('방에 연결되어 있지 않습니다.'));
      const targetId = (payload as { playerId?: unknown } | undefined)?.playerId;
      if (typeof targetId !== 'string') return reply(fail('잘못된 요청입니다.'));
      const target = cur.room.players.find((p) => p.id === targetId);
      const targetSocketId = target?.socketId ?? null;
      const err = rooms.kick(cur.room, cur.player.id, targetId);
      if (err) return reply(fail(err.error));
      if (targetSocketId) {
        const s = io.sockets.sockets.get(targetSocketId);
        if (s) {
          unbind(s);
          s.emit('kicked');
        }
      }
      broadcast(cur.room);
      reply({ ok: true });
    });

    socket.on('room:rematch', (_payload, ack) => {
      const reply = safeAck(ack);
      const cur = current(socket);
      if (!cur) return reply(fail('방에 연결되어 있지 않습니다.'));
      const err = rooms.rematch(cur.room, cur.player.id);
      if (err) return reply(fail(err.error));
      broadcast(cur.room);
      reply({ ok: true });
    });

    socket.on('game:action', (payload, ack) => {
      const reply = safeAck(ack);
      const cur = current(socket);
      if (!cur) return reply(fail('방에 연결되어 있지 않습니다. 다시 연결되면 시도하세요.'));
      const p = (payload ?? {}) as { requestId?: unknown; action?: unknown };
      const action = parseAction(p.action);
      if (!action || !isRequestId(p.requestId)) return reply(fail('잘못된 요청입니다.', 'BAD_REQUEST'));
      const { result, changed } = rooms.act(cur.room, cur.player.id, p.requestId, action);
      if (changed) broadcast(cur.room);
      reply(result);
    });

    // 채팅은 모두에게 공개되는 내용이라 방 전체(같은 방에 붙은 소켓)에 한 번에 보낸다.
    socket.on('chat:send', (payload, ack) => {
      const reply = safeAck(ack);
      const cur = current(socket);
      if (!cur) return reply(fail('방에 연결되어 있지 않습니다.'));
      const res = chat.post(cur.room, cur.player, (payload as { text?: unknown } | undefined)?.text);
      if (!res.ok) return reply(fail(res.error, res.code));
      io.to(cur.room.code).emit('chat:message', { code: cur.room.code, message: res.message });
      reply({ ok: true });
    });

    socket.on('chat:emote', (payload, ack) => {
      const reply = safeAck(ack);
      const cur = current(socket);
      if (!cur) return reply(fail('방에 연결되어 있지 않습니다.'));
      const res = chat.emote(cur.room, cur.player, (payload as { emote?: unknown } | undefined)?.emote);
      if (!res.ok) return reply(fail(res.error, res.code));
      io.to(cur.room.code).emit('chat:emote', { code: cur.room.code, emote: res.emote });
      reply({ ok: true });
    });

    socket.on('disconnect', () => {
      const { roomCode, playerId } = socket.data;
      if (roomCode && playerId) {
        const room = rooms.rooms.get(roomCode);
        const player = room?.players.find((x) => x.id === playerId);
        if (player && player.socketId === socket.id) log(`[연결 끊김] ${roomCode} ${player.nickname}`);
      }
      releaseSeat(socket);
    });
  });
}
