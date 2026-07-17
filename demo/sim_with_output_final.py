    def sim_with_output(self, model_name: Optional[str] = None, stop_time: float = 10.0) -> dict:
        """Run sim + return time + signals via struct(so).Data (R2024b compatible)."""
        name = model_name or self._model_loaded
        if name is None:
            raise RuntimeError("No model open")

        # Enable DataLogging on Outport port handles
        try:
            self.engine.eval(
                "ops = find_system('" + name + "', 'BlockType', 'Outport');"
                "for i = 1:length(ops), ph = get_param(ops{i}, 'PortHandles');"
                "if isfield(ph, 'Outport') && ~isempty(ph.Outport),"
                "set_param(ph.Outport, 'DataLogging', 'on'); end; end; clear ops ph",
                nargout=0
            )
        except Exception:
            pass

        self.engine.set_param(name, "SaveOutput", "on", nargout=0)
        self.engine.set_param(name, "SignalLogging", "on", nargout=0)
        self.engine.set_param(name, "StopTime", str(stop_time), nargout=0)
        sim_out = self.engine.sim(name, nargout=1)

        # Extract time
        tout = []
        try:
            tout_raw = self.engine.getfield(sim_out, "tout")
            if tout_raw is not None and hasattr(tout_raw, '__iter__') and not isinstance(tout_raw, str):
                tout = [_ml_to_float(x) for x in tout_raw]
                tout = [t for t in tout if t is not None]
        except Exception:
            pass

        # Extract signals from struct(so).Data
        signals = {}
        try:
            # Use MATLAB eval to get struct data
            self.engine.workspace['tmpSo'] = sim_out
            # Get field names from struct(so).Data
            self.engine.eval(
                "tmpS = struct(tmpSo); tmpD = tmpS.Data; tmpDFn = fieldnames(tmpD);"
                "for i = 1:length(tmpDFn)"
                "  fn = tmpDFn{i};"
                "  if ~strcmp(fn, 'tout')"
                "    assignin('base', ['sig_' fn{1}], tmpD.(fn));"
                "  end;"
                "end;"
                "clear tmpS tmpD tmpDFn fn",
                nargout=0
            )
            # Read workspace variables
            vars_list = self.engine.eval("who('sig_*')", nargout=1)
            if vars_list:
                for vn in vars_list:
                    vn_str = str(vn).strip()
                    if vn_str.startswith('sig_'):
                        sig_name = vn_str[4:]  # remove 'sig_' prefix
                        try:
                            raw = self.engine.workspace[vn_str]
                            if raw is not None and hasattr(raw, '__iter__') and not isinstance(raw, str):
                                vals = [_ml_to_float(x) for x in raw]
                                signals[sig_name] = [v for v in vals if v is not None]
                            else:
                                signals[sig_name] = _ml_to_float(raw)
                        except Exception:
                            pass
            self.engine.eval("clear tmpSo", nargout=0)
        except Exception:
            pass

        return {
            "model": name,
            "stop_time": stop_time,
            "time": tout,
            "output": None,
            "signals": signals,
        }
