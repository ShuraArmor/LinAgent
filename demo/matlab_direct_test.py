"""纯 MATLAB eval 仿真：启动 MATLAB、加载模型、跑仿真、提取信号，全在 MATLAB 一侧完成"""
import matlab.engine, os, sys

eng = matlab.engine.start_matlab()
eng.cd(r'E:\ProjBuild\SelfLearn\LinProject', nargout=0)
eng.load_system('power_system', nargout=0)

# 纯 MATLAB 脚本：DataLogging + sim + 提取
script = """
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
    assignin('base', 'tout', so.tout);
    
    % try struct(so).Data approach
    s = struct(so);
    if isfield(s, 'Data')
        d = s.Data;
        fn = fieldnames(d);
        fprintf('Data fields (%d): ', length(fn));
        for i = 1:length(fn), fprintf('%s ', fn{i}); end;
        fprintf('\\n');
        for i = 1:length(fn)
            fname = fn{i};
            if ~strcmp(fname, 'tout')
                assignin('base', fname, d.(fname));
            end;
        end;
    else
        fprintf('No Data field in struct(so)\\n');
    end;
    clear ops ph so s d fn
"""

eng.eval(script, nargout=0)

# 读取 workspace 变量
tout = eng.workspace['tout']
print(f"tout: {len(tout)} pts, first={float(tout[0]):.6f}")

# 检查哪些信号变量被创建
import numpy as np
sigs = {}
for name in ['Freq_out','I_bat_out','P_gen_out','SOC_out','V_bat_out','V_bus_out','V_conv_out','duty_out']:
    try:
        raw = eng.workspace[name]
        if hasattr(raw, '__iter__') and not isinstance(raw, str):
            vals = [float(x) for x in raw if x is not None]
            if vals:
                sigs[name] = vals
                print(f"  {name}: {len(vals)} vals [{vals[0]:.4f}..{vals[-1]:.4f}]")
    except:
        pass

if not sigs:
    print("NO SIGNALS extracted!")
    # 列出所有 workspace 变量
    who = str(eng.eval("who", nargout=1))
    print(f"Workspace vars: {who}")

eng.eval("clear all", nargout=0)
eng.quit()
print("Done")
