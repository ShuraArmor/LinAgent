import sys
sys.path.insert(0, r'E:\ProjBuild\SelfLearn\LinProject')
from simulink_bridge import _ml_to_float
import matlab.engine

eng = matlab.engine.start_matlab()
name = 'power_system'
eng.load_system(name, nargout=0)

# Set DataLogging on port handles
eng.eval(
    "ops = find_system('power_system', 'BlockType', 'Outport');"
    "for i = 1:length(ops)"
    "  ph = get_param(ops{i}, 'PortHandles');"
    "  if isfield(ph, 'Outport') && ~isempty(ph.Outport)"
    "    set_param(ph.Outport, 'DataLogging', 'on');"
    "  end;"
    "end; clear ops ph",
    nargout=0
)

eng.set_param(name, 'SignalLogging', 'on', nargout=0)
eng.set_param(name, 'SaveOutput', 'on', nargout=0)
eng.set_param(name, 'StopTime', '0.1', nargout=0)
so = eng.sim(name, nargout=1)
eng.workspace['so'] = so

# Check all fields
fields_str = str(eng.eval('fieldnames(so)', nargout=1))
print(f"Fields: {fields_str}")

# Try logsout
try:
    ne = int(float(str(eng.eval('so.logsout.numElements', nargout=1))))
    print(f"logsout.numElements: {ne}")
    if ne > 0:
        for i in range(1, min(ne+1, 4)):
            ts = eng.eval('so.logsout{%d}' % i, nargout=1)
            nm = str(eng.getfield(ts, 'Name'))
            vals = eng.getfield(ts, 'Values')
            vl = len(vals) if hasattr(vals,'__iter__') and not isinstance(vals,str) else 0
            print(f"  [{i}] {nm}: {vl} values, first={float(vals[0]):.4f}")
except Exception as e:
    print(f"logsout error: {e}")

# Try tout
try:
    tout_raw = eng.eval('so.tout', nargout=1)
    tl = len(tout_raw) if hasattr(tout_raw,'__iter__') else 0
    print(f"tout: {tl} pts")
except Exception as e:
    print(f"tout error: {e}")

eng.eval('clear so', nargout=0)
eng.quit()
print("Done")
