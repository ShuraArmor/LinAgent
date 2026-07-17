import sys
path = r'E:\ProjBuild\SelfLearn\LinProject\simulink_bridge.py'
with open(path,'rb') as f: data = f.read()

idx = data.find(b'DataLogging on all Outports')
if idx >= 0:
    # Find the start of the try block and end (before SaveOutput set)
    block_start = data.rfind(b'\n        # Enable', 0, idx)
    block_end = data.find(b'\n\n        self.engine.set_param(name, \"SaveOutput\"', idx)
    if block_start >= 0 and block_end >= 0:
        replacement = b'\n        # Enable SignalLogging for output capture\n        try:\n            self.engine.set_param(name, "SignalLogging", "on", nargout=0)\n        except Exception:\n            pass'
        new_data = data[:block_start] + replacement + data[block_end:]
        with open(path, 'wb') as f: f.write(new_data)
        with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\bridge_fix4.txt', 'w') as f:
            f.write(f'OK size={len(new_data)} SignalLogging={"SignalLogging" in new_data.decode("latin-1")}')
    else:
        with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\bridge_fix4.txt', 'w') as f:
            f.write(f'boundary: start={block_start} end={block_end}')
else:
    with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\bridge_fix4.txt', 'w') as f:
        f.write(f'DataLogging not found at byte search')
