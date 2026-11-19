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

function timestamp(): string {
  return new Date().toLocaleTimeString('ko-KR', { hour12: false });
}

async function main(): Promise<void> {
  const server = await startServer({
    port,
    host,
    dev,
    clientDir,
    log: (msg) => console.log(`${timestamp()} ${msg}`),
  });
  const lan = getLanAddresses();
  const lines = [
    '',
    `  강줄기 교역로 서버가 실행 중입니다${dev ? ' (개발 모드)' : ''}.`,
    '',
    `  이 PC에서 열기:        http://localhost:${server.port}`,
    ...(lan.length
      ? lan.map((a, i) => `  ${i === 0 ? '휴대폰·다른 PC에서 열기:' : '                        '} http://${a.address}:${server.port}   (${a.name})`)
      : ['  같은 네트워크의 IPv4 주소를 찾지 못했습니다. 와이파이 연결을 확인하세요.']),
    '',
    '  접속이 안 되면 Windows 방화벽에서 Node.js 의 "개인 네트워크" 연결을 허용했는지 확인하세요.',
    '  이 창을 닫거나 Ctrl+C 를 누르면 서버와 진행 중인 게임이 모두 종료됩니다.',
    '',
  ];
  console.log(lines.join('\n'));

  const shutdown = () => {
    console.log('\n서버를 종료합니다.');
    void server.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
