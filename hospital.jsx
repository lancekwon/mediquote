// 병원 포털 (hospital.html) — 빌드: npx esbuild hospital.jsx --outfile=hospital.js --loader:.jsx=jsx --minify
// 데이터는 /api/portal 에서만 받음 (토큰+접속코드 확인, 금액 없음). 이 파일에는 DB 키가 없음.
const { useState, useEffect, useMemo, useCallback } = React;

const API = '/api/portal';
const token = new URLSearchParams(window.location.search).get('token') || '';
const PIN_KEY = 'dwportal:' + token;

async function call(action, payload = {}) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, token, ...payload }) });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(j.error || '잠시 후 다시 시도해 주세요.'); e.status = r.status; throw e; }
  return j;
}
const storage = {
  get() { try { return sessionStorage.getItem(PIN_KEY) || ''; } catch { return ''; } },
  set(v) { try { sessionStorage.setItem(PIN_KEY, v); } catch {} },
  clear() { try { sessionStorage.removeItem(PIN_KEY); } catch {} },
};

const Ti = ({ n, s = 16, c, style }) => <i className={'ti ti-' + n} style={{ fontSize: s, color: c, ...style }} aria-hidden="true" />;
const fmtDate = (d) => (d ? String(d).slice(0, 10).replace(/-/g, '.') : '—');
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const CAT_ICON = {
  '영상진단장비': 'scan', '물리치료/재활장비': 'activity-heartbeat', '멸균/소독장비': 'flask', '수술실/병원가구': 'armchair',
  '병상/침대류': 'bed', '온열/냉각기기': 'temperature', '환자모니터링장비': 'heart-rate-monitor', '검사/측정장비': 'microscope',
  '수술장비': 'scissors', '수술기구': 'scissors', '수술기구/소모품': 'scissors', '내시경장비': 'camera', '치료장비': 'first-aid-kit',
  '응급의료기': 'emergency-bed', '진료가구': 'armchair',
};
const catIcon = (c) => CAT_ICON[c] || 'box';

const STATE = {
  delivered: { label: '납품 완료', bg: '#e8f4ed', text: '#1d6e3b', dot: '#2a8a4f' },
  ordered: { label: '주문 접수', bg: '#e6effb', text: '#0952b2', dot: '#0952b2' },
  service: { label: '점검·수리 접수', bg: '#fbf3e0', text: '#8a5a0c', dot: '#b07911' },
};
const eqState = (e) => (e.openService ? STATE.service : STATE[e.state] || STATE.delivered);
const SVC_STATE = {
  '접수': { bg: '#fbf3e0', text: '#8a5a0c' }, '처리중': { bg: '#e6effb', text: '#0952b2' }, '완료': { bg: '#e8f4ed', text: '#1d6e3b' },
  '대기': { bg: '#fbf3e0', text: '#8a5a0c' }, '보류': { bg: '#f0f2f5', text: '#6a6f77' },
};
const Badge = ({ st, children }) => (
  <span className="badge" style={{ background: st.bg, color: st.text }}>{children}</span>
);

function Thumb({ e, size = 56 }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="thumb" style={{ width: size, height: size }}>
      {e.image && !broken
        ? <img src={e.image} alt={e.name} loading="lazy" onError={() => setBroken(true)} />
        : <Ti n={catIcon(e.category)} s={Math.round(size * 0.42)} c="#9aa0a8" />}
    </div>
  );
}

/* ── 접속 화면 ───────────────────────────────── */
function Gate({ children }) {
  return (
    <div className="gate">
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div className="cap">Daewon Medical</div>
          <div className="serif" style={{ fontSize: 26, fontWeight: 600, marginTop: 8 }}>병원 포털</div>
        </div>
        {children}
      </div>
    </div>
  );
}

