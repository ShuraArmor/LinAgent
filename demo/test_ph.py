import sys
sys.path.insert(0, r'E:\ProjBuild\SelfLearn\LinProject')
from simulink_bridge import _ml_to_float
import matlab.engine

print("Starting MATLAB...")
eng = matlab.engine.start_matlab()
name = 'power_system'
eng.load_system(name, nargout=0)
print(f"Loaded: {name}")

# Method 1: PortHandles approach
eng.eval(
    "ops = find_system('power_system', 'BlockType', 'Outport');"
    "fprintf('Found %d Outports\\n', length(ops));"
    "for i = 1:length(ops)"
    "  ph = get_param(ops{i}, 'PortHandles');"
    "  fprintf('  %s: has Outport field=%d\\n', ops{i}, isfield(ph, 'Outport'));"
    "  if isfield(ph, 'Outport') && ~isempty(ph.Outport)"
    "    set_param(ph.Outport, 'DataLogging', 'on');"
    "  end;"
    "end;"
    "clear ops ph",
    nargout=0
)

eng.set_param(name, 'SaveOutput', 'on', nargout=0)
eng.set_param(name, 'StopTime', '0.1', nargout=0)
so = eng.sim(name, nargout=1)
eng.workspace['so'] = so

# Check yout via eval
ne = int(float(str(eng.eval('so.yout.numElements', nargout=1))))
print(f"yout.numElements: {ne}")

if ne > 0:
    for i in range(1, min(ne+1, 4)):
        ts = eng.eval('so.yout{%d}' % i, nargout=1)
        nm = str(eng.getfield(ts, 'Name'))
        vals = eng.getfield(ts, 'Values')
        vl = len(vals) if hasattr(vals, '__iter__') and not isinstance(vals, str) else 0
        print(f"  [{i}] {nm}: {vl} values, first={float(vals[0]):.4f}")
else:
    # Try logsout
    print("yout empty, trying logsout...")
    try:
        ne2 = int(float(str(eng.eval('so.logsout.numElements', nargout=1))))
        print(f"logsout.numElements: {ne2}")
    except:
        print("logsout also not available")
    
    # Method 2: direct workspace variables
    print("\nTrying workspace vars...")
    vars_list = eng.eval("who", nargout=1)
    print(f"Workspace vars: {vars_list}")

eng.eval('clear so', nargout=0)
eng.quit()
print("Done")
