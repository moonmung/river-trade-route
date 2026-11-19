// KTX2 텍스처를 풀어 주는 Basis 트랜스코더를 public/vendor/basis 로 복사한다.
// 런타임에 외부 CDN 없이 방장 PC 서버가 이 파일을 직접 제공한다.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/three/examples/jsm/libs/basis');
const dest = resolve(root, 'public/vendor/basis');

mkdirSync(dest, { recursive: true });
for (const name of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
  const from = resolve(src, name);
  const to = resolve(dest, name);
  if (!existsSync(from)) {
    console.error(`[copy-vendor] ${from} 파일이 없습니다. npm install 을 먼저 실행하세요.`);
    process.exit(1);
  }
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  console.log(`[copy-vendor] ${name} → public/vendor/basis/`);
}
