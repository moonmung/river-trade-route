import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 빌드 결과는 dist/client 에 놓이고, Node 서버(dist/server/index.js)가 같은 주소에서 제공한다.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
