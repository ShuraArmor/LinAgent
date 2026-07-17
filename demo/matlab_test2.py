"""测试：Python 侧读取 MATLAB workspace 中的信号变量"""
import matlab.engine

eng = matlab.engine.start_matlab()
eng.cd(r'E:\ProjBuild\SelfLearn\LinProject', nargout=0)
eng.load_system('power_system', nargout=0)

eng.eval("""
    ops = find_system('power_system', 'BlockType', 'Outport');
    for i = 1:length(ops)
        ph = get_param(ops{i}, 'PortHandles');
        if isfield(ph, 'Outport') && ~isempty(ph.Outport)
            set_param(ph.Outport, 'DataLogging', 'on');
        end;
    end;
    set_param('power_system', 'SaveOutput', 'on');
    set_param('power_system', 'SignalLogging', 'on');
    set_param('power_system', 'SaveTime', 'on');
    set_param('power_system', 'StopTime', '0.3');
    so = sim('power_system');
    s = struct(so);
    d = s.Data;
    fn = fieldnames(d);
    for i = 1:length(fn)
        fname = fn{i};
        assignin('base', fname, d.(fname));
    end;
    clear ops ph so s d fn
""", nargout=0)

# Read tout
tout_raw = eng.workspace['tout']
tout = [float(tout_raw[i][0]) if hasattr(tout_raw[i], '__getitem__') else float(tout_raw[i]) for i in range(len(tout_raw))]
print(f"tout: {len(tout)} pts, first={tout[0]:.6f}, last={tout[-1]:.4f}")

# Read signals
for sn in ['Freq_out','I_bat_out','P_gen_out','SOC_out','V_bat_out','V_bus_out','V_conv_out','duty_out']:
    try:
        raw = eng.workspace[sn]
        vals = [float(raw[i][0]) if hasattr(raw[i], '__getitem__') else float(raw[i]) for i in range(len(raw)) if raw[i] is not None]
        print(f"  {sn}: {len(vals)} vals [{vals[0]:.4f}..{vals[-1]:.4f}]")
    except Exception as e:
        print(f"  {sn}: MISSING ({e})")

eng.eval("clear all", nargout=0)
eng.quit()
