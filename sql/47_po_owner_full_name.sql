-- 47. 발주 담당(owner)을 성씨 → 영업사원 이름으로 (판매 담당)
-- 판매 담당 = 발주마다 1명(누가 팔았나, 실적 기준). 관리 담당 = 병원마다 1명(hospitals.assigned_rep_id).
-- 이름을 글자로 저장하므로 영업사원이 명단에서 빠져도 과거 실적은 남음.
-- 사용자 결정 2026-11-09: 성 → 전부 성현기, 최 → 최윤철.

update public.purchase_orders set owner = '성현기' where owner = '성';
update public.purchase_orders set owner = '최윤철' where owner = '최';

update public.sales_reps set name = '권우혁' where email = 'wooheock13@gmail.com' and name = '권우혁(테스트)';

comment on column public.purchase_orders.owner is '판매 담당 이름 (sales_reps.name 값 · 명단에서 빠져도 유지)';
