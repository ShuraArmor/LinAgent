import os

path = r'E:\ProjBuild\SelfLearn\LinProject\simulink_bridge.py'
with open(path, 'rb') as f:
    data = f.read()

# 把整个 sim_with_output 方法替换为纯 MATLAB eval 驱动版本
old_marker = b'    def sim_with_output('
next_marker = b'    def sim_with_io('

idx_old = data.find(old_marker)
idx_next = data.find(next_marker)

if idx_old < 0 or idx_next < 0:
    print(f'ERROR: old={idx_old} next={idx_next}')
else:
    new_method = b'''    def sim_with_output(self, model_name: Optional[str] = None, stop_time: float = 10.0) -> dict:
        """Run sim and return time + logged signals via MATLAB eval."""
        name = model_name or self._model_loaded
        if name is None:
            raise RuntimeError("No model open")

        # Enable DataLogging on all Outports using MATLAB eval
        self.engine.eval(
            "ops=find_system('" + name + "', 'BlockType', 'Outport');"
            "for i=1:length(ops), set_param(ops{i}, 'DataLogging', 'on'); end; clear ops",
            nargout=0
        )

        self.engine.set_param(name, "SaveOutput", "on", nargout=0)
        self.engine.set_param(name, "SaveTime", "on", nargout=0)
        self.engine.set_param(name, "StopTime", str(stop_time), nargout=0)
        sim_out = self.engine.sim(name, nargout=1)

        # Read time
        tout = []
        try:
            tout_raw = self.engine.getfield(sim_out, "tout")
            if tout_raw is not None and hasattr(tout_raw, '__iter__') and not isinstance(tout_raw, str):
                tout = [_ml_to_float(x) for x in tout_raw]
                tout = [t for t in tout if t is not None]
        except Exception:
            pass

        # Extract signals from yout Dataset using MATLAB eval
        signals = {}
        try:
            self.engine.workspace['_tmp_so_'] = sim_out
            n = self.engine.eval(
                "y = _tmp_so_.yout; "
                "if isa(y, 'Simulink.SimulationData.Dataset'), y.numElements; else 0; end",
                nargout=1
            )
            n = int(float(str(n)))
            for i in range(1, n + 1):
                try:
                    ts = self.engine.eval("_tmp_so_.yout{" + str(i) + "}", nargout=1)
                    name_i = str(self.engine.getfield(ts, "Name"))
                    vals_raw = self.engine.getfield(ts, "Values")
                    if vals_raw is not None and hasattr(vals_raw, '__iter__') and not isinstance(vals_raw, str):
                        vals = [_ml_to_float(v) for v in vals_raw]
                        signals[name_i] = [v for v in vals if v is not None]
                except Exception:
                    pass
            self.engine.eval("clear _tmp_so_", nargout=0)
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

    new_data = data[:idx_old] + new_method + data[idx_next:]
    with open(path, 'wb') as f:
        f.write(new_data)
    
    # 验证
    with open(path, 'rb') as f:
        v = f.read()
    ok = b'isa' in v and b'DataLogging' in v and b'_tmp_so_' in v
    print(f'OK={ok}  size: {len(v)} bytes')
