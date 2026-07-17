import os, sys
sys.path.insert(0, r'E:\ProjBuild\SelfLearn\LinProject')
from simulink_bridge import SimulinkBridge

b = SimulinkBridge()
b.start()
eng = b.engine
name = b.open_model(r'E:\ProjBuild\SelfLearn\LinProject\power_system.slx')
print(f"Model: {name}")

# DON'T set DataLogging on individual Outports - it doesn't exist
# Just use SaveOutput=on
eng.set_param(name, 'SaveOutput', 'on', nargout=0)
eng.set_param(name, 'SaveTime', 'on', nargout=0)
eng.set_param(name, 'StopTime', '0.1', nargout=0)
so = eng.sim(name, nargout=1)

eng.workspace['_dbg_'] = so
try:
    n_elem = int(float(str(eng.eval("_dbg_.yout.numElements", nargout=1))))
    print(f"yout.numElements: {n_elem}")
    if n_elem > 0:
        for i in range(1, min(n_elem+1, 4)):
            ts = eng.eval("_dbg_.yout{%d}" % i, nargout=1)
            nm = str(eng.getfield(ts, 'Name'))
            vals = eng.getfield(ts, 'Values')
            vlen = len(vals) if hasattr(vals,'__iter__') and not isinstance(vals,str) else 0
            print(f"  [{i}] {nm}: {vlen} values")
    else:
        print("EMPTY yout - trying without DataLogging set")
except Exception as e:
    print(f"Error: {e}")

eng.eval("clear _dbg_", nargout=0)
b.stop()
print("Done")
