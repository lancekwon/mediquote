// 거래명세서 틀 하나 (2026-11-20 사용자: "원장님한테 PDF로 보내니 실제 서류와 똑같이")
//   관리자 인쇄 PDF(app.jsx 발주 진행 📄 거래명세서) · 영업사원 앱 화면 · 카톡 링크 화면(api/quote.mjs) 모두 이 파일을 씀
//   - 브라우저: index.html이 <script type="module">로 불러 window.dwStatementDoc 에 넣음 (app.jsx는 그걸 부름)
//   - 서버: api/quote.mjs가 import
//   d = { hospital_name, hospital_address, statement_date(납품일자), issue_date(발행일자), supplier, items:[{item_name, model_name, qty, unit_price}], discount_total }
//   opts.scope 없으면 인쇄용 문서 전체, '.dwstmt'면 앱 안에 넣는 조각 (CSS가 앱 화면에 번지지 않게 범위를 붙임)
//   opts.logo / opts.seal = 그림 주소 (앱은 base64, 서버 화면은 /img/statement/*.png — 같은 그림)

export function buildStatementDoc(d, { scope = '', logo = '', seal = '' } = {}) {
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sup = d.supplier || {};
  const company = {
    name: sup.name || '주식회사 대원메디칼', business_no: sup.business_no || '347-81-02449', representative: sup.representative || '성현기',
    address: sup.address || '서울특별시 동대문구 장한로 186, 201호', phone: sup.phone || '', fax: sup.fax || '',
  };
  const account = sup.account || '주식회사 대원메디칼 · 국민은행 450901-01-469947';
  const discount = Number(d.discount_total) || 0;
  let grandTotal = 0;
  const rows = (d.items || []).map((it, i) => {
    const qty = Number(it.qty) || 0;
    const unit = Number(it.unit_price) || 0; // 매출가 = 부가세 포함 단가
    const total = qty * unit;
    grandTotal += total;
    return `<tr>
        <td class="c">${i+1}</td>
        <td>${esc(it.item_name) || '-'}</td>
        <td>${esc(it.model_name)}</td>
        <td class="c">${qty}</td>
        <td class="r">${unit.toLocaleString('ko-KR')}</td>
        <td class="r">${total.toLocaleString('ko-KR')}</td>
      </tr>`;
  }).join('');
  const p = scope ? `${scope} ` : '';
  const css = `${p}*{box-sizing:border-box;margin:0;padding:0;font-family:'Noto Sans KR',sans-serif;}
      ${scope || 'body'}{padding:20mm;font-size:11px;color:#000;${scope ? 'box-sizing:border-box;width:794px;background:#fff;' : ''}}
      ${p}.header-row{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px;font-size:11px;}
      ${p}.title{text-align:center;font-size:32px;font-weight:900;letter-spacing:16px;padding:10px 0;margin-bottom:12px;border-top:3px double #000;border-bottom:3px double #000;}
      ${p}.party-wrap{display:flex;gap:0;margin-bottom:12px;border:1px solid #000;}
      ${p}.party{flex:1;padding:10px 12px;}
      ${p}.party.supplier{border-right:1px solid #000;background:#fafafa;}
      ${p}.party .plabel{font-size:10px;color:#666;font-weight:700;margin-bottom:6px;letter-spacing:2px;}
      ${p}.party .cname{font-size:14px;font-weight:900;margin-bottom:6px;}
      ${p}.header-left{display:flex;flex-direction:column;align-items:flex-start;gap:6px;}
      ${p}.header-left .brand-logo{height:44px;}
      ${p}.header-left .issue{font-size:11px;color:#000;}
      ${p}.info-tbl{width:100%;border-collapse:collapse;table-layout:fixed;margin-top:2px;}
      ${p}.info-tbl td{padding:3px 0;font-size:10.5px;line-height:1.5;color:#222;vertical-align:top;}
      ${p}.info-tbl td.lbl{width:64px;color:#444;font-weight:600;padding-right:8px;white-space:nowrap;}
      ${p}.info-tbl td.val{color:#222;word-break:keep-all;overflow-wrap:break-word;}
      ${p}.items-table{width:100%;border-collapse:collapse;margin-bottom:8px;}
      ${p}.items-table th{border:1px solid #000;background:#e8e8e8;padding:5px 3px;font-size:10px;font-weight:700;text-align:center;}
      ${p}.items-table td{border:1px solid #000;padding:4px 5px;font-size:10px;}
      ${p}.items-table td.c{text-align:center;}${p}.items-table td.r{text-align:right;}
      ${scope ? '' : '@media print{@page{margin:0;size:A4;}body{padding:20mm;}}'}`;
  const body = `
      <div class="header-row">
        <div class="header-left">
          ${logo ? `<img class="brand-logo" src="${logo}" alt="DW"/>` : ''}
          <div class="issue"><strong>발행일자</strong> ${esc(d.issue_date)}</div>
        </div>
        <div>${esc(company.name)} 발행</div>
      </div>
      <div class="title">거 래 명 세 서</div>

      <!-- 공급자 · 공급받는자 (좌우 배치, 라벨-값 테이블 구조) -->
      <div class="party-wrap">
        <div class="party supplier">
          <div class="plabel">공급자</div>
          <div class="cname">${esc(company.name)}</div>
          <table class="info-tbl">
            <tr><td class="lbl">등록번호</td><td class="val">${esc(company.business_no)}</td></tr>
            <tr><td class="lbl">대표자</td><td class="val" style="display:flex;align-items:center;gap:8px;"><span>${esc(company.representative)}</span>${seal ? `<img src="${seal}" alt="인" style="height:34px;width:34px;object-fit:contain;"/>` : ''}</td></tr>
            <tr><td class="lbl">주소</td><td class="val">${esc(company.address)}</td></tr>
            ${company.phone ? `<tr><td class="lbl">전화</td><td class="val">${esc(company.phone)}${company.fax ? ' · 팩스 ' + esc(company.fax) : ''}</td></tr>` : ''}
          </table>
        </div>
        <div class="party receiver">
          <div class="plabel">공급받는자</div>
          <div class="cname">${esc(d.hospital_name || '—')}</div>
          <table class="info-tbl">
            ${d.hospital_address ? `<tr><td class="lbl">주소</td><td class="val">${esc(d.hospital_address)}</td></tr>` : ''}
            <tr><td class="lbl">납품일자</td><td class="val">${esc(d.statement_date)}</td></tr>
          </table>
        </div>
      </div>

      <table class="items-table">
        <thead><tr>
          <th style="width:30px">No</th><th>품목</th><th style="width:150px">모델명</th>
          <th style="width:50px">수량</th><th style="width:110px">단가</th>
          <th style="width:130px">합계금액</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          ${discount > 0 ? `
          <tr><td colspan="5" class="r" style="padding:5px 6px;">소계 <span style="font-weight:400;font-size:10px;color:#666;">(부가세 포함)</span></td><td class="r">${grandTotal.toLocaleString('ko-KR')}</td></tr>
          <tr><td colspan="5" class="r" style="padding:5px 6px;color:#c00;">할인</td><td class="r" style="color:#c00;">-${discount.toLocaleString('ko-KR')}</td></tr>
          ` : ''}
          <tr style="background:#fef9c3;font-weight:700;">
            <td colspan="5" class="r">총 합계 <span style="font-weight:400;font-size:10px;color:#666;">(부가세 포함)</span></td>
            <td class="r">${(grandTotal - discount).toLocaleString('ko-KR')}</td>
          </tr>
        </tfoot>
      </table>
      <div style="margin-top:10px;border:1px solid #000;padding:8px 12px;font-size:11px;background:#fafafa;">
        <div style="font-weight:700;letter-spacing:2px;color:#444;margin-bottom:4px;">입 금 계 좌</div>
        <div style="font-weight:700;">${esc(account)}</div>
      </div>`;
  if (scope) return `<div class="${scope.replace(/^\./, '')}"><style>${css}</style>${body}</div>`;
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>[DW]${esc(d.hospital_name || '—')}_거래명세서_${esc(d.issue_date)}</title>
      <style>${css}</style></head><body>${body}
      </body></html>`;
}

// 한국 날짜 (timestamptz → YYYY-MM-DD)
const kstDate = (ts) => new Date(new Date(ts).getTime() + 9 * 3600e3).toISOString().slice(0, 10);

// 저장된 거래명세서 사본(hospital_statements 행) → 위 틀의 입력.
// 발행일자 = 고른 발행일(issue_date, 2026-11-20~ 계산서 작성일자) → 없으면 마지막으로 뽑은 날(한국 시간)
export function statementDocData(s) {
  return {
    hospital_name: s.hospital_name, hospital_address: s.hospital_address, statement_date: s.statement_date,
    issue_date: s.issue_date || (s.issued_at ? kstDate(s.issued_at) : s.statement_date),
    supplier: s.supplier, items: s.items, discount_total: s.discount_total,
  };
}

// 세금계산서 작성일자 = 국세청 승인번호 앞 8자리 (예: 20261117-10261120-43913661 → 2026-11-17).
// tax_invoices.issue_date는 클로브 발급일이라 수정 재발행이면 다를 수 있음 (아이비: 작성 11/17, 발급 11/20)
export function invoiceWriteDate(t) {
  const m = /^(\d{4})(\d{2})(\d{2})-/.exec(String(t?.clobe_ti_id || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : t?.issue_date || null;
}
