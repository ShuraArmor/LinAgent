path = r'E:\ProjBuild\SelfLearn\LinProject\electron-app\src\App.jsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

old = """        <button onClick={runEnvScan}>环境扫描</button>
        <button onClick={importSlx} disabled={!envReady}>导入 SLX</button>
        <button onClick={loadModel} disabled={!envReady}>加载模型</button>
        <button onClick={refreshHierarchy}>刷新</button>"""

new = """        <button onClick={importSlx} disabled={!envReady}>导入 SLX</button>"""

c = c.replace(old, new, 1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(c)

# verify
v = open(path, 'r', encoding='utf-8').read()
print('环境扫描 removed:', 'runEnvScan' not in v.split('toolbar')[1].split('sep')[0])
print('加载模型 removed:', 'loadModel' not in v.split('toolbar')[1].split('sep')[0])
print('刷新 removed:', 'refreshHierarchy' not in v.split('toolbar')[1].split('sep')[0])
print('导入SLX kept:', 'importSlx' in v.split('toolbar')[1].split('sep')[0])
