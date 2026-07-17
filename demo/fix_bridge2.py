import sys
path = r'E:\ProjBuild\SelfLearn\LinProject\simulink_bridge.py'
with open(path, 'rb') as f:
    data = f.read()

# Find and replace: add try/except around DataLogging eval
old = b"        # Enable DataLogging on all Outports using MATLAB eval\n        self.engine.eval("
new = b"        # Enable DataLogging on all Outports using MATLAB eval\n        try:\n            self.engine.eval("

if old in data:
    data = data.replace(old, new, 1)
    # Now add the closing except block after nargout=0)
    old2 = b'            nargout=0\n        )\n\n        self.engine.set_param'
    new2 = b'            nargout=0\n            )\n        except Exception:\n            pass\n\n        self.engine.set_param'
    if old2 in data:
        data = data.replace(old2, new2, 1)
    
    with open(path, 'wb') as f:
        f.write(data)
    
    # verify
    with open(path, 'rb') as f:
        v = f.read()
    ok = v.find(b'try:') > 0 and v.find(b'except Exception:') > v.find(b'DataLogging')
    # Write result to a file we can read
    with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\bridge_fix_result.txt', 'w') as rf:
        rf.write(f'{"OK" if ok else "FAIL"} size={len(v)}')
else:
    with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\bridge_fix_result.txt', 'w') as rf:
        rf.write(f'NOT_FOUND old marker at {data.find(b"DataLogging")}')
