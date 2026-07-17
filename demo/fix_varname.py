with open(r'E:\ProjBuild\SelfLearn\LinProject\simulink_bridge.py','rb') as f:
    data = f.read()

# Replace ALL occurrences of _tmp_so_ with tmpSo
data = data.replace(b'_tmp_so_', b'tmpSo')

with open(r'E:\ProjBuild\SelfLearn\LinProject\simulink_bridge.py','wb') as f:
    f.write(data)

# Verify
with open(r'E:\ProjBuild\SelfLearn\LinProject\simulink_bridge.py','rb') as f:
    v = f.read()
ok = b'tmpSo' in v and b'_tmp_so_' not in v
with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\varname_fix.txt','w') as rf:
    rf.write(f'{"OK" if ok else "FAIL"} tmpSo_ct={v.count(b"tmpSo")} under_ct={v.count(b"_tmp_so_")}')
