import sys
sys.path.insert(0, r'E:\ProjBuild\SelfLearn\LinProject')
from simulink_bridge import SimulinkBridge

b = SimulinkBridge()
b.start()
eng = b.engine
n = b.open_model(r'E:\ProjBuild\SelfLearn\LinProject\power_system.slx')

# Set model params
eng.set_param(n, 'SaveOutput', 'on', nargout=0)
eng.set_param(n, 'SignalLogging', 'on', nargout=0)
eng.set_param(n, 'SaveTime', 'on', nargout=0)
eng.set_param(n, 'StopTime', '0.1', nargout=0)

so = eng.sim(n, nargout=1)
eng.workspace['so'] = so

# Check what fields are available
fields = eng.eval("fieldnames(so)", nargout=1)
print(f"Fields: {[str(f) for f in fields] if fields else 'None'}")

# Try logsout
has_logsout = str(eng.eval("isfield(so, 'logsout')", nargout=1))
print(f"has logsout: {has_logsout}")
if has_logsout.strip() == '1':
    eng.eval("ls = so.logsout;", nargout=0)
    n_elem = int(float(str(eng.eval("ls.numElements", nargout=1))))
    print(f"logsout.numElements: {n_elem}")

# Try tout
has_tout = str(eng.eval("isfield(so, 'tout')", nargout=1))
print(f"has tout: {has_tout}")

# Try yout
has_yout = str(eng.eval("isfield(so, 'yout')", nargout=1))
print(f"has yout: {has_yout}")

eng.eval("clear so ls", nargout=0)
b.stop()
print("Done")
