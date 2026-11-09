import './sb_env.mjs';
// cash_balance_log.balance_after 재계산 유틸
// - standalone CLI: node scripts/rebuild_balance.mjs [accountId]
// - importable: import { rebuildBalanceAfter } from './scripts/rebuild_balance.mjs'
//
// 매 Clobe 업데이트 저장 스크립트 마지막에 반드시 호출할 것 (국민+하나 통장 모두).

const K = process.env.SB_KEY || 'sb_publishable_L4FVvZBPaNF9BQtoadoPRw_3HeNlPRL';
const B = (process.env.SB_URL || 'https://nbgubiywavozgigiwkpr.supabase.co') + '/rest/v1/';
const H = {
  apikey: K,
  Authorization: 'Bearer ' + K,
  'Content-Type': 'application/json; charset=utf-8',
  Prefer: 'return=minimal',
};
const q = p => fetch(B + encodeURI(p), { headers: { apikey: K, Authorization: 'Bearer ' + K } }).then(r => r.json());

/**
 * 특정 account 또는 전체 활성 account의 balance_after를 opening_balance + 누적 delta로 재계산.
 * cash_balance_log INSERT/UPDATE/DELETE 후 반드시 호출.
 *
 * @param {string | string[] | null} accountIds — null 또는 생략시 모든 활성 통장
 * @returns {Promise<Array<{name:string, final:number, updated:number}>>}
 */
export async function rebuildBalanceAfter(accountIds = null) {
  let accs;
  if (accountIds == null) {
    accs = await q('accounts?select=id,name,opening_balance&is_active=eq.true');
  } else {
    const ids = Array.isArray(accountIds) ? accountIds : [accountIds];
    accs = await q('accounts?select=id,name,opening_balance&id=in.(' + ids.join(',') + ')');
  }
  const results = [];
  for (const a of accs) {
    const log = await q('cash_balance_log?select=id,delta,balance_after&account_id=eq.' + a.id + '&order=log_date.asc,created_at.asc&limit=10000');
    let running = a.opening_balance || 0;
    const updates = [];
    for (const r of log) {
      running += r.delta || 0;
      if (r.balance_after !== running) updates.push({ id: r.id, balance_after: running });
    }
    for (const u of updates) {
      const r = await fetch(B + 'cash_balance_log?id=eq.' + u.id, {
        method: 'PATCH', headers: H,
        body: JSON.stringify({ balance_after: u.balance_after }),
      });
      if (!r.ok) throw new Error(`${a.name} ${u.id} PATCH ${r.status}: ${await r.text()}`);
    }
    results.push({ name: a.name, final: running, updated: updates.length });
  }
  return results;
}

/**
 * Clobe afterBalance vs DB balance_after 최종 검증.
 * 저장 완료 후 반드시 호출. 차이 발견 시 WARNING 반환 (에러는 아님).
 *
 * @param {Array<{accountId:string, clobeFinalBalance:number, label?:string}>} checks
 *   예: [{ accountId: 'a78254e2-...', clobeFinalBalance: 5564065, label: '국민' }]
 * @returns {Promise<Array<{label:string, db:number, clobe:number, diff:number, ok:boolean}>>}
 */
export async function verifyBalanceMatch(checks) {
  const results = [];
  for (const c of checks) {
    const last = await q('cash_balance_log?select=balance_after&account_id=eq.' + c.accountId + '&order=log_date.desc,created_at.desc&limit=1');
    const db = last[0]?.balance_after || 0;
    const diff = db - c.clobeFinalBalance;
    results.push({ label: c.label || c.accountId.slice(0, 8), db, clobe: c.clobeFinalBalance, diff, ok: diff === 0 });
  }
  console.log('\n=== 통장 잔액 검증 (DB vs Clobe) ===');
  for (const r of results) {
    const flag = r.ok ? '✅' : '⚠️';
    console.log(` ${flag} ${r.label}: DB ${r.db.toLocaleString()}원 vs Clobe ${r.clobe.toLocaleString()}원 (차이 ${r.diff.toLocaleString()}원)`);
  }
  if (results.some(r => !r.ok)) {
    console.log('\n⚠️  차이 발견 — 중복/누락 거래 가능성. 다음 체크:');
    console.log('   1) 같은 날짜/금액의 cash_balance_log 2건 (counterparty만 다름) — 중복');
    console.log('   2) Clobe에 있는데 DB에 없는 거래 — 누락');
    console.log('   3) 수동 저장과 통장 임포트 쌍 — 특히 (수동 "병원 입금" entry_type) + (자동 "매출/지급") 패턴');
  }
  return results;
}

// standalone CLI (ESM main detection — Windows/POSIX 호환)
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  const target = process.argv[2] || null;
  const r = await rebuildBalanceAfter(target);
  console.log('=== balance_after 재계산 결과 ===');
  for (const x of r) console.log(' ', x.name, '→ 최종', x.final.toLocaleString() + '원 (', x.updated, '건 수정)');
}
