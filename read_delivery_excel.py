import pandas as pd
import json

path = r'C:\Users\jojo\Desktop\납품이력_입력양식.xlsx'
df = pd.read_excel(path, sheet_name='납품이력_입력', header=3, dtype=str)

# 실제 컬럼명 출력
print("컬럼:", list(df.columns))
print("총 행수:", len(df))
print("\n첫 10행:")
print(df.head(10).to_string())
