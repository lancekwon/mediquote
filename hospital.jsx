// 병원 포털 (hospital.html) — 빌드: npx esbuild hospital.jsx --outfile=hospital.js --loader:.jsx=jsx --minify
// 데이터는 /api/portal 에서만 받음 (링크 코드+사업자번호 확인, 금액 없음). 이 파일에는 DB 키가 없음.
// 디자인: 사용자가 준 관리 콘솔 레퍼런스(2026-11-04) 기준 — Pretendard 한 가지, 22px 제목, 회색 머리줄 표, 촘촘한 행
const { useState, useEffect, useMemo, useCallback } = React;

const API = '/api/portal';
// 짧은 링크 /h/<8자리> 또는 예전 링크 ?token=<UUID>
const pathCode = (window.location.pathname.match(/^\/h\/([0-9a-fA-F]{8})\/?$/) || [])[1];
const token = pathCode || new URLSearchParams(window.location.search).get('token') || '';
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
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

const CAT_ICON = {
  '영상진단장비': 'scan', '물리치료/재활장비': 'activity-heartbeat', '멸균/소독장비': 'flask', '수술실/병원가구': 'armchair',
  '병상/침대류': 'bed', '온열/냉각기기': 'temperature', '환자모니터링장비': 'heart-rate-monitor', '검사/측정장비': 'microscope',
  '수술장비': 'scissors', '수술기구': 'scissors', '수술기구/소모품': 'scissors', '내시경장비': 'camera', '치료장비': 'first-aid-kit',
  '응급의료기': 'emergency-bed', '진료가구': 'armchair',
};
const catIcon = (c) => CAT_ICON[c] || 'box';

const TONE = {
  green: { bg: '#e9f8f1', text: '#0a8a55' },
  blue: { bg: '#e8f3ff', text: '#1b64da' },
  orange: { bg: '#fff3e5', text: '#c46200' },
  gray: { bg: '#f2f4f6', text: '#6b7684' },
};
const STATE = {
  delivered: { label: '납품 완료', ...TONE.green },
  ordered: { label: '주문 접수', ...TONE.blue },
  service: { label: '점검·수리 접수', ...TONE.orange },
};
const eqState = (e) => (e.openService ? STATE.service : STATE[e.state] || STATE.delivered);
const SVC_TONE = { '접수': TONE.orange, '처리중': TONE.blue, '완료': TONE.green, '대기': TONE.orange, '보류': TONE.gray };
const Badge = ({ tone, children }) => <span className="badge" style={{ background: tone.bg, color: tone.text }}>{children}</span>;

function Thumb({ e, size = 40 }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="thumb" style={{ width: size, height: size }}>
      {e.image && !broken
        ? <img src={e.image} alt={e.name} loading="lazy" onError={() => setBroken(true)} />
        : <Ti n={catIcon(e.category)} s={Math.round(size * 0.45)} c="#b0b8c1" />}
    </div>
  );
}

const PageHead = ({ title, desc, right }) => (
  <div className="page-head">
    <div style={{ minWidth: 0 }}>
      <h1 className="title">{title}</h1>
      {desc && <p className="desc">{desc}</p>}
    </div>
    {right}
  </div>
);
const SecHead = ({ title, right }) => (
  <div className="sec-head"><h2 className="sec-title">{title}</h2>{right}</div>
);

/* ── 접속 화면 ───────────────────────────────── */
function Gate({ children }) {
  return (
    <div className="gate">
      <div style={{ width: '100%', maxWidth: 360 }}>
        <div className="gate-brand"><span className="brand-mark">DW</span>대원메디칼 병원 포털</div>
        {children}
      </div>
    </div>
  );
}

