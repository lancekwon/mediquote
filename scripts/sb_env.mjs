// .env.local(git 제외)의 값을 process.env로 읽음. DB를 잠근 뒤 스크립트는 SB_KEY(비밀 키)로만 동작.
// 다른 import보다 먼저 불러올 것: import './sb_env.mjs';
import fs from 'node:fs';

try {
  const text = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
