// 서버 API 공용 — 로그인 토큰 확인. 파일명이 _로 시작하면 Vercel이 API 주소로 만들지 않음.

export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nbgubiywavozgigiwkpr.supabase.co';
const SUPABASE_PUBLIC_KEY = 'sb_publishable_L4FVvZBPaNF9BQtoadoPRw_3HeNlPRL';
export const SUPABASE_KEY = process.env.SUPABASE_KEY || SUPABASE_PUBLIC_KEY;

const ADMIN_EMAILS = ['wooheock2@gmail.com'];
export const isAdminEmail = (email) => ADMIN_EMAILS.includes(String(email || '').toLowerCase());

// Authorization: Bearer <로그인 토큰> → 그 사람의 이메일 (소문자). 토큰이 없거나 틀리면 null
export async function getLoginEmail(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  // 로그인 확인은 브라우저와 같은 공개 키로 (비밀 키는 DB 접근 전용)
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLIC_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    console.error('[auth] 로그인 확인 실패', r.status, (await r.text()).slice(0, 200));
    return null;
  }
  const user = await r.json();
  return String(user.email || '').toLowerCase() || null;
}
