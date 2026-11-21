// HTTP 서버 하나로 웹 앱, 3D 에셋, Socket.IO 를 모두 제공한다.
import compression from 'compression';
import express from 'express';
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerInfo, ServerToClientEvents } from '../shared/protocol';
import { getLanAddresses } from './net';
import { RoomStore, type PersistOptions } from './persist';
import { RoomManager } from './rooms';
import { attachSocketHandlers } from './socket';

export interface StartOptions {
  port: number;
  host?: string;
  /** true 면 Vite 개발 서버를 미들웨어로 붙인다 (npm run dev). */
  dev?: boolean;
  /** 빌드된 웹 앱 폴더 (dist/client). null 이면 웹 파일을 제공하지 않는다 (테스트용). */
  clientDir?: string | null;
  /** 방과 게임 상태를 저장할 JSON 파일. 주면 시작할 때 되살리고 바뀔 때마다 저장한다. 없으면 메모리에만 둔다 (테스트용). */
  dataFile?: string | null;
  persist?: PersistOptions;
  log?: (msg: string) => void;
}

export interface RunningServer {
  port: number;
  rooms: RoomManager;
  io: Server;
  store: RoomStore | null;
  /** 시작할 때 저장 파일에서 되살린 방 수 */
  restored: number;
  /** 기다리는 저장을 지금 바로 쓴다 (프로세스를 끝내기 직전에 부른다). */
  flush(): void;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
};

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  const app = express();
  app.disable('x-powered-by');
  app.use(compression());

  const httpServer = http.createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    serveClient: false,
    // 개발 모드의 Vite HMR 웹소켓과 같은 포트를 쓰므로, 다른 경로의 업그레이드 요청을 끊지 않는다.
    destroyUpgrade: false,
    // 휴대폰 화면이 꺼지는 등 연결이 끊긴 것을 20초 안팎에 알아챈다.
    pingInterval: 10_000,
    pingTimeout: 10_000,
    maxHttpBufferSize: 64 * 1024,
  });
  const rooms = new RoomManager();
  // 연결을 받기 전에 저장해 둔 방을 되살린다. 브라우저가 저장된 참가 토큰으로 붙으면 같은 자리로 이어진다.
  const store = opts.dataFile ? new RoomStore(rooms, opts.dataFile, { log, ...opts.persist }) : null;
  const restored = store ? store.load() : 0;
  store?.attach();
  attachSocketHandlers(io as never, rooms, log);

  let actualPort = opts.port;
  app.get('/api/info', (_req, res) => {
    const info: ServerInfo = { port: actualPort, lanAddresses: getLanAddresses() };
    res.set('Cache-Control', 'no-store').json(info);
  });

  if (opts.dev) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true, hmr: { server: httpServer } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    httpServer.on('close', () => void vite.close());
  } else if (opts.clientDir) {
    const clientDir = opts.clientDir;
    const indexHtml = path.join(clientDir, 'index.html');
    if (!existsSync(indexHtml)) {
      throw new Error(`${indexHtml} 이 없습니다. 먼저 npm run build 를 실행하세요.`);
    }
    app.use(
      express.static(clientDir, {
        index: false,
        setHeaders(res, filePath) {
          const ext = path.extname(filePath).toLowerCase();
          if (MIME[ext]) res.setHeader('Content-Type', MIME[ext]);
          // Vite 가 만든 파일 이름에는 해시가 붙어 있어 오래 캐시해도 된다. 나머지는 매번 확인한다.
          const rel = path.relative(clientDir, filePath).split(path.sep).join('/');
          res.setHeader('Cache-Control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    // /join/6QK8 같은 주소를 휴대폰에서 바로 열어도 웹 앱이 뜨게 한다.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io')) return next();
      if (path.extname(req.path)) return res.status(404).send('Not found');
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  actualPort = (httpServer.address() as AddressInfo).port;

  return {
    port: actualPort,
    rooms,
    io: io as never,
    store,
    restored,
    flush: () => void store?.flush(),
    close: () =>
      new Promise<void>((resolve) => {
        store?.close();
        rooms.stopAllClocks();
        io.close(() => resolve());
        httpServer.closeAllConnections?.();
      }),
  };
}
