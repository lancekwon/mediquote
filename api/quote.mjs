// 카톡으로 보낸 서류 열기 (GET /q/<token> → /api/quote?t=<token>). 로그인 없이 링크를 아는 사람만 봄.
//   견적서: 보낼 때 저장한 화면 사본(html) 그대로
//   세금계산서·거래명세서 (2026-11-20): 서류마다 고정 링크(doc_ref) — 열 때마다 DB에서 그림 → my. 문서함과 같은 주소
//     세금계산서 = 관리자가 올린 홈택스 PDF를 pdf.js로 그대로, 거래명세서 = 관리자 PDF와 같은 틀(lib/statement_doc.mjs)
//     오른쪽 위 "PDF 저장": 세금계산서는 /q/<token>/pdf(원본 파일), 거래명세서는 화면에서 PDF로 만들어 저장
import { SUPABASE_URL, SUPABASE_KEY } from './_auth.mjs';
import { buildStatementDoc, statementDocData, invoiceWriteDate } from '../lib/statement_doc.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const page = (message) => `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>대원메디칼</title></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px;font-size:18px">${message}</body></html>`;
const KIND_LABEL = { quote: '견적서', statement: '거래명세서', tax_invoice: '세금계산서' };
const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
const HTML2PDF = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
// 저장된 견적서 사본 안의 스크립트는 실행되지 않게
const CSP_STATIC = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'";
// 서류 화면은 우리가 그린 것 — PDF 그리기·만들기 스크립트만 허용
const CSP_DOC = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; worker-src blob: https://cdnjs.cloudflare.com; connect-src 'self' https://cdnjs.cloudflare.com; img-src 'self' https: data: blob:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; base-uri 'none'; form-action 'none'";

