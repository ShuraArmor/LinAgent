import sys

path = r'E:\ProjBuild\SelfLearn\LinProject\simulink_bridge.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

old_start = content.find('\n    def sim_with_output(')
old_end = content.find('\n    def sim_with_io(')

if old_start == -1 or old_end == -1:
    print(f'ERROR: start={old_start}, end={old_end}')
    sys.exit(1)

old_method = content[old_start:old_end]

new_method = '''
    def sim_with_output(self, model_name: Optional[str] = None, stop_time: float = 10.0) -> dict:
        """运行仿真并返回时间序列 + 输出信号"""
        name = model_name or self._model_loaded
        if name is None:
            raise RuntimeError("No model open")

        # 启用所有 Outport 块的 DataLogging
        try:
            outports = self.engine.find_system(name, 'BlockType', 'Outport')
            for op in outports:
                self.engine.set_param(str(op), 'DataLogging', 'on', nargout=0)
        except Exception:
            pass

        self.engine.set_param(name, "SaveOutput", "on", nargout=0)
        self.engine.set_param(name, "SaveTime", "on", nargout=0)
        self.engine.set_param(name, "StopTime", str(stop_time), nargout=0)
        sim_out = self.engine.sim(name, nargout=1)

        # 读取时间向量
        tout = []
        try:
            tout_raw = self.engine.getfield(sim_out, "tout")
            if tout_raw is not None and hasattr(tout_raw, '__iter__') and not isinstance(tout_raw, str):
                tout = [_ml_to_float(x) for x in tout_raw]
                tout = [t for t in tout if t is not None]
        except Exception:
            pass

        # 将 sim_out 推入 MATLAB 工作区，提取 yout Dataset 中的信号
        signals = {}
        try:
            self.engine.workspace['_sim_out_'] = sim_out
            n_elems = 0
            try:
                n_elems = int(self.engine.eval("_sim_out_.yout.numElements", nargout=1))
            except Exception:
                pass

            for i in range(1, n_elems + 1):  # MATLAB 1-indexed
                try:
                    ts = self.engine.eval("_sim_out_.yout{{{}}}".format(i), nargout=1)
                    sig_name = str(self.engine.getfield(ts, "Name"))
                    values_raw = self.engine.getfield(ts, "Values")
                    if values_raw is not None and hasattr(values_raw, '__iter__') and not isinstance(values_raw, str):
                        vals = [_ml_to_float(x) for x in values_raw]
                        signals[sig_name] = [v for v in vals if v is not None]
                except Exception:
                    pass

            self.engine.eval("clear _sim_out_", nargout=0)
        except Exception:
            pass

        return {
            "model": name,
            "stop_time": stop_time,
            "time": tout,
            "output": None,
            "signals": signals,
        }
'''

new_content = content[:old_start] + new_method + content[old_end:]
with open(path, 'w', encoding='utf-8') as f:
    f.write(new_content)

# Verify
with open(path, 'r', encoding='utf-8') as f:
    verify = f.read()
if 'DataLogging' in verify and '_sim_out_' in verify:
    print('OK - bridge patched successfully')
else:
    print('FAIL - verification failed')