function PinScreen({ onLogin, error, busy, kind }) {
  const [pin, setPin] = useState('');
  const biz = kind !== 'pin';
  return (
    <Gate>
      <form className="box" style={{ padding: 24 }} onSubmit={(e) => { e.preventDefault(); if (pin.trim()) onLogin(pin.trim()); }}>
        <div className="sec-title">{biz ? '사업자등록번호 입력' : '접속 코드 입력'}</div>
        <p className="desc" style={{ marginTop: 4, marginBottom: 16 }}>
          {biz ? '병원 사업자등록번호 10자리를 입력해 주세요.' : '담당 영업사원에게 받은 접속 코드를 입력해 주세요.'}
        </p>
        <input className="input" value={pin} onChange={(e) => setPin(e.target.value)} placeholder={biz ? '000-00-00000' : '접속 코드'} autoFocus
          inputMode="numeric" autoComplete="off" maxLength={biz ? 12 : 20} style={{ textAlign: 'center', letterSpacing: 2, fontSize: 15 }} />
        {error && <div className="alert danger" style={{ marginTop: 10 }}>{error}</div>}
        <button className="btn primary block" type="submit" disabled={busy || !pin.trim()} style={{ marginTop: 12 }}>
          {busy ? '확인 중…' : '입장하기'}
        </button>
      </form>
    </Gate>
  );
}

