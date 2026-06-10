# mediquote (DWmedi) - 의료장비 견적 시스템

## 기술 스택
- 프론트엔드: React 18 (CDN) + Babel standalone + Tailwind CSS (CDN)
- 데이터: Supabase (PostgreSQL) REST API
- 스크립트: Python (데이터 임포트/마이그레이션)
- 차트: Recharts (CDN)
- 배포: Vercel (정적 호스팅)

## 프로젝트 구조
```
mediquote/
├── index.html              # 메인 견적/장비 대시보드 (React SPA)
├── hospital.html           # 병원 포털 (PIN 인증)
├── 장비리스트/              # 카테고리별 장비 데이터 (13개 분류)
├── *.py                    # Python 유틸리티 스크립트
│   ├── insert_equipment.py     # 장비 벌크 삽입
│   ├── import_equipment.py     # 엑셀 → Supabase 임포트
│   ├── create_delivery_template.py  # 엑셀 템플릿 생성
│   └── import_deliveries.py    # 납품 이력 임포트
└── vercel.json             # 배포 설정
```

## Supabase
- URL: `https://dmqzixpappullrnyospj.supabase.co`
- 주요 테이블: `equipment`, `hospitals`, `deliveries`, `delivery_items`, `categories`

## Python 실행
Autodesk Python 사용:
```bash
"/c/Users/jojo/AppData/Local/Autodesk/webdeploy/production/159dd2fdcdd1da8fc7d43041950039e0ff0792c3/Python/python.exe" script.py
```

## 코딩 패턴
- HTML 내 React 컴포넌트 인라인 작성 (Babel transpile)
- Supabase REST API 직접 호출 (프론트: JS client, 스크립트: urllib)
- UI 언어: 한국어 (Noto Sans KR)
