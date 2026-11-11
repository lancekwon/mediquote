import './sb_env.mjs';
// 업데이트 점검 (조회만, 저장 없음) — 입금과 받을 돈, 출금과 줄 돈이 안 맞는 곳을 찾음. 미리보기 전에 실행해서 결과를 같이 보여줄 것
//   node scripts/check_unlinked_deposits.mjs         최근 45일 입출금 + 거래처 잔액
//   node scripts/check_unlinked_deposits.mjs --all   5/30 결산 이후 입출금 전체 + 거래처 잔액

const K = process.env.SB_KEY || 'sb_publishable_L4FVvZBPaNF9BQtoadoPRw_3HeNlPRL';
const B = (process.env.SB_URL || 'https://nbgubiywavozgigiwkpr.supabase.co') + '/rest/v1/';
const PAGE = 1000;
const CUTOFF = '2026-05-29'; // 이 날까지는 결산 이월에 포함

async function all(path) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const r = await fetch(`${B}${encodeURI(path)}&order=id&limit=${PAGE}&offset=${offset}`, { headers: { apikey: K, Authorization: 'Bearer ' + K } });
    if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}
const won = n => Number(n || 0).toLocaleString() + '원';
const kstDate = d => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);

const from = process.argv.includes('--all') ? CUTOFF : kstDate(new Date(Date.now() - 45 * 86400e3));

const [cash, recv, pay, mfrs, sales, outs, purTi] = await Promise.all([
  all(`cash_balance_log?select=id,log_date,delta,counterparty,entry_type,memo&delta=gt.0&log_date=gt.${from}`),
  all('receivable_transactions?select=id,manufacturer_id,tx_type,amount,tx_date,memo,cash_log_id'),
  all('payable_transactions?select=id,cash_log_id&cash_log_id=not.is.null'),
  all('manufacturers?select=id,name,vendor_code,aliases'),
  all(`tax_invoices?select=manufacturer_id,amount&kind=eq.sale&manufacturer_id=not.is.null&issue_date=gt.${CUTOFF}`),
  all(`cash_balance_log?select=id,log_date,delta,counterparty,entry_type,memo&delta=lt.0&log_date=gt.${from}`),
  all(`tax_invoices?select=manufacturer_id&kind=eq.purchase&manufacturer_id=not.is.null&issue_date=gt.${CUTOFF}`),
]);

const recvCash = new Set(recv.map(r => r.cash_log_id).filter(Boolean));
const payCash = new Set(pay.map(p => p.cash_log_id));
const mfrById = new Map(mfrs.map(m => [m.id, m]));
const byDate = (a, b) => String(a.log_date).localeCompare(String(b.log_date));

// 1) 거래 입금인데 수금·환급 어디에도 연결 안 됨 (계좌이체·차입금·이자는 제외)
const notTrade = c => /이체|차입/.test(c.entry_type || '') || /이자/.test(c.counterparty || '');
const unlinked = cash.filter(c => !recvCash.has(c.id) && !payCash.has(c.id) && !notTrade(c)).sort(byDate);
console.log(`\n[1] 입금인데 수금·환급 기록 없음 (${from} 이후): ${unlinked.length}건`);
for (const c of unlinked) console.log(`  ${c.log_date} ${won(c.delta)} ${c.counterparty || '-'} · ${c.entry_type || '분류 없음'} · ${c.memo || ''}`);

// 2) 같은 입금이 수금과 환급 양쪽에 기록됨
const both = cash.filter(c => recvCash.has(c.id) && payCash.has(c.id)).sort(byDate);
console.log(`\n[2] 같은 입금이 수금·환급 양쪽에 기록됨: ${both.length}건`);
for (const c of both) console.log(`  ${c.log_date} ${won(c.delta)} ${c.counterparty || '-'} · ${c.memo || ''}`);

// 3) 없는 거래처로 연결된 수금 기록
const orphans = recv.filter(r => r.manufacturer_id && !mfrById.has(r.manufacturer_id));
console.log(`\n[3] 없는 거래처에 연결된 수금 기록: ${orphans.length}건`);
for (const r of orphans) console.log(`  ${r.tx_date} ${won(r.amount)} · ${r.memo || ''} · id=${r.id}`);