function PinScreen({ onLogin, error, busy }) {
  const [pin, setPin] = useState('');
  return (
    <Gate>
      <form className="card" style={{ padding: 28 }} onSubmit={(e) => { e.preventDefault(); if (pin.trim()) onLogin(pin.trim()); }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>접속 코드 입력</div>
        <div className="muted" style={{ marginTop: 4, marginBottom: 18 }}>담당 영업사원에게 받은 접속 코드를 입력해 주세요.</div>
        <input className="input" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="접속 코드" autoFocus
          inputMode="numeric" autoComplete="one-time-code" style={{ textAlign: 'center', letterSpacing: 3, fontSize: 16 }} />
        {error && <div className="alert-danger" style={{ marginTop: 12 }}>{error}</div>}
        <button className="btn-primary" type="submit" disabled={busy || !pin.trim()} style={{ width: '100%', marginTop: 14, padding: 13 }}>
          {busy ? '확인 중…' : '입장하기'}
        </button>
      </form>
    </Gate>
  );
}

/* ── 헤더 ───────────────────────────────── */
const MENU = [
  { key: 'home', label: '홈' },
  { key: 'equipment', label: '장비' },
  { key: 'service', label: '점검·수리' },
  { key: 'reorder', label: '재주문' },
  { key: 'docs', label: '문서함' },
];
function TopHeader({ page, onNav, data }) {
  const navKey = page === 'detail' ? 'equipment' : page;
  return (
    <div className="topbar">
      <div className="topbar-in">
        <div className="brand" onClick={() => onNav('home')}>
          <div className="brand-mark">DW</div>
          <div style={{ minWidth: 0 }}>
            <div className="brand-hosp">{data.hospital.name}</div>
            <div className="cap" style={{ fontSize: 9, letterSpacing: 1.5 }}>Daewon Medical</div>
          </div>
        </div>
        <div className="contact">
          {data.rep && (
            <div className="rep">
              <div className="rep-avatar">{data.rep.name.slice(0, 1)}</div>
              <div>
                <div className="cap" style={{ fontSize: 9, letterSpacing: 1 }}>Sales</div>
                <div style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.3 }}>{data.rep.name}</div>
              </div>
            </div>
          )}
          <a className="icon-btn" href={'tel:' + data.company.phone.replace(/-/g, '')} title={`${data.company.name} 대표번호 ${data.company.phone}`}>
            <Ti n="phone" s={15} />
          </a>
        </div>
      </div>
      <div className="menu">
        {MENU.map((m) => (
          <span key={m.key} className={'nav-tab' + (navKey === m.key ? ' active' : '')} onClick={() => onNav(m.key)}>{m.label}</span>
        ))}
      </div>
    </div>
  );
}

