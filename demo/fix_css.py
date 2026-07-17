path = r'E:\ProjBuild\SelfLearn\LinProject\electron-app\src\App.css'
with open(path, 'rb') as f:
    data = f.read()

# Replace dark bg for output-panel
data = data.replace(b'#1E1E1E', b'#F5F5F5', 1)
data = data.replace(b'#2D2D2D', b'#E8E8E8', 1)
data = data.replace(b'color: #AAA', b'color: #666', 1)
data = data.replace(b'color: #D4D4D4', b'color: #333', 1)
data = data.replace(b'background: #444', b'background: #DDD', 1)
data = data.replace(b'color: #CCC', b'color: #555', 1)
data = data.replace(b'border: none', b'border: 1px solid #CCC', 1)
data = data.replace(b'background: #555', b'background: #C0C0C0', 1)
# Log colors
data = data.replace(b'#6A9955', b'var(--text-muted)', 2)  # ts and ok
data = data.replace(b'#9CDCFE', b'var(--accent)')
data = data.replace(b'#CE9178', b'var(--warning)')
data = data.replace(b'#F44747', b'var(--danger)')

with open(path, 'wb') as f:
    f.write(data)

# verify
v = open(path, 'rb').read()
ok = b'#1E1E1E' not in v and b'#2D2D2D' not in v and b'#AAA' not in v
with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\css_fix_result.txt', 'w') as rf:
    rf.write(f'OK={ok}')