/* ── 헤더 ───────────────────────────────── */
const MENU = [
  { key: 'home', label: '홈', icon: 'home' },
  { key: 'equipment', label: '내 장비', icon: 'box' },
  { key: 'service', label: '점검·수리', icon: 'tool' },
  { key: 'reorder', label: '재주문', icon: 'shopping-cart' },
  { key: 'docs', label: '문서함', icon: 'file-text' },
];
function TopHeader({ page, onNav, data }) {
  const navKey = page === 'detail' ? 'equipment' : page;
  return (
    <header className="topbar">
      <div className="topbar-in">
        <div className="brand" onClick={() => onNav('home')}>
          <span className="brand-mark">DW</span>
          <span className="brand-name">대원메디칼</span>
          <span className="brand-sep" />
          <span className="brand-hosp">{data.hospital.name}</span>
        </div>
        <div className="contact">
          {data.rep && <span className="rep">담당 <b>{data.rep.name}</b></span>}
          <a className="icon-btn" href={'tel:' + data.company.phone.replace(/-/g, '')} title={`${data.company.name} 대표번호 ${data.company.phone}`}>
            <Ti n="phone" s={16} />
          </a>
        </div>
      </div>
      <nav className="menu">
        {MENU.map((m) => (
          <button key={m.key} className={'nav-tab' + (navKey === m.key ? ' active' : '')} onClick={() => onNav(m.key)}>{m.label}</button>
        ))}
      </nav>
    </header>
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
  const ordered = data.equipment.filter((e) => e.state === 'ordered').length;
  const stats = [
    { label: '내 장비', value: `${data.equipment.length}종`, go: 'equipment' },
    { label: '주문 접수 중', value: `${ordered}종`, go: 'equipment' },
    { label: '점검·수리 진행', value: `${openSvc.length}건`, go: 'service' },
  ];
  return (
    <div className="page">
      <PageHead title={`${greet}, 안녕하세요`} desc={`${fmtDate(data.today)} (${DOW[d.getDay()]}) · ${data.hospital.name}`} />

      <div className="stats">
        {stats.map((s) => (
          <button key={s.label} className="stat" onClick={() => go(s.go)}>
            <span className="stat-label">{s.label}</span>
            <span className="stat-value">{s.value}</span>
          </button>
        ))}
      </div>

      <div className="banner">
        {BANNERS.map((b, i) => <img key={i} src={b.img} alt={b.alt} style={{ display: i === bi ? 'block' : 'none' }} />)}
        <div className="dots">{BANNERS.map((_, i) => <span key={i} onClick={() => setBi(i)} className={'dot' + (i === bi ? ' on' : '')} />)}</div>
      </div>

      {openSvc.length > 0 && (
        <button className="notice" onClick={() => go('service')}>
          <Ti n="tool" s={15} /> 점검·수리 {openSvc.length}건 진행 중 — {openSvc[0].equipment || '장비'} ({openSvc[0].status})
          <Ti n="chevron-right" s={15} style={{ marginLeft: 'auto' }} />
        </button>
      )}

      <SecHead title="최근 장비" right={data.equipment.length > 0 && <button className="link" onClick={() => go('equipment')}>전체 보기</button>} />
      {data.equipment.length === 0 ? (
        <div className="box empty">아직 등록된 장비가 없습니다.</div>
      ) : (
        <div className="grid3">
          {data.equipment.slice(0, 3).map((e) => {
            const s = eqState(e);
            return (
              <button key={e.key} className="box eq-card" onClick={() => go('detail', e.key)}>
                <div className="eq-img">{e.image ? <img src={e.image} alt={e.name} loading="lazy" /> : <Ti n={catIcon(e.category)} s={34} c="#c9cfd6" />}</div>
                <div className="eq-name">{e.name}</div>
                <div className="t3" style={{ margin: '2px 0 8px' }}>{[e.model, e.category].filter(Boolean).join(' · ') || '—'}</div>
                <Badge tone={s}>{s.label}</Badge>
              </button>
            );
          })}
        </div>
      )}

      {quick.length > 0 && (
        <>
          <SecHead title="자주 쓰는 소모품 다시 주문" right={<span className="t3">이전 주문 기준</span>} />
          <div className="chips">
            {quick.map((r) => <button key={r.key} className="chip" onClick={() => go('reorder', r.key)}>{r.name}</button>)}
            <button className="btn primary sm" onClick={() => go('reorder')}>재주문 하기</button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── 장비 목록 (표) ───────────────────────────────── */
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
      <PageHead title="내 장비" desc="대원메디칼에서 주문·납품받은 장비입니다." />
      <div className="toolbar">
        <div className="search"><Ti n="search" s={16} c="#8b95a1" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="장비 · 모델 · 분류 검색" /></div>
      </div>
      <div className="chips" style={{ marginBottom: 16 }}>
        {cats.map(([c, n]) => (
          <button key={c} className={'chip' + (cat === c ? ' on' : '')} onClick={() => setCat(c)}>{c} <span className="chip-n">{n}</span></button>
        ))}
      </div>
      <div className="table">
        <div className="tr th eq-cols">
          <div>장비</div><div className="hide-sm">분류</div><div className="hide-sm num">수량</div><div className="hide-sm">최근</div><div className="center">상태</div>
        </div>
        {list.length === 0 && <div className="empty">검색 결과가 없습니다.</div>}
        {list.map((e) => {
          const s = eqState(e);
          return (
            <button key={e.key} className="tr eq-cols clickable" onClick={() => go('detail', e.key)}>
              <div className="cell-main">
                <Thumb e={e} />
                <div style={{ minWidth: 0 }}>
                  <div className="t1 ellipsis">{e.name}</div>
                  <div className="t3 ellipsis">
                    <span className="hide-sm">{e.model || '—'}</span>
                    <span className="show-sm">{[e.model, `${e.qty}개`, fmtDate(e.lastDate)].filter(Boolean).join(' · ')}</span>
                  </div>
                </div>
              </div>
              <div className="hide-sm t2 ellipsis">{e.category || '—'}</div>
              <div className="hide-sm t2 num">{e.qty}개</div>
              <div className="hide-sm t2">{fmtDate(e.lastDate)}</div>
              <div className="center"><Badge tone={s}>{s.label}</Badge></div>
            </button>
          );
        })}
        <div className="tfoot">총 {list.length}종</div>
      </div>
    </div>
  );
}

/* ── 장비 상세 ───────────────────────────────── */
function EquipmentDetail({ data, id, go }) {
  const e = data.equipment.find((x) => x.key === id);
  if (!e) return <div className="page"><button className="link" onClick={() => go('equipment')}>← 내 장비</button></div>;
  const s = eqState(e);
  const rows = [
    ['상태', <Badge tone={s}>{s.label}</Badge>],
    ['모델', e.model || '—'],
    ['분류', e.category || '—'],
    ...(e.maker ? [['제조사', e.maker]] : []),
    ['수량', `${e.qty}개`],
    [e.state === 'ordered' ? '주문일' : '처음 도입', fmtDate(e.firstDate)],
    ...(e.lastDate !== e.firstDate ? [['최근 주문·납품', fmtDate(e.lastDate)]] : []),
    ['구매 횟수', `${e.purchases}회`],
  ];
  return (
    <div className="page">
      <button className="back" onClick={() => go('equipment')}><Ti n="chevron-left" s={16} /> 내 장비</button>
      <PageHead title={e.name} right={
        <div className="head-actions">
          <button className="btn secondary" onClick={() => go('reorder', e.key)}>다시 주문</button>
          <button className="btn primary" onClick={() => go('service', e.key)}>점검·수리 신청</button>
        </div>
      } />
      <div className="detail">
        <div className={'box detail-img' + (e.image ? '' : ' noimg')}>
          {e.image ? <img src={e.image} alt={e.name} /> : <Ti n={catIcon(e.category)} s={56} c="#c9cfd6" />}
        </div>
        <div className="kv">
          {rows.map(([l, v]) => (
            <div key={l} className="kv-row"><div className="kv-label">{l}</div><div className="kv-value">{v}</div></div>
          ))}
        </div>
      </div>

      <SecHead title="이력" />
      <div className="table">
        <div className="tr th hist-cols"><div>날짜</div><div>내용</div><div className="hide-sm">상세</div></div>
        {e.timeline.map((t, i) => (
          <div key={i} className="tr hist-cols">
            <div className="t2">{fmtDate(t.date)}</div>
            <div className="t1">{t.title}<div className="t3 show-sm">{t.detail}</div></div>
            <div className="t2 hide-sm ellipsis">{t.detail || '—'}</div>
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
      <PageHead title="점검·수리 신청" desc="장비 이상이나 정기 점검이 필요하면 남겨 주세요. 담당자가 확인 후 연락드립니다." />
      <div className="form box">
        <div className="field">
          <label className="label">장비</label>
          <select className="input" value={eqKey} onChange={(e) => setEqKey(e.target.value)}>
            <option value="">직접 입력 / 목록에 없음</option>
            {data.equipment.map((e) => <option key={e.key} value={e.key}>{e.name}{e.model ? ` (${e.model})` : ''}</option>)}
          </select>
          {!eqKey && <input className="input" style={{ marginTop: 8 }} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="장비 이름" />}
        </div>
        <div className="field">
          <label className="label">증상 · 요청 내용 <span className="req">*</span></label>
          <textarea className="input" rows={4} value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="예: 전원이 켜지지 않음, 정기 점검 요청" />
        </div>
        <div className="field">
          <label className="label">연락받을 분 · 연락처 <span className="t3">(선택)</span></label>
          <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="예: 김간호사 010-0000-0000" />
        </div>
        {msg?.err && <div className="alert danger">{msg.err}</div>}
        {msg?.ok && <div className="alert ok">{msg.ok}</div>}
        <div className="form-actions"><button className="btn primary" disabled={busy} onClick={submit}>{busy ? '접수 중…' : '신청하기'}</button></div>
      </div>

      <SecHead title="신청 내역" right={<span className="t3">{data.services.length}건</span>} />
      <div className="table">
        <div className="tr th svc-cols"><div>접수일</div><div>장비 · 내용</div><div className="hide-sm">담당 엔지니어</div><div className="center">상태</div></div>
        {data.services.length === 0 && <div className="empty">신청 내역이 없습니다.</div>}
        {data.services.map((s) => (
          <div key={s.id} className="tr svc-cols">
            <div className="t2">{fmtDate(s.date)}</div>
            <div style={{ minWidth: 0 }}>
              <div className="t1 ellipsis">{s.equipment || '장비 미지정'}{s.model ? <span className="t3"> {s.model}</span> : null}</div>
              <div className="t3 ellipsis">{s.issue}</div>
            </div>
            <div className="t2 hide-sm">{s.engineer || '배정 전'}</div>
            <div className="center"><Badge tone={SVC_TONE[s.status] || TONE.gray}>{s.status}</Badge></div>
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
  const count = picked.length + (extra.trim() ? 1 : 0);
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
      <PageHead title="다시 주문하기" desc="전에 받으신 품목입니다. 수량을 정해 요청하시면 담당자가 확인 후 연락드립니다." />
      <div className="table">
        <div className="tr th ro-cols"><div>품목</div><div className="hide-sm">최근 주문</div><div className="center">수량</div></div>
        {data.reorder.length === 0 && <div className="empty">이전 주문 품목이 없습니다. 아래에 직접 적어 주세요.</div>}
        {list.map((r) => (
          <div key={r.key} className={'tr ro-cols' + ((qty[r.key] || 0) > 0 ? ' picked' : '')}>
            <div className="cell-main">
              <Thumb e={r} size={36} />
              <div style={{ minWidth: 0 }}>
                <div className="t1 ellipsis">{r.name}{r.consumable && <span className="tag">소모품</span>}</div>
                <div className="t3 ellipsis">
                  <span className="hide-sm">{r.model || '—'}</span>
                  <span className="show-sm">{[r.model, `최근 ${fmtDate(r.lastDate)}`].filter(Boolean).join(' · ')}</span>
                </div>
              </div>
            </div>
            <div className="t2 hide-sm">{fmtDate(r.lastDate)}</div>
            <div className="center">
              <div className="stepper">
                <button onClick={() => setQ(r.key, (qty[r.key] || 0) - 1)} aria-label="빼기">−</button>
                <span>{qty[r.key] || 0}</span>
                <button onClick={() => setQ(r.key, (qty[r.key] || 0) + 1)} aria-label="더하기">+</button>
              </div>
            </div>
          </div>
        ))}
        {!showAll && !preset && data.reorder.length > 12 && (
          <button className="tfoot more" onClick={() => setShowAll(true)}>{data.reorder.length - 12}개 더 보기</button>
        )}
      </div>

      <div className="form box" style={{ marginTop: 16 }}>
        <div className="field">
          <label className="label">목록에 없는 품목 <span className="t3">(선택)</span></label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" style={{ flex: 1 }} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="품목 · 모델" />
            <input className="input" style={{ width: 76, textAlign: 'center' }} type="number" min={1} value={extraQty} onChange={(e) => setExtraQty(parseInt(e.target.value, 10) || 1)} />
          </div>
        </div>
        <div className="field">
          <label className="label">요청 사항 <span className="t3">(선택)</span></label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 다음 주 화요일까지 필요" />
        </div>
        <div className="field">
          <label className="label">연락받을 분 · 연락처 <span className="t3">(선택)</span></label>
          <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="예: 김간호사 010-0000-0000" />
        </div>
        {msg?.err && <div className="alert danger">{msg.err}</div>}
        {msg?.ok && <div className="alert ok">{msg.ok}</div>}
        <div className="form-actions">
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? '요청 중…' : `주문 요청${count ? ` (${count}개 품목)` : ''}`}</button>
        </div>
      </div>

      {data.myOrders.length > 0 && (
        <>
          <SecHead title="요청 내역" right={<span className="t3">{data.myOrders.length}건</span>} />
          <div className="table">
            <div className="tr th ord-cols"><div>요청일</div><div>품목</div><div className="center">상태</div></div>
            {data.myOrders.map((o) => (
              <div key={o.id} className="tr ord-cols">
                <div className="t2">{fmtDate(o.date)}</div>
                <div className="t1 ellipsis">{o.item}{o.quantity ? <span className="t3"> ×{o.quantity}</span> : null}</div>
                <div className="center"><Badge tone={SVC_TONE[o.status] || TONE.gray}>{o.status === '대기' ? '확인 중' : o.status}</Badge></div>
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
    { key: 'orders', title: '주문 내역', rows: data.documents.orders.map((d) => ({ date: d.date, title: d.summary, sub: `${d.count}개 품목` })) },
    { key: 'deliveries', title: '납품 내역', rows: data.documents.deliveries.map((d) => ({ date: d.date, title: d.summary || '납품', sub: [d.docNo && `명세서 ${d.docNo}`, `${d.count}개 품목`].filter(Boolean).join(' · ') })) },
    { key: 'invoices', title: '세금계산서 발행', rows: data.documents.invoices.map((d) => ({ date: d.date, title: d.summary, sub: '' })) },
  ];
  const [tab, setTab] = useState(SECTIONS.find((s) => s.rows.length)?.key || 'orders');
  const sec = SECTIONS.find((s) => s.key === tab);
  return (
    <div className="page">
      <PageHead title="문서함" desc="주문·납품·세금계산서 기록입니다. 금액과 서류 원본은 담당 영업사원에게 요청해 주세요." />
      <div className="seg">
        {SECTIONS.map((s) => (
          <button key={s.key} className={tab === s.key ? 'on' : ''} onClick={() => setTab(s.key)}>{s.title} <span className="chip-n">{s.rows.length}</span></button>
        ))}
      </div>
      <div className="table">
        <div className="tr th doc-cols"><div>날짜</div><div>내용</div><div className="hide-sm">비고</div></div>
        {sec.rows.length === 0 && <div className="empty">기록이 없습니다.</div>}
        {sec.rows.map((r, i) => (
          <div key={i} className="tr doc-cols">
            <div className="t2">{fmtDate(r.date)}</div>
            <div className="t1 wrap">{r.title}{r.sub && <div className="t3 show-sm">{r.sub}</div>}</div>
            <div className="t2 hide-sm">{r.sub || '—'}</div>
          </div>
        ))}
        <div className="tfoot">총 {sec.rows.length}건</div>
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
  const [kind, setKind] = useState('bizno'); // 'bizno' | 'pin'

  const login = useCallback(async (p, silent = false) => {
    setBusy(true); setErr('');
    try {
      const d = await call('load', { pin: p });
      storage.set(p); setPin(p); setData(d); setPhase('main');
    } catch (e) {
      storage.clear();
      setPhase('pin');
      if (!silent) setErr(e.status === 401 ? '번호가 맞지 않습니다. 다시 확인해 주세요.' : e.message);
    }
    setBusy(false);
  }, []);
  const reload = useCallback(async () => {
    try { setData(await call('load', { pin })); } catch {}
  }, [pin]);

  useEffect(() => {
    if (!token) { setPhase('invalid'); return; }
    call('check').then((r) => {
      if (!r.ok) { setPhase('invalid'); return; }
      setKind(r.login || 'bizno');
      const saved = storage.get();
      if (saved) login(saved, true); else setPhase('pin');
    }).catch(() => setPhase('down'));
  }, [login]);

  const go = (p, key = null) => { setPage(p); setSel(key); window.scrollTo(0, 0); };

  if (phase === 'loading') return <Gate><p className="desc" style={{ textAlign: 'center' }}>불러오는 중…</p></Gate>;
  if (phase === 'invalid') return (
    <Gate><div className="box" style={{ padding: 24, textAlign: 'center' }}>
      <div className="sec-title">유효하지 않은 링크입니다</div>
      <p className="desc" style={{ marginTop: 6 }}>담당 영업사원에게 링크를 다시 요청해 주세요.</p>
    </div></Gate>
  );
  if (phase === 'down') return (
    <Gate><div className="box" style={{ padding: 24, textAlign: 'center' }}>
      <div className="sec-title">잠시 연결이 원활하지 않습니다</div>
      <p className="desc" style={{ marginTop: 6 }}>잠시 후 새로고침해 주세요.</p>
    </div></Gate>
  );
  if (phase === 'pin') return <PinScreen onLogin={login} error={err} busy={busy} kind={kind} />;

  return (
    <div className="app">
      <TopHeader page={page} onNav={(p) => go(p)} data={data} />
      <main>
        {page === 'home' && <Home data={data} go={go} />}
        {page === 'equipment' && <EquipmentList data={data} go={go} />}
        {page === 'detail' && <EquipmentDetail data={data} id={sel} go={go} />}
        {page === 'service' && <Service key={'svc' + (sel || '')} data={data} preset={sel} reload={reload} pin={pin} />}
        {page === 'reorder' && <Reorder key={'ro' + (sel || '')} data={data} preset={sel} reload={reload} pin={pin} />}
        {page === 'docs' && <Docs data={data} />}
      </main>
      <footer className="footer">
        {data.company.name} · 대표번호 <a href={'tel:' + data.company.phone.replace(/-/g, '')}>{data.company.phone}</a>
        {data.rep && <> · 담당 {data.rep.name}</>}
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
