import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerInfo } from '../src/shared/protocol';
import { startServer, type RunningServer } from '../src/server/app';

let server: RunningServer;
let base: string;
let dir: string;

beforeAll(async () => {
  // 빌드 결과(dist/client)를 흉내 낸 임시 폴더로 서버를 띄운다.
  dir = mkdtempSync(join(tmpdir(), 'rr-http-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>TEST-INDEX</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  mkdirSync(join(dir, 'art', 'models'), { recursive: true });
  mkdirSync(join(dir, 'art', 'textures'), { recursive: true });
  mkdirSync(join(dir, 'vendor', 'basis'), { recursive: true });
  writeFileSync(join(dir, 'art', 'models', 'kit.glb'), Buffer.from('glTF'));
  writeFileSync(join(dir, 'art', 'textures', 't.ktx2'), Buffer.from([0xab, 0x4b, 0x54, 0x58]));
  writeFileSync(join(dir, 'vendor', 'basis', 'basis_transcoder.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  server = await startServer({ port: 0, host: '127.0.0.1', clientDir: dir });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('HTTP: 웹 앱·에셋·초대 링크를 같은 주소에서 제공', () => {
  it('휴대폰에서 /join/방코드 를 바로 열어도 웹 앱(index.html)을 돌려준다', async () => {
    for (const path of ['/', '/join/6QK8', '/room/6QK8', '/lab']) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('TEST-INDEX');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  it('GLB·KTX2·WASM 을 올바른 형식으로 제공하고, 없는 파일은 404', async () => {
    const cases: [string, string][] = [
      ['/art/models/kit.glb', 'model/gltf-binary'],
      ['/art/textures/t.ktx2', 'image/ktx2'],
      ['/vendor/basis/basis_transcoder.wasm', 'application/wasm'],
    ];
    for (const [path, type] of cases) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain(type);
    }
    expect((await fetch(`${base}/art/models/missing.glb`)).status).toBe(404);
  });

  it('빌드 해시가 붙은 파일은 오래 캐시한다', async () => {
    const res = await fetch(`${base}/assets/app-abc123.js`);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('/api/info 는 접속 포트와 사설 IP 목록을 알려 준다', async () => {
    const info = (await (await fetch(`${base}/api/info`)).json()) as ServerInfo;
    expect(info.port).toBe(server.port);
    expect(Array.isArray(info.lanAddresses)).toBe(true);
    for (const a of info.lanAddresses) expect(a.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
