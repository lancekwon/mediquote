// 카톡으로 보낸 견적서 열기 (GET /q/<token> → /api/quote?t=<token>). 로그인 없이 링크를 아는 사람만 봄.
import { SUPABASE_URL, SUPABASE_KEY } from './_auth.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const page = (message) => `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>견적서</title></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px;font-size:18px">${message}</body></html>`;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // 저장된 HTML 안의 스크립트는 실행되지 않게
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'");

  const token = String(req.query?.t || new URL(req.url || '/', 'http://local').searchParams.get('t') || '');
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) { res.status(404).send(page('견적서를 찾을 수 없습니다.')); return; }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/quote_shares?token=eq.${token}&select=title,html`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    const [row] = await r.json();
    if (!row) { res.status(404).send(page('견적서를 찾을 수 없습니다.')); return; }
    const title = esc(row.title || '의료장비 공급 견적서');
    // A4 폭 그대로 화면에 맞춤 + 카톡 미리보기 제목
    const head = `<head><meta name="viewport" content="width=794"><meta property="og:title" content="${title}"><meta property="og:description" content="대원메디칼 견적서">`;
    res.status(200).send(row.html.replace('<head>', head));
  } catch (e) {
    console.error('[quote]', e);
    res.status(500).send(page('잠시 뒤 다시 열어 주세요.'));
  }
}