/* ── 홈 ───────────────────────────────── */
const BANNERS = [
  { img: '/img/banner/banner_1_newmyo.png', alt: 'NEWMYO III · 3 IN 1 의료용 조합자극기' },
  { img: '/img/banner/banner_2_carerush.png', alt: '케어 러쉬 · 피부질환 전용 레이저 조사기' },
];
function Home({ data, go }) {
  const [bi, setBi] = useState(0);
  useEffect(() => { const t = setInterval(() => setBi((i) => (i + 1) % BANNERS.length), 5000); return () => clearInterval(t); }, []);
  const d = new Date(data.today + 'T00:00:00');
  const contact = data.hospital.contact || '';
  const greet = /원장/.test(contact) ? `${contact}님` : '원장님';
  const openSvc = data.services.filter((s) => s.status !== '완료');
  const quick = data.reorder.filter((r) => r.consumable).slice(0, 6);
  return (
    <div className="page">
      <div style={{ marginBottom: 26 }}>
        <div className="cap">{fmtDate(data.today)} · {DOW[d.getDay()]}</div>
        <div className="serif h1" style={{ marginTop: 8 }}>{greet}, 안녕하세요.</div>
        <div className="muted" style={{ marginTop: 4 }}>{data.hospital.name} · 대원메디칼과 함께한 장비 {data.equipment.length}종</div>
      </div>

      <div className="banner">
        {BANNERS.map((b, i) => <img key={i} src={b.img} alt={b.alt} style={{ display: i === bi ? 'block' : 'none' }} />)}
        <div className="dots">
          {BANNERS.map((_, i) => <span key={i} onClick={() => setBi(i)} className={'dot' + (i === bi ? ' on' : '')} />)}
        </div>
      </div>

      {openSvc.length > 0 && (
        <div className="notice" onClick={() => go('service')}>
          <Ti n="tool" s={15} /> 점검·수리 {openSvc.length}건 진행 중 — {openSvc[0].equipment || '장비'} {openSvc[0].status}
        </div>
      )}

      <div className="sec-head">
        <div className="cap">My equipment</div>
        {data.equipment.length > 0 && <span className="link" onClick={() => go('equipment')}>{data.equipment.length}종 전체 보기</span>}
      </div>
      {data.equipment.length === 0 ? (
        <div className="card empty">아직 등록된 장비가 없습니다.</div>
      ) : (
        <div className="grid3" style={{ marginBottom: 28 }}>
          {data.equipment.slice(0, 3).map((e) => {
            const s = eqState(e);
            return (
              <div key={e.key} className="card eq-card" onClick={() => go('detail', e.key)}>
                <div className="eq-img">{e.image ? <img src={e.image} alt={e.name} loading="lazy" /> : <Ti n={catIcon(e.category)} s={40} c="#c4c8ce" />}</div>
                <div className="eq-name">{e.name}</div>
                <div className="sub" style={{ margin: '3px 0 10px' }}>{[e.model, e.category].filter(Boolean).join(' · ') || '—'}</div>
                <div className="state" style={{ color: s.text }}><span className="sdot" style={{ background: s.dot }} />{s.label}</div>
              </div>
            );
          })}
        </div>
      )}

      {quick.length > 0 && (
        <div className="card" style={{ padding: '20px 22px', marginBottom: 28 }}>
          <div className="sec-head" style={{ marginBottom: 12 }}>
            <div>
              <div className="cap" style={{ marginBottom: 4 }}>Reorder</div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>자주 쓰는 소모품 다시 주문</div>
            </div>
            <span className="sub">이전 주문 기준</span>
          </div>
          <div className="chips">
            {quick.map((r) => <span key={r.key} className="chip" onClick={() => go('reorder', r.key)}>{r.name}</span>)}
            <span className="chip chip-on" onClick={() => go('reorder')}>재주문 하기</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── 장비 목록 ───────────────────────────────── */
function EquipmentList({ data, go }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('전체');
  const cats = useMemo(() => {
    const m = new Map();
    data.equipment.forEach((e) => { const c = e.category || '기타'; m.set(c, (m.get(c) || 0) + 1); });
    return [['전체', data.equipment.length], ...[...m.entries()].sort((a, b) => b[1] - a[1])];
  }, [data.equipment]);
  const list = data.equipment.filter((e) => {
    if (cat !== '전체' && (e.category || '기타') !== cat) return false;
    const s = q.trim().toLowerCase();
    return !s || `${e.name} ${e.model} ${e.category || ''} ${e.maker || ''}`.toLowerCase().includes(s);
  });
  return (
    <div className="page">
      <div className="sec-head" style={{ marginBottom: 8 }}>
        <div className="cap">My equipment</div>
        <div className="sub">총 {data.equipment.length}종</div>
      </div>
      <div className="serif h2" style={{ marginBottom: 22 }}>대원메디칼과 함께한 장비입니다.</div>
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="장비 · 모델 · 분류 검색" style={{ marginBottom: 12 }} />
      <div className="chips" style={{ marginBottom: 18 }}>
        {cats.map(([c, n]) => (
          <span key={c} className={'chip' + (cat === c ? ' chip-on' : '')} onClick={() => setCat(c)}>{c} <span style={{ opacity: 0.7, marginLeft: 3 }}>{n}</span></span>
        ))}
      </div>
      <div className="card" style={{ padding: '4px 18px' }}>
        {list.length === 0 && <div className="empty" style={{ border: 0 }}>검색 결과가 없습니다.</div>}
        {list.map((e) => {
          const s = eqState(e);
          return (
            <div key={e.key} className="row" onClick={() => go('detail', e.key)}>
              <Thumb e={e} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row-title">{e.name}</div>
                <div className="sub" style={{ marginTop: 4 }}>{[e.model, e.category, `${e.qty}개`, fmtDate(e.lastDate)].filter(Boolean).join(' · ')}</div>
              </div>
              <Badge st={s}>{s.label}</Badge>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── 장비 상세 ───────────────────────────────── */
function EquipmentDetail({ data, id, go }) {
  const e = data.equipment.find((x) => x.key === id);
  if (!e) return <div className="page"><span className="link" onClick={() => go('equipment')}>← 장비 목록</span></div>;
  const s = eqState(e);
  const meta = [
    ['수량', `${e.qty}개`],
    [e.state === 'ordered' ? '주문일' : '처음 도입', fmtDate(e.firstDate)],
    ...(e.lastDate !== e.firstDate ? [['최근 주문·납품', fmtDate(e.lastDate)]] : []),
    ['구매 횟수', `${e.purchases}회`],
    ...(e.maker ? [['제조사', e.maker]] : []),
  ];
  return (
    <div className="page">
      <div className="link" style={{ marginBottom: 18, color: '#6a6f77' }} onClick={() => go('equipment')}>← 내 장비{e.category ? ` · ${e.category}` : ''}</div>
      <div style={{ marginBottom: 22 }}>
        <div className="cap">{[e.maker, e.category].filter(Boolean).join(' · ') || 'Equipment'}</div>
        <div className="serif h1" style={{ marginTop: 8, lineHeight: 1.25 }}>{e.name}</div>
        {e.model && <div className="muted" style={{ marginTop: 8 }}>{e.model}</div>}
      </div>
      <div className="grid2" style={{ marginBottom: 18 }}>
        <div className={'card detail-img' + (e.image ? '' : ' noimg')}>
          {e.image ? <img src={e.image} alt={e.name} /> : <Ti n={catIcon(e.category)} s={72} c="#c4c8ce" />}
        </div>
        <div className="card" style={{ padding: '18px 20px' }}>
          <div className="cap" style={{ marginBottom: 6 }}>Status</div>
          <div className="state" style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}><span className="sdot" style={{ background: s.dot, width: 7, height: 7 }} />{s.label}</div>
          {meta.map(([l, v], i) => (
            <div key={l} className="meta-row" style={{ borderBottom: i === meta.length - 1 ? 0 : undefined }}>
              <span style={{ color: '#8a8f97' }}>{l}</span><span style={{ fontWeight: 500, textAlign: 'right' }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="grid2 tight" style={{ marginBottom: 30 }}>
        <button className="btn-primary" onClick={() => go('service', e.key)}>점검·수리 신청</button>
        <button className="btn-secondary" onClick={() => go('reorder', e.key)}>같은 품목 다시 주문</button>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div className="cap">History</div>
        <div className="serif h3" style={{ marginTop: 4 }}>이력</div>
      </div>
      <div className="card" style={{ padding: '20px 22px' }}>
        {e.timeline.map((t, i) => (
          <div key={i} style={{ display: 'flex', gap: 16 }}>
            <div style={{ width: 12, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ width: 9, height: 9, borderRadius: '50%', marginTop: 5, background: /점검/.test(t.title) ? '#b07911' : /주문 접수/.test(t.title) ? '#0952b2' : '#2a8a4f' }} />
              {i < e.timeline.length - 1 && <div style={{ width: 1, flex: 1, background: '#ececef', marginTop: 5 }} />}
            </div>
            <div style={{ flex: 1, paddingBottom: i === e.timeline.length - 1 ? 0 : 18 }}>
              <div className="cap" style={{ fontSize: 10, letterSpacing: 1.5 }}>{fmtDate(t.date)}</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{t.title}</div>
              {t.detail && <div className="muted" style={{ marginTop: 3 }}>{t.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 점검·수리 ───────────────────────────────── */
function Service({ data, preset, reload, pin }) {
  const pre = data.equipment.find((e) => e.key === preset);
  const [eqKey, setEqKey] = useState(pre ? pre.key : '');
  const [custom, setCustom] = useState('');
  const [issue, setIssue] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const submit = async () => {
    const eq = data.equipment.find((e) => e.key === eqKey);
    if (!issue.trim()) { setMsg({ err: '증상이나 요청 내용을 적어 주세요.' }); return; }
    setBusy(true); setMsg(null);
    try {
      await call('service', { pin, equipment_name: eq ? eq.name : custom.trim(), model_name: eq ? eq.model : '', issue: issue.trim(), contact: contact.trim() });
      setIssue(''); setCustom(''); setContact('');
      setMsg({ ok: '접수되었습니다. 담당자가 확인 후 연락드리겠습니다.' });
      reload();
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };
  return (
    <div className="page">
      <div className="cap">Service</div>
      <div className="serif h2" style={{ marginTop: 8, marginBottom: 6 }}>점검·수리 신청</div>
      <div className="muted" style={{ marginBottom: 22 }}>장비 이상이나 정기 점검이 필요하면 남겨 주세요. 담당자가 확인 후 연락드립니다.</div>
      <div className="card" style={{ padding: 22, marginBottom: 28 }}>
        <label className="label">장비</label>
        <select className="input" value={eqKey} onChange={(e) => setEqKey(e.target.value)}>
          <option value="">직접 입력 / 목록에 없음</option>
          {data.equipment.map((e) => <option key={e.key} value={e.key}>{e.name}{e.model ? ` (${e.model})` : ''}</option>)}
        </select>
        {!eqKey && <input className="input" style={{ marginTop: 8 }} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="장비 이름" />}
        <label className="label" style={{ marginTop: 16 }}>증상 · 요청 내용 *</label>
        <textarea className="input" rows={4} value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="어떤 문제가 있는지 적어 주세요. (예: 전원이 켜지지 않음, 정기 점검 요청)" />
        <label className="label" style={{ marginTop: 16 }}>연락받을 분 · 연락처 (선택)</label>
        <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="예: 김간호사 010-0000-0000" />
        {msg?.err && <div className="alert-danger" style={{ marginTop: 14 }}>{msg.err}</div>}
        {msg?.ok && <div className="alert-ok" style={{ marginTop: 14 }}>{msg.ok}</div>}
        <button className="btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={submit}>{busy ? '접수 중…' : '신청하기'}</button>
      </div>

      <div className="sec-head"><div className="cap">My requests</div><span className="sub">{data.services.length}건</span></div>
      <div className="card" style={{ padding: '4px 18px' }}>
        {data.services.length === 0 && <div className="empty" style={{ border: 0 }}>신청 내역이 없습니다.</div>}
        {data.services.map((s) => (
          <div key={s.id} className="row" style={{ cursor: 'default' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row-title">{s.equipment || '장비 미지정'}{s.model ? <span className="sub" style={{ marginLeft: 6 }}>{s.model}</span> : null}</div>
              <div className="sub" style={{ marginTop: 4 }}>{fmtDate(s.date)} · {s.issue}</div>
              {s.engineer && <div className="sub" style={{ marginTop: 2 }}>담당 엔지니어 {s.engineer}</div>}
            </div>
            <Badge st={SVC_STATE[s.status] || SVC_STATE['보류']}>{s.status}</Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 재주문 ───────────────────────────────── */
function Reorder({ data, preset, reload, pin }) {
  const [qty, setQty] = useState(() => (preset ? { [preset]: 1 } : {}));
  const [extra, setExtra] = useState('');
  const [extraQty, setExtraQty] = useState(1);
  const [note, setNote] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const picked = data.reorder.filter((r) => (qty[r.key] || 0) > 0);
  const list = showAll || preset ? data.reorder : data.reorder.slice(0, 12);
  const setQ = (k, v) => setQty((p) => ({ ...p, [k]: Math.max(0, Math.min(999, v)) }));
  const submit = async () => {
    const items = picked.map((r) => ({ name: r.name, model: r.model, quantity: qty[r.key] }));
    if (extra.trim()) items.push({ name: extra.trim(), model: '', quantity: extraQty || 1 });
    if (!items.length) { setMsg({ err: '주문할 품목의 수량을 정해 주세요.' }); return; }
    setBusy(true); setMsg(null);
    try {
      await call('order', { pin, items, note: note.trim(), contact: contact.trim() });
      setQty({}); setExtra(''); setExtraQty(1); setNote(''); setContact('');
      setMsg({ ok: `${items.length}개 품목 주문을 요청했습니다. 담당자가 확인 후 연락드리겠습니다.` });
      reload();
    } catch (e) { setMsg({ err: e.message }); }
    setBusy(false);
  };
  return (
    <div className="page">
      <div className="cap">Reorder</div>
      <div className="serif h2" style={{ marginTop: 8, marginBottom: 6 }}>다시 주문하기</div>
      <div className="muted" style={{ marginBottom: 22 }}>전에 받으신 품목입니다. 수량을 정해 요청하시면 담당자가 확인 후 연락드립니다.</div>
      <div className="card" style={{ padding: '4px 18px', marginBottom: 12 }}>
        {data.reorder.length === 0 && <div className="empty" style={{ border: 0 }}>이전 주문 품목이 없습니다. 아래에 직접 적어 주세요.</div>}
        {list.map((r) => (
          <div key={r.key} className="row" style={{ cursor: 'default' }}>
            <Thumb e={r} size={44} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row-title">{r.name}{r.consumable && <span className="tag">소모품</span>}</div>
              <div className="sub" style={{ marginTop: 3 }}>{[r.model, `최근 ${fmtDate(r.lastDate)}`].filter(Boolean).join(' · ')}</div>
            </div>
            <div className="stepper">
              <button onClick={() => setQ(r.key, (qty[r.key] || 0) - 1)} aria-label="빼기">−</button>
              <span>{qty[r.key] || 0}</span>
              <button onClick={() => setQ(r.key, (qty[r.key] || 0) + 1)} aria-label="더하기">+</button>
            </div>
          </div>
        ))}
      </div>
      {!showAll && !preset && data.reorder.length > 12 && (
        <div style={{ textAlign: 'center', marginBottom: 18 }}><span className="link" onClick={() => setShowAll(true)}>{data.reorder.length - 12}개 더 보기</span></div>
      )}
      <div className="card" style={{ padding: 22, marginTop: 12 }}>
        <label className="label">목록에 없는 품목 (선택)</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" style={{ flex: 1 }} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="품목 · 모델" />
          <input className="input" style={{ width: 80, textAlign: 'center' }} type="number" min={1} value={extraQty} onChange={(e) => setExtraQty(parseInt(e.target.value, 10) || 1)} />
        </div>
        <label className="label" style={{ marginTop: 16 }}>요청 사항 (선택)</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 다음 주 화요일까지 필요" />
        <label className="label" style={{ marginTop: 16 }}>연락받을 분 · 연락처 (선택)</label>
        <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="예: 김간호사 010-0000-0000" />
        {msg?.err && <div className="alert-danger" style={{ marginTop: 14 }}>{msg.err}</div>}
        {msg?.ok && <div className="alert-ok" style={{ marginTop: 14 }}>{msg.ok}</div>}
        <button className="btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={submit}>
          {busy ? '요청 중…' : `주문 요청${picked.length + (extra.trim() ? 1 : 0) ? ` (${picked.length + (extra.trim() ? 1 : 0)}개 품목)` : ''}`}
        </button>
      </div>
      {data.myOrders.length > 0 && (
        <>
          <div className="sec-head" style={{ marginTop: 28 }}><div className="cap">My orders</div><span className="sub">{data.myOrders.length}건</span></div>
          <div className="card" style={{ padding: '4px 18px' }}>
            {data.myOrders.map((o) => (
              <div key={o.id} className="row" style={{ cursor: 'default' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row-title">{o.item}{o.quantity ? <span className="sub" style={{ marginLeft: 6 }}>×{o.quantity}</span> : null}</div>
                  <div className="sub" style={{ marginTop: 3 }}>{fmtDate(o.date)} 요청</div>
                </div>
                <Badge st={SVC_STATE[o.status] || SVC_STATE['보류']}>{o.status === '대기' ? '확인 중' : o.status}</Badge>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── 문서함 ───────────────────────────────── */
function Docs({ data }) {
  const SECTIONS = [
    { key: 'orders', cap: 'Orders', title: '주문 내역', icon: 'shopping-cart', rows: data.documents.orders.map((d) => ({ date: d.date, title: d.summary, sub: `${d.count}개 품목` })) },
    { key: 'deliveries', cap: 'Deliveries', title: '납품 내역 (거래명세서)', icon: 'truck-delivery', rows: data.documents.deliveries.map((d) => ({ date: d.date, title: d.summary || '납품', sub: [d.docNo && `명세서 ${d.docNo}`, `${d.count}개 품목`].filter(Boolean).join(' · ') })) },
    { key: 'invoices', cap: 'Tax invoices', title: '세금계산서 발행', icon: 'receipt', rows: data.documents.invoices.map((d) => ({ date: d.date, title: d.summary })) },
  ];
  const [tab, setTab] = useState(SECTIONS.find((s) => s.rows.length)?.key || 'orders');
  const sec = SECTIONS.find((s) => s.key === tab);
  return (
    <div className="page">
      <div className="cap">Documents</div>
      <div className="serif h2" style={{ marginTop: 8, marginBottom: 6 }}>문서함</div>
      <div className="muted" style={{ marginBottom: 20 }}>주문·납품·세금계산서 기록입니다. 금액과 서류 원본은 담당 영업사원에게 요청해 주세요.</div>
      <div className="chips" style={{ marginBottom: 16 }}>
        {SECTIONS.map((s) => (
          <span key={s.key} className={'chip' + (tab === s.key ? ' chip-on' : '')} onClick={() => setTab(s.key)}>{s.title} <span style={{ opacity: 0.7, marginLeft: 3 }}>{s.rows.length}</span></span>
        ))}
      </div>
      <div className="card" style={{ padding: '4px 18px' }}>
        {sec.rows.length === 0 && <div className="empty" style={{ border: 0 }}>기록이 없습니다.</div>}
        {sec.rows.map((r, i) => (
          <div key={i} className="row" style={{ cursor: 'default' }}>
            <div className="thumb" style={{ width: 40, height: 40 }}><Ti n={sec.icon} s={18} c="#9aa0a8" /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row-title" style={{ whiteSpace: 'normal' }}>{r.title}</div>
              <div className="sub" style={{ marginTop: 3 }}>{[fmtDate(r.date), r.sub].filter(Boolean).join(' · ')}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 앱 ───────────────────────────────── */
function App() {
  const [phase, setPhase] = useState('loading'); // loading | invalid | pin | main | down
  const [data, setData] = useState(null);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState('home');
  const [sel, setSel] = useState(null);

  const login = useCallback(async (p, silent = false) => {
    setBusy(true); setErr('');
    try {
      const d = await call('load', { pin: p });
      storage.set(p); setPin(p); setData(d); setPhase('main');
    } catch (e) {
      storage.clear();
      setPhase('pin');
      if (!silent) setErr(e.status === 401 ? '접속 코드가 올바르지 않습니다. 다시 확인해 주세요.' : e.message);
    }
    setBusy(false);
  }, []);
  const reload = useCallback(async () => {
    try { setData(await call('load', { pin })); } catch {}
  }, [pin]);

  useEffect(() => {
    if (!token) { setPhase('invalid'); return; }
    const saved = storage.get();
    if (saved) { login(saved, true); return; }
    call('check').then((r) => setPhase(r.ok ? 'pin' : 'invalid')).catch(() => setPhase('down'));
  }, [login]);

  const go = (p, key = null) => { setPage(p); setSel(key); window.scrollTo(0, 0); };

  if (phase === 'loading') return <Gate><div className="muted" style={{ textAlign: 'center' }}>불러오는 중…</div></Gate>;
  if (phase === 'invalid') return (
    <Gate><div className="card" style={{ padding: 28, textAlign: 'center' }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>유효하지 않은 링크입니다</div>
      <div className="muted" style={{ marginTop: 6 }}>담당 영업사원에게 링크를 다시 요청해 주세요.</div>
    </div></Gate>
  );
  if (phase === 'down') return (
    <Gate><div className="card" style={{ padding: 28, textAlign: 'center' }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>잠시 연결이 원활하지 않습니다</div>
      <div className="muted" style={{ marginTop: 6 }}>잠시 후 새로고침해 주세요.</div>
    </div></Gate>
  );
  if (phase === 'pin') return <PinScreen onLogin={login} error={err} busy={busy} />;

  return (
    <div>
      <TopHeader page={page} onNav={(p) => go(p)} data={data} />
      {page === 'home' && <Home data={data} go={go} />}
      {page === 'equipment' && <EquipmentList data={data} go={go} />}
      {page === 'detail' && <EquipmentDetail data={data} id={sel} go={go} />}
      {page === 'service' && <Service key={'svc' + (sel || '')} data={data} preset={sel} reload={reload} pin={pin} />}
      {page === 'reorder' && <Reorder key={'ro' + (sel || '')} data={data} preset={sel} reload={reload} pin={pin} />}
      {page === 'docs' && <Docs data={data} />}
      <div className="footer">
        {data.company.name} · 대표번호 <a href={'tel:' + data.company.phone.replace(/-/g, '')}>{data.company.phone}</a>
        {data.rep && <> · 담당 {data.rep.name}</>}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