async function rest(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
const fileName = (s) => String(s).replace(/[\\/:*?"<>|\r\n]/g, '_');
const ogHead = (title, label) => `<meta name="viewport" content="width=794"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="대원메디칼 ${label}">`;
const BTN_CSS = `.dw-pdf-btn{position:fixed;top:16px;right:16px;z-index:50;background:#facc15;color:#111;font:700 30px/1 'Noto Sans KR',sans-serif;padding:18px 28px;border-radius:14px;border:0;text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.25);cursor:pointer}@media print{.dw-pdf-btn{display:none}}`;

// 서류 고정 링크가 가리키는 서류 (doc_ref) 읽기
async function loadDoc(row) {
  const [kind, id] = String(row.doc_ref || '').split(':');
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) return null;
  if (kind === 'tax_invoice') {
    const [t] = await rest(`tax_invoices?id=eq.${id}&kind=eq.sale&select=id,issue_date,clobe_ti_id,party_name,pdf_path,hospitals(name)`);
    return t && { kind, t, hospital: t.hospitals?.name || t.party_name || '' };
  }
  if (kind === 'statement') {
    const [s] = await rest(`hospital_statements?id=eq.${id}&shared=is.true&select=*`);
    return s && { kind, s, hospital: s.hospital_name || '' };
  }
  return null;
}

function invoicePage(token, doc) {
  const title = `${doc.hospital} 세금계산서`;
  const date = invoiceWriteDate(doc.t) || '';
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">${ogHead(title, '세금계산서')}<title>[DW]${esc(doc.hospital)}_세금계산서_${esc(date)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#fff;font-family:'Noto Sans KR',sans-serif}#pages canvas{display:block;width:794px}#pages canvas+canvas{border-top:1px solid #ccc}.msg{padding:120px 40px;text-align:center;font-size:30px;color:#555}${BTN_CSS}</style></head>
<body><a class="dw-pdf-btn" href="/q/${token}/pdf">PDF 저장</a><div id="pages"><div class="msg">계산서를 여는 중입니다…</div></div>
<script src="${PDFJS}/pdf.min.js"></script>
<script>
(async function () {
  var box = document.getElementById('pages');
  try {
    var lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = '${PDFJS}/pdf.worker.min.js';
    var pdf = await lib.getDocument({ url: '/q/${token}/pdf', isEvalSupported: false }).promise;
    box.innerHTML = '';
    for (var n = 1; n <= pdf.numPages; n++) {
      var page = await pdf.getPage(n);
      var vp = page.getViewport({ scale: 1588 / page.getViewport({ scale: 1 }).width });
      var c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      box.appendChild(c);
      var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    }
  } catch (e) {
    box.innerHTML = '<div class="msg">화면에 바로 열지 못했습니다.<br>오른쪽 위 <b>PDF 저장</b>을 눌러 받아 보세요.</div>';
  }
})();
</script></body></html>`;
}

function statementPage(doc) {
  const data = statementDocData(doc.s);
  const title = `${doc.hospital} 거래명세서`;
  const name = fileName(`[DW]${doc.hospital}_거래명세서_${data.issue_date}.pdf`);
  const body = buildStatementDoc(data, { scope: '.dwstmt', logo: '/img/statement/dw_logo.png', seal: '/img/statement/seal.png' });
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">${ogHead(title, '거래명세서')}<title>[DW]${esc(doc.hospital)}_거래명세서_${esc(data.issue_date)}</title>
<style>body{margin:0;background:#fff}${BTN_CSS}</style></head>
<body><button class="dw-pdf-btn" id="dwPdf" data-html2canvas-ignore="true">PDF 저장</button>${body}
<script src="${HTML2PDF}"></script>
<script>
document.getElementById('dwPdf').addEventListener('click', async function () {
  var b = this; if (b.disabled) return; b.disabled = true; b.textContent = 'PDF 만드는 중…';
  try {
    await window.html2pdf().set({
      margin: 0, filename: ${JSON.stringify(name)},
      image: { type: 'jpeg', quality: 0.95 }, html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', '.header-row', '.party-wrap'] },
    }).from(document.querySelector('.dwstmt')).save();
  } catch (e) { alert('PDF를 만들지 못했습니다. 잠시 뒤 다시 눌러 주세요.'); }
  b.disabled = false; b.textContent = 'PDF 저장';
});
</script></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  const params = new URL(req.url || '/', 'http://local').searchParams;
  const token = String(req.query?.t || params.get('t') || '');
  const wantPdf = String(req.query?.pdf || params.get('pdf') || '') === '1';
  const sendHtml = (status, html, csp) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', csp || CSP_STATIC);
    res.status(status).send(html);
  };
  const notFound = () => sendHtml(404, page('서류를 찾을 수 없습니다.'));
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) { notFound(); return; }
  try {
    const [row] = await rest(`quote_shares?token=eq.${token}&select=title,html,kind,doc_ref,file_bucket,file_path,file_name`);
    if (!row) { notFound(); return; }
    const doc = row.doc_ref ? await loadDoc(row) : null;
    if (row.doc_ref && !doc) { notFound(); return; }

    if (wantPdf) {
      // 세금계산서 = 지금 올라가 있는 원본 PDF (바꿔 올리면 같은 링크에서 새 파일)
      const bucket = doc?.kind === 'tax_invoice' ? 'tax-invoices' : row.file_bucket;
      const path = doc?.kind === 'tax_invoice' ? doc.t.pdf_path : row.file_path;
      if (!bucket || !path) { notFound(); return; }
      const f = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${String(path).split('/').map(encodeURIComponent).join('/')}`, { headers: H });
      if (!f.ok) throw new Error(`storage ${f.status}: ${await f.text()}`);
      const name = fileName(doc?.kind === 'tax_invoice' ? `[DW]${doc.hospital}_세금계산서_${invoiceWriteDate(doc.t)}.pdf` : (row.file_name || `${row.title || '서류'}.pdf`));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.status(200).send(Buffer.from(await f.arrayBuffer()));
      return;
    }

    if (doc?.kind === 'tax_invoice') {
      if (!doc.t.pdf_path) { sendHtml(404, page('세금계산서 PDF가 아직 올라오지 않았습니다.')); return; }
      sendHtml(200, invoicePage(token, doc), CSP_DOC);
      return;
    }
    if (doc?.kind === 'statement') { sendHtml(200, statementPage(doc), CSP_DOC); return; }

    // 견적서 (보낼 때 저장한 사본)
    const label = KIND_LABEL[row.kind] || '견적서';
    const title = row.title || (row.kind === 'quote' ? '의료장비 공급 견적서' : label);
    let html = String(row.html || '').replace('<head>', `<head>${ogHead(title, label)}`);
    if (row.file_path) html = html.replace(/<body([^>]*)>/i, (m) => `${m}<style>${BTN_CSS}</style><a class="dw-pdf-btn" href="/q/${token}/pdf">PDF 저장</a>`);
    sendHtml(200, html);
  } catch (e) {
    console.error('[quote]', e);
    sendHtml(500, page('잠시 뒤 다시 열어 주세요.'));
  }
}
