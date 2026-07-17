import os

path = r'E:\ProjBuild\SelfLearn\LinProject\backend\server.py'
with open(path, 'rb') as f:
    data = f.read()

# Find boundaries
s1 = data.find(b'"interactive"')
s2 = data.find(b'"data/export"')
with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\dbg.txt', 'w') as f:
    f.write(f's1={s1} s2={s2}')
    if s1 > 0:
        f.write('\nCONTEXT: ' + data[max(0,s1-200):s1+50].decode('latin-1',errors='replace'))
