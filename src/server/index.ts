// 방장 PC에서 실행하는 서버 진입점.
//   npm start      → 빌드된 웹 앱(dist/client)을 제공
//   npm run dev    → Vite 개발 서버를 붙여 실행 (코드 수정 시 자동 반영)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './app';
import { getLanAddresses } from './net';

const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, '../client');
// 진행 상태 저장 위치. src/server(개발)와 dist/server(빌드) 어느 쪽에서 실행해도 프로젝트의 data 폴더가 된다.
const dataDir = path.resolve(process.env.DATA_DIR ?? path.resolve(here, '../../data'));
const dataFile = path.join(dataDir, 'rooms.json');

function timestamp(): string {
  return new Date().toLocaleTimeString('ko-KR', { hour12: false });
}

async function main(): Promise<void> {
  const server = await startServer({
    port,
    host,
    dev,
    clientDir,
    dataFile,
    log: (msg) => console.log(`${timestamp()} ${msg}`),
  });
  const lan = getLanAddresses();
  const lines = [
    '',
    `  데블스랜드 서버가 실행 중입니다${dev ? ' (개발 모드)' : ''}.`,
    '',
    `  이 PC에서 열기:        http://localhost:${server.port}`,
    ...(lan.length
      ? lan.map((a, i) => `  ${i === 0 ? '휴대폰·다른 PC에서 열기:' : '                        '} http://${a.address}:${server.port}   (${a.name})`)
      : ['  같은 네트워크의 IPv4 주소를 찾지 못했습니다. 와이파이 연결을 확인하세요.']),
    '',
    '  접속이 안 되면 Windows 방화벽에서 Node.js 의 "개인 네트워크" 연결을 허용했는지 확인하세요.',
    `  진행 상태는 ${dataFile} 에 저장됩니다. 서버를 다시 켜면 그대로 이어 할 수 있습니다.`,
    ...(server.restored
      ? [`  저장해 둔 방 ${server.restored}개를 되살렸습니다. 참가자는 쓰던 브라우저에서 다시 열면 같은 자리로 돌아옵니다.`]
      : []),
    '  이 창을 닫거나 Ctrl+C 를 누르면 서버가 꺼집니다.',
    '',
  ];
  console.log(lines.join('\n'));

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    console.log('\n서버를 종료합니다. 진행 상태는 저장해 두었습니다.');
    server.flush();
    void server.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Windows 에서 서버 창의 X 를 누르면 SIGHUP, Ctrl+Break 는 SIGBREAK 가 온다.
  process.on('SIGHUP', shutdown);
  if (process.platform === 'win32') process.on('SIGBREAK', shutdown);
  // 그 밖의 이유로 끝날 때도 기다리던 저장을 마저 쓴다.
  process.on('exit', () => server.flush());
}

main().catch((err: unknown) => {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'EADDRINUSE') {
    console.error(`\n포트 ${port} 을(를) 이미 다른 프로그램이 쓰고 있습니다. 실행 중인 서버 창을 닫거나 PORT=3001 처럼 다른 포트로 실행하세요.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
