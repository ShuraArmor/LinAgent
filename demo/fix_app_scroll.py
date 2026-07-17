path = r'E:\ProjBuild\SelfLearn\LinProject\electron-app\src\App.jsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

# Fix center-area children - use display flex/none + flex:1 + overflow:hidden
# to allow children's internal overflow to work
old = """        <div className="center-area">
          <div style={{display:activeTab==='env'?'block':'none'}}><EnvPanel envStatus={envStatus} envLoading={envLoading} onEnvScan={runEnvScan} /></div>
          <div style={{display:activeTab==='model_info'?'block':'none'}}><div className="work-area"><ModelInfo modelInfo={modelInfo} loading={modelInfoLoading} onRefresh={fetchModelInfo} addLog={addLocalLog} /></div></div>
          <div style={{display:activeTab==='interactive'?'block':'none'}}><div className="work-area"><InputControl modelInfo={modelInfo} addLog={addLocalLog} /></div></div>
        </div>"""

new = """        <div className="center-area">
          <div style={{display:activeTab==='env'?'flex':'none',flex:1,minHeight:0}}><EnvPanel envStatus={envStatus} envLoading={envLoading} onEnvScan={runEnvScan} /></div>
          <div style={{display:activeTab==='model_info'?'flex':'none',flex:1,minHeight:0,overflow:'hidden'}}><div className="work-area"><ModelInfo modelInfo={modelInfo} loading={modelInfoLoading} onRefresh={fetchModelInfo} addLog={addLocalLog} /></div></div>
          <div style={{display:activeTab==='interactive'?'flex':'none',flex:1,minHeight:0,overflow:'hidden'}}><InputControl modelInfo={modelInfo} addLog={addLocalLog} /></div>
        </div>"""

c = c.replace(old, new, 1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(c)

# Verify
v = open(path, 'r', encoding='utf-8').read()
with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\app_fix_result.txt', 'w') as f:
    f.write(f"center fixed={'flex:1,minHeight:0' in v} model_info={'overflow' in v.split('model_info')[1].split('activeTab')[0] if 'model_info' in v else 'MISSING'}")
