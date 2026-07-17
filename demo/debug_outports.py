import os, sys
sys.path.insert(0, r'E:\ProjBuild\SelfLearn\LinProject')
from simulink_bridge import SimulinkBridge

b = SimulinkBridge()
b.start()
name = 'power_system'
eng = b.engine

print("=== Debug: Outport DataLogging ===")
# 1. Try finding Outports with eval
eng.eval("ops = find_system('%s', 'BlockType', 'Outport');" % name, nargout=0)
n_ops = int(float(str(eng.eval("length(ops)", nargout=1))))
print(f"Outports found: {n_ops}")

# 2. Enable DataLogging on each
if n_ops > 0:
    for i in range(n_ops):
        p = str(eng.eval("ops{%d}" % (i+1), nargout=1))
        eng.set_param(p, 'DataLogging', 'on', nargout=0)
        print(f"  {p}: DataLogging set to on")
else:
    # Maybe model not loaded properly? Try with 'FindAll'
    eng.eval("ops = find_system('%s', 'FindAll', 'on', 'BlockType', 'Outport');" % name, nargout=0)
    n_ops = int(float(str(eng.eval("length(ops)", nargout=1))))
    print(f"With FindAll=on: {n_ops} Outports")

# 3. Run sim
eng.set_param(name, 'SaveOutput', 'on', nargout=0)
eng.set_param(name, 'SaveTime', 'on', nargout=0)
eng.set_param(name, 'StopTime', '0.1', nargout=0)
so = eng.sim(name, nargout=1)

# 4. Check yout
eng.workspace['_dbg_so_'] = so
yout_type = str(eng.eval("class(_dbg_so_.yout)", nargout=1))
print(f"yout class: {yout_type}")
n_elem = int(float(str(eng.eval("_dbg_so_.yout.numElements", nargout=1))))
print(f"yout.numElements: {n_elem}")

# 5. If elements exist, extract
if n_elem > 0:
    ts = eng.eval("_dbg_so_.yout{1}", nargout=1)
    sig_name = str(eng.getfield(ts, 'Name'))
    vals = eng.getfield(ts, 'Values')
    print(f"Signal 1: name={sig_name}, values_type={type(vals)}, len={len(vals) if hasattr(vals,'__iter__') else 'scalar'}")

eng.eval("clear _dbg_so_ ops", nargout=0)
b.stop()
print("=== Done ===")
