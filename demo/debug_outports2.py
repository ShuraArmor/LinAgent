import os, sys
sys.path.insert(0, r'E:\ProjBuild\SelfLearn\LinProject')
from simulink_bridge import SimulinkBridge

b = SimulinkBridge()
b.start()
eng = b.engine

# Load the model
name = b.open_model(r'E:\ProjBuild\SelfLearn\LinProject\power_system.slx')
print(f"Model loaded: {name}")

print("=== Debug: Outport DataLogging ===")

# Try find_system with Python API
ops_py = eng.find_system(name, 'BlockType', 'Outport')
print(f"Python find_system: {len(ops_py)} Outports")
if len(ops_py) > 0:
    for op in ops_py[:3]:
        print(f"  {op}")
else:
    # Try with eval
    eng.eval("ops = find_system('%s', 'BlockType', 'Outport');" % name, nargout=0)
    n_ops = int(float(str(eng.eval("length(ops)", nargout=1))))
    print(f"MATLAB eval find_system: {n_ops} Outports")
    if n_ops > 0:
        for i in range(min(n_ops, 3)):
            p = str(eng.eval("ops{%d}" % (i+1), nargout=1))
            print(f"  {p}")

# Enable DataLogging on all
eng.eval(
    "ops = find_system('%s', 'BlockType', 'Outport');" % name +
    "for i = 1:length(ops), set_param(ops{i}, 'DataLogging', 'on'); end; clear ops",
    nargout=0
)
print("DataLogging enabled on all Outports")

# Run sim
eng.set_param(name, 'SaveOutput', 'on', nargout=0)
eng.set_param(name, 'StopTime', '0.1', nargout=0)
so = eng.sim(name, nargout=1)

# Check yout structure
eng.workspace['_dbg_'] = so
try:
    n_elem = int(float(str(eng.eval("_dbg_.yout.numElements", nargout=1))))
    print(f"yout.numElements: {n_elem}")
    if n_elem > 0:
        ts = eng.eval("_dbg_.yout{1}", nargout=1)
        print(f"  Signal 1 name: {eng.getfield(ts, 'Name')}")
        vals = eng.getfield(ts, 'Values')
        if hasattr(vals, '__iter__') and not isinstance(vals, str):
            print(f"  Values len: {len(vals)}")
            print(f"  First few: {[float(x) for x in vals[:5]]}")
    else:
        print("  No elements in yout!")
except Exception as e:
    print(f"Error: {e}")

eng.eval("clear _dbg_", nargout=0)
b.stop()
print("=== Done ===")
