import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** 이 설정 파일이 있는 폴더(프로젝트 뿌리) 아래 경로를 감시 제외 패턴으로 바꾼다. 감시는 슬래시 경로로 맞춘다. */
const underRoot = (dir: string) => fileURLToPath(new URL(`./${dir}/`, import.meta.url)).replace(/\\/g, '/') + '**';

// 빌드 결과는 dist/client 에 놓이고, Node 서버(dist/server/index.js)가 같은 주소에서 제공한다.
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // 개발 모드 서버(npm run dev)가 지켜보지 않을 곳. 이 폴더 바로 아래의 .claude(작업 폴더 worktrees)에서 빌드하거나
      // 파일을 고쳐도 3000번에 접속한 화면이 새로고침되지 않게 하고, 빌드 결과(dist)와 저장 파일(data/rooms.json)도 뺀다.
      // '**/.claude/**' 처럼 쓰면 .claude 아래에 있는 작업 폴더가 자기 소스까지 못 보게 되므로 뿌리 기준 경로로 적는다.
      ignored: [underRoot('.claude'), underRoot('dist'), underRoot('data')],
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
