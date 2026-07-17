import sys
sys.path.insert(0, r'E:\ProjBuild\SelfLearn\LinProject')
from simulink_bridge import SimulinkBridge

b = SimulinkBridge()
b.start()
eng = b.engine
n = b.open_model(r'E:\ProjBuild\SelfLearn\LinProject\power_system.slx')

# Set model params
for k in ['SaveOutput', 'SignalLogging', 'SaveTime']:
    eng.set_param(n, k, 'on', nargout=0)

# Run sim
so = eng.sim(n, nargout=1)
print(f"sim_out type: {type(so)}")
print(f"sim_out dir: {[f for f in dir(so) if not f.startswith('_')]}")

# Push to workspace and extract with eval
eng.workspace['so'] = so
eng.eval('tout = so.tout; yout = so.yout;', nargout=0)

tout_w = eng.workspace.get('tout', None)
yout_w = eng.workspace.get('yout', None)

print(f"tout: type={type(tout_w)}")
if tout_w is not None:
    try:
        if hasattr(tout_w, '__iter__') and not isinstance(tout_w, str):
            print(f"  len={len(tout_w)}, first={tout_w[0]}, last={tout_w[-1]}")
    except:
        print(f"  (scalar or error)")

print(f"yout: type={type(yout_w)}")
if yout_w is not None:
    eng.workspace['y'] = yout_w
    try:
        ne = int(float(str(eng.eval('y.numElements', nargout=1))))
        print(f"  numElements={ne}")
        if ne > 0:
            for i in range(1, min(ne+1, 4)):
                ts = eng.eval('y{%d}' % i, nargout=1)
                nm = str(eng.getfield(ts, 'Name'))
                vals = eng.getfield(ts, 'Values')
                vl = len(vals) if hasattr(vals, '__iter__') and not isinstance(vals, str) else 0
                print(f"  [{i}] {nm}: {vl} values")
    except Exception as e:
        print(f"  Error: {e}")

eng.eval('clear so tout yout y', nargout=0)
b.stop()
print("Done")
