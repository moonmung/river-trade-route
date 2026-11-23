// 각 브라우저에 보낼 화면 정보를 만든다.
// 게임 부분은 shared/gameView.ts 가 만들고, 여기서는 방·자리 정보를 더한다.
import { MIN_PLAYERS } from '../shared/constants';
import { maxPlayersFor } from '../shared/maps';
import { buildGameView } from '../shared/gameView';
import type { RoomView } from '../shared/protocol';
import type { Room } from './rooms';

export { buildGameView, filterEventFor, type ClockInfo } from '../shared/gameView';

export function buildRoomView(room: Room, viewer: string, deadline: number | null = null): RoomView {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    you: viewer,
    players: room.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      colorIndex: p.colorIndex,
      isHost: p.id === room.hostId,
      ready: p.ready,
      connected: p.connected,
    })),
    game: room.game ? buildGameView(room.game, viewer, { turnSeconds: room.turnSeconds, deadline }) : null,
    gameNumber: room.gameNumber,
    minPlayers: MIN_PLAYERS,
    maxPlayers: maxPlayersFor(room.map.shape),
    winPoints: room.winPoints,
    handLimit: room.handLimit,
    turnSeconds: room.turnSeconds,
    map: { ...room.map },
    resourceCards: room.resourceCards,
    devCards: room.devCards,
    unlimited: room.unlimited,
    diceMode: room.diceMode,
  };
}
