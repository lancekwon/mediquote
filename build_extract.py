"""
index.html의 인라인 <script type="text/babel"> ... </script> 를 app.jsx로 추출.
일회성 — 이후로는 app.jsx를 직접 편집한다.
"""
import sys, io
sys.stdout.reconfigure(encoding='utf-8')

SRC = r'C:\Users\jojo\mediquote\index.html'
OUT = r'C:\Users\jojo\mediquote\app.jsx'

with open(SRC, 'r', encoding='utf-8') as f:
    html = f.read()

marker = '<script type="text/babel">'
start = html.index(marker) + len(marker)
end = html.rindex('</script>')  # 인라인 스크립트 끝 (내부 </script>는 모두 <\/script>로 이스케이프됨)

jsx = html[start:end].strip('\n')

with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    f.write(jsx + '\n')

print(f'추출 완료: {OUT}')
print(f'라인 수: {jsx.count(chr(10)) + 1}')
print(f'바이트: {len(jsx.encode("utf-8")):,}')
print(f'시작: {jsx[:60]!r}')
print(f'끝:   {jsx[-60:]!r}')