// 4) 거래처 받을 돈 — 화면(거래처원장)과 같은 계산
const due = new Map();
const add = (id, v) => due.set(id, (due.get(id) || 0) + v);
for (const r of recv) if (r.manufacturer_id) add(r.manufacturer_id, (r.tx_type === 'collect' || r.tx_type === 'cancel') ? -Number(r.amount) : Number(r.amount));
for (const t of sales) add(t.manufacturer_id, Number(t.amount));
const open = [...due].filter(([id, v]) => v !== 0 && mfrById.has(id)).sort((a, b) => b[1] - a[1]);
console.log(`\n[4] 거래처 받을 돈 0원 아닌 곳: ${open.length}곳 (마이너스 = 입금이 계산서보다 많음)`);
for (const [id, v] of open) console.log(`  ${mfrById.get(id).vendor_code || '-'} ${mfrById.get(id).name} ${won(v)}`);

// 5) 출금인데 지급 기록 없음 — 거래처에 보낸 돈인데 줄 돈에서 안 빠진 것 (2026-11-10 로얄라인메디케어 6/18 렌탈료 990,000원이 이렇게 빠져 있었음)
//    거래처 이름·별칭이 통장 상대/메모에 들어 있거나, 분류가 지급·매입·비용·잡지출·없음인 출금. 급여·세금·보험·공과금·카드대금·이자 등은 제외
const norm = s => String(s || '').toLowerCase().replace(/\(주\)|（주）|㈜|주식회사|\(유\)|\(의\)|\s|\(.*?\)/g, '');
const purVendors = new Set(purTi.map(t => t.manufacturer_id));
const vendorKeys = mfrs.flatMap(m => {
  let al = [];
  try { al = Array.isArray(m.aliases) ? m.aliases : String(m.aliases || '').trim().startsWith('[') ? JSON.parse(m.aliases) : String(m.aliases || '').split(','); } catch { al = []; }
  return [m.name, ...al].map(norm).filter(k => k.length >= 2).map(k => ({ k, m }));
});
const NOT_VENDOR_TYPE = /급여|잡급|세금|공과|보험|신용카드|차입|loan|이체|수도광열|복리후생/;
const NOT_VENDOR_TEXT = /급여|인건비|상여|퇴직|국세|지방세|소득세|부가세|부가가치세|사회보험|건강보험|통합(산재|고용|연금)|전기료|주차비|카드출금|대출이자|이체수수료|한화생|자동차세|주민세|등록면허세|인지세|문자통지|수수료발급|예비비|수강료/;
const outMiss = outs.filter(c => !payCash.has(c.id) && !recvCash.has(c.id) && !NOT_VENDOR_TYPE.test(c.entry_type || ''))
  .map(c => {
    const text = norm(`${c.counterparty || ''} ${c.memo || ''}`), cp = norm(c.counterparty);
    // 거래처 이름(3자 이상)이 통장 글자에 들어 있거나, 통장 상대 이름이 거래처 이름과 같거나 그 일부(세무법인호연 ↔ 세무법인호연 강북지점, 아성 ↔ 아성)
    const hits = [...new Map(vendorKeys.filter(v => (v.k.length >= 3 && text.includes(v.k)) || (cp && (cp === v.k || (cp.length >= 3 && v.k.includes(cp))))).map(v => [v.m.id, v.m])).values()];
    const typeFlag = !c.entry_type || /지급|매입|expense|잡지출/.test(c.entry_type);
    const opex = /^\[운영비\]/.test(c.memo || '') || NOT_VENDOR_TEXT.test(`${c.counterparty || ''} ${c.memo || ''}`);
    return { c, hits, flag: hits.length > 0 || (typeFlag && !opex) };
  })
  .filter(x => x.flag).sort((a, b) => byDate(a.c, b.c));
console.log(`\n[5] 출금인데 지급 기록 없음 (${from} 이후, 거래처로 보이는 것): ${outMiss.length}건`);
for (const { c, hits } of outMiss) {
  const guess = hits.length ? hits.map(m => `${m.vendor_code || '-'} ${m.name}${purVendors.has(m.id) ? '' : '(매입 계산서 없음)'}`).join(' / ') : '거래처 못 찾음';
  console.log(`  ${c.log_date} ${won(-c.delta)} ${c.counterparty || '-'} · ${c.entry_type || '분류 없음'} · ${c.memo || ''} → ${guess}`);
}
