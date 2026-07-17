
@app.get("/api/debug/sim-output")
def debug_sim_output():
    """诊断端点：直接查看 MATLAB sim() 返回值中 yout 的数据结构"""
    bridge = get_bridge()
    if not bridge.model_loaded:
        return {"error": "no model loaded"}

    name = bridge.model_loaded
    eng = bridge.engine

    # 1. 列出所有 Outport 及 DataLogging 状态
    outport_info = []
    try:
        ops = eng.find_system(name, 'SearchDepth', float('inf'), 'BlockType', 'Outport')
        for op in ops:
            p = str(op)
            try:
                dl = str(eng.get_param(p, 'DataLogging'))
            except:
                dl = '<error>'
            outport_info.append({"path": p, "DataLogging": dl})
    except Exception as e:
        outport_info = [{"error": str(e)}]

    # 2. 跑快速仿真并检查 yout
    sim_diag = {}
    try:
        eng.set_param(name, 'SaveOutput', 'on', nargout=0)
        eng.set_param(name, 'SaveTime', 'on', nargout=0)
        eng.set_param(name, 'StopTime', '0.1', nargout=0)
        so = eng.sim(name, nargout=1)
        
        # 检查字段
        sim_diag["fields"] = [str(f) for f in dir(so)][:20]
        
        try:
            y = eng.getfield(so, 'yout')
            sim_diag["yout_type"] = str(type(y))
            sim_diag["yout_dir"] = [str(f) for f in dir(y)][:20]
            try:
                n = int(eng.eval("_tmp_so_.yout.numElements", nargout=1)) if False else 0
            except:
                pass
        except Exception as e:
            sim_diag["yout_error"] = str(e)

        # 用 MATLAB eval 检查
        eng.workspace['_debug_so_'] = so
        matlab_checks = {}
        for cmd in [
            "class(_debug_so_.yout)",
            "isa(_debug_so_.yout, 'Simulink.SimulationData.Dataset')", 
            "_debug_so_.yout.numElements",
            "size(_debug_so_.yout)",
        ]:
            try:
                matlab_checks[cmd] = str(eng.eval(cmd, nargout=1))
            except Exception as e:
                matlab_checks[cmd] = f"ERROR: {e}"
        sim_diag["matlab_eval"] = matlab_checks
        
        # 如果 numElements > 0，提取第一个信号
        try:
            n = int(float(str(eng.eval("_debug_so_.yout.numElements", nargout=1))))
            sim_diag["numElements_parsed"] = n
            if n > 0:
                ts = eng.eval("_debug_so_.yout{1}", nargout=1)
                sim_diag["first_signal_name"] = str(eng.getfield(ts, 'Name'))
                sim_diag["first_signal_type"] = str(type(ts))
                vals = eng.getfield(ts, 'Values')
                if hasattr(vals, '__iter__') and not isinstance(vals, str):
                    sim_diag["first_signal_len"] = len(vals)
        except Exception as e:
            sim_diag["extract_error"] = str(e)
        
        eng.eval("clear _debug_so_", nargout=0)
    except Exception as e:
        sim_diag["sim_error"] = str(e)

    return {
        "model": name,
        "outports": outport_info,
        "sim_diag": sim_diag,
    }
