"""
index.html을 빌드 버전으로 변환 (일회성):
  1. Babel standalone CDN 제거
  2. React/ReactDOM을 production.min 으로
  3. 인라인 <script type="text/babel"> 12000줄 → <script src="app.js">
"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
P = r'C:\Users\jojo\mediquote\index.html'
html = open(P, encoding='utf-8').read()
orig = len(html)

# 1. Babel standalone 제거
b = '  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>\n'
assert b in html, 'Babel 스크립트 줄을 못 찾음'
html = html.replace(b, '')

# 2. React production 버전
assert 'react@18/umd/react.development.js' in html
html = html.replace('react@18/umd/react.development.js', 'react@18/umd/react.production.min.js')
html = html.replace('react-dom@18/umd/react-dom.development.js', 'react-dom@18/umd/react-dom.production.min.js')

# 3. 인라인 스크립트 → app.js 로드
marker = '<script type="text/babel">'
start = html.index(marker)
end = html.rindex('</script>') + len('</script>')
inline_len = end - start
html = html[:start] + '<script src="app.js"></script>' + html[end:]

open(P, 'w', encoding='utf-8', newline='\n').write(html)
print(f'index.html: {orig:,} → {len(html):,} bytes')
print(f'인라인 제거: {inline_len:,} bytes')
print('Babel 제거 / React production / app.js 로드 완료')
