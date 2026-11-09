import './sb_env.mjs';
// 업데이트 점검 (조회만, 저장 없음) — 입금과 받을 돈이 안 맞는 곳을 찾음. 미리보기 전에 실행해서 결과를 같이 보여줄 것
//   node scripts/check_unlinked_deposits.mjs         최근 45일 입금 + 거래처 잔액
//   node scripts/check_unlinked_deposits.mjs --all   5/30 결산 이후 입금 전체 + 거래처 잔액

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

const [cash, recv, pay, mfrs, sales] = await Promise.all([
  all(`cash_balance_log?select=id,log_date,delta,counterparty,entry_type,memo&delta=gt.0&log_date=gt.${from}`),
  all('receivable_transactions?select=id,manufacturer_id,tx_type,amount,tx_date,memo,cash_log_id'),
  all('payable_transactions?select=id,cash_log_id&cash_log_id=not.is.null'),
  all('manufacturers?select=id,name,vendor_code'),
  all(`tax_invoices?select=manufacturer_id,amount&kind=eq.sale&manufacturer_id=not.is.null&issue_date=gt.${CUTOFF}`),
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
