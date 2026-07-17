path = r'E:\ProjBuild\SelfLearn\LinProject\electron-app\src\App.jsx'
with open(path, 'rb') as f:
    data = f.read()

# Replace each conditional render - the file uses exactly:
#   <div style={{display:activeTab==='env'?'block':'none'}}><EnvPanel ... /></div>
#   <div style={{display:activeTab==='model_info'?'block':'none'}}><div className="work-area"><ModelInfo ... /></div></div>
#   <div style={{display:activeTab==='interactive'?'block':'none'}}><div className="work-area"><InputControl ... /></div></div>

old1 = b"<div style={{display:activeTab==='env'?'block':'none'}}><EnvPanel envStatus={envStatus} envLoading={envLoading} onEnvScan={runEnvScan} /></div>"
new1 = b"<div style={{display:activeTab==='env'?'flex':'none',flex:1,minHeight:0,overflow:'auto'}}><EnvPanel envStatus={envStatus} envLoading={envLoading} onEnvScan={runEnvScan} /></div>"

old2 = b"<div style={{display:activeTab==='model_info'?'block':'none'}}><div className=\"work-area\"><ModelInfo modelInfo={modelInfo} loading={modelInfoLoading} onRefresh={fetchModelInfo} addLog={addLocalLog} /></div></div>"
new2 = b"<div style={{display:activeTab==='model_info'?'flex':'none',flex:1,minHeight:0,overflow:'auto'}}><ModelInfo modelInfo={modelInfo} loading={modelInfoLoading} onRefresh={fetchModelInfo} addLog={addLocalLog} /></div>"

old3 = b"<div style={{display:activeTab==='interactive'?'block':'none'}}><div className=\"work-area\"><InputControl modelInfo={modelInfo} addLog={addLocalLog} /></div></div>"
new3 = b"<div style={{display:activeTab==='interactive'?'flex':'none',flex:1,minHeight:0,overflow:'hidden'}}><InputControl modelInfo={modelInfo} addLog={addLocalLog} /></div>"

data = data.replace(old1, new1, 1)
data = data.replace(old2, new2, 1)
data = data.replace(old3, new3, 1)

with open(path, 'wb') as f:
    f.write(data)

# verify
v = open(path, 'rb').read()
with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\scroll_fix_done.txt', 'w') as r:
    r.write(f"flex: {b'flex:1,minHeight:0' in v}, no double work-area: {b'work-area' not in v.split(b'model_info')[1][:200] if b'model_info' in v else 'MISSING'}")
