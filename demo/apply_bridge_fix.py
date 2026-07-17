path = r'E:\ProjBuild\SelfLearn\LinProject\simulink_bridge.py'
with open(path, 'rb') as f:
    data = f.read()

old_start = data.find(b'    def sim_with_output(')
next_start = data.find(b'    def sim_with_io(')

# Read the new method from a file
with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\sim_with_output_final.py', 'r', encoding='utf-8') as f:
    new_code = f.read()

new_data = data[:old_start] + new_code.encode('utf-8') + data[next_start:]
with open(path, 'wb') as f:
    f.write(new_data)

# verify
with open(path, 'rb') as f:
    v = f.read()
ok = b'PortHandles' in v and b'struct(tmpSo' in v
with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\bridge_final.txt', 'w') as rf:
    rf.write(f'OK={ok}')
