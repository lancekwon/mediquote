-- 2026-11-05: 병원 포털(my.) — 장비 설치 위치
--
-- 병원이 "내 장비"에서 장비마다 설치 위치를 직접 입력·수정 (예: '1층 물리치료실', '3층 엑스레이실').
-- 수량이 여러 개면 위치별로 나눠서 저장: allocations = [{"location": "1층 물리치료실", "qty": 2}, {"location": "3층 처치실", "qty": 1}]
--
-- equip_key = 포털이 장비를 묶는 키 (api/portal.mjs loadBundle의 group key)
--   - 장비 목록(equipment)에 연결된 품목: equipment.id (uuid 문자열)
--   - 연결 안 된 품목: "정규화 품목명|정규화 모델명"
--   ※ 장비를 다른 장비로 합칠 때(equipment_id 재연결) 이 표의 equip_key도 같이 옮겨야 위치가 안 사라짐
--
-- 쓰는 곳: api/portal.mjs (load / location 액션) — 병원 화면에는 이 API로만 노출
-- 실행: Supabase SQL Editor 또는 apply_migration (hospital_equipment_locations_43). 다시 실행해도 안전함.

create table if not exists hospital_equipment_locations (
  hospital_id uuid not null references hospitals(id) on delete cascade,
  equip_key   text not null,
  allocations jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (hospital_id, equip_key)
);

comment on table hospital_equipment_locations is '병원 포털 — 장비 설치 위치 (위치별 수량 배분). equip_key는 포털 장비 그룹 키(equipment.id 또는 품목|모델)';

alter table hospital_equipment_locations enable row level security;
drop policy if exists "hospital_equipment_locations_all" on hospital_equipment_locations;
create policy "hospital_equipment_locations_all" on hospital_equipment_locations for all using (true) with check (true);
grant select, insert, update, delete on hospital_equipment_locations to anon, authenticated, service_role;

notify pgrst, 'reload schema';
