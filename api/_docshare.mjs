// 서류 고정 링크 (2026-11-20 사용자: 영업사원 카톡 보내기와 my. 문서함이 같은 주소)
//   세금계산서·거래명세서마다 quote_shares 행 하나 (doc_ref = 'tax_invoice:<id>' | 'statement:<id>') → my.dwmedi.kr/q/<token>
//   화면은 열 때마다 api/quote.mjs가 DB에서 그림 (사본 html 없음). 파일 이름이 _로 시작해서 Vercel 함수(주소)는 아님
import crypto from 'node:crypto';
import { SUPABASE_URL, SUPABASE_KEY } from './_auth.mjs';

const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
export const DOC_BASE_URL = process.env.QUOTE_BASE_URL || 'https://my.dwmedi.kr';

// list = [{ kind: 'tax_invoice'|'statement', id, title, rep_id? }] → Map(doc_ref → 링크). 없는 건 만들고, 있으면 그대로 (주소 안 바뀜)
export async function ensureDocShares(list) {
  const items = list.filter((x) => x && x.id && (x.kind === 'tax_invoice' || x.kind === 'statement'));
  if (!items.length) return new Map();
  const refOf = (x) => `${x.kind}:${x.id}`;
  const refs = [...new Set(items.map(refOf))];
  const read = async () => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/quote_shares?doc_ref=in.(${refs.map((x) => `"${x}"`).map(encodeURIComponent).join(',')})&select=token,doc_ref`, { headers: H });
    if (!r.ok) throw new Error(`doc share read ${r.status}: ${await r.text()}`);
    return r.json();
  };
  let rows = await read();
  const have = new Set(rows.map((r) => r.doc_ref));
  const missing = items.filter((x, i) => !have.has(refOf(x)) && items.findIndex((y) => refOf(y) === refOf(x)) === i);
  if (missing.length) {
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/quote_shares?on_conflict=doc_ref`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(missing.map((x) => ({
        token: crypto.randomBytes(12).toString('base64url'), kind: x.kind, doc_ref: refOf(x),
        title: String(x.title || '').slice(0, 200) || null, html: '', rep_id: x.rep_id || null,
      }))),
    });
    if (!ins.ok) throw new Error(`doc share insert ${ins.status}: ${await ins.text()}`);
    rows = await read();
  }
  return new Map(rows.map((r) => [r.doc_ref, `${DOC_BASE_URL}/q/${r.token}`]));
}
