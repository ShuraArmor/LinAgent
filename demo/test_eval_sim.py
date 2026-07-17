import sys
sys.path.insert(0, r'E:\ProjBuild\SelfLearn\LinProject')
import matlab.engine

eng = matlab.engine.start_matlab()
name = 'power_system'
eng.load_system(name, nargout=0)

# Everything via eval to stay in MATLAB domain
eng.eval("""
    ops = find_system('power_system', 'BlockType', 'Outport');
    fprintf('Outports: %d\\n', length(ops));
    for i = 1:length(ops)
        ph = get_param(ops{i}, 'PortHandles');
        if isfield(ph, 'Outport') && ~isempty(ph.Outport)
            set_param(ph.Outport, 'DataLogging', 'on');
        end;
    end;
    set_param('power_system', 'SaveOutput', 'on');
    set_param('power_system', 'SignalLogging', 'on');
    set_param('power_system', 'StopTime', '0.1');
    so = sim('power_system');
    assignin('base', 'tout', so.tout);
    if exist('so.logsout', 'var')
        fprintf('logsout exists!\\n');
        assignin('base', 'sigdata', so.logsout);
    else
        fprintf('logsout check via isfield: %d\\n', isfield(so, 'logsout'));
        fprintf('yout check via isfield: %d\\n', isfield(so, 'yout'));
        % Try to convert to struct
        s = struct(so);
        fn = fieldnames(s);
        fprintf('struct fields: ');
        for i = 1:length(fn), fprintf('%s ', fn{i}); end;
        fprintf('\\n');
    end;
    clear ops ph so fn s
""", nargout=0)

# Check what got assigned to workspace
tout_w = eng.workspace.get('tout', None)
if tout_w is not None and hasattr(tout_w, '__iter__') and not isinstance(tout_w, str):
    print(f"tout: {len(tout_w)} pts, first={float(tout_w[0])}")

sigdata_w = eng.workspace.get('sigdata', None)
print(f"sigdata: {type(sigdata_w)}")

# Check workspace variable list
vars_list = str(eng.eval("who", nargout=1))
print(f"Workspace: {vars_list}")

eng.eval("clear tout sigdata", nargout=0)
eng.quit()
print("Done")
