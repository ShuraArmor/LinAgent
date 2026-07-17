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
    set_param('power_system', 'StopTime', '0.1');
    so = sim('power_system');
    assignin('base', 'tout', so.tout);
    s = struct(so);
    if isfield(s, 'Data')
        d = s.Data;
        dfn = fieldnames(d);
        fprintf('Data fields: ');
        for i=1:length(dfn), fprintf('%s ', dfn{i}); end;
        fprintf('\\n');
        if isfield(d, 'logsout')
            fprintf('logsout: %d elem\\n', d.logsout.numElements);
        end;
        if isfield(d, 'yout')
            fprintf('yout: %d elem\\n', d.yout.numElements);
        end;
    end;
    clear ops ph so s d dfn
""", nargout=0)

tout = eng.workspace['tout']
print(f'tout: {len(tout)} pts')
eng.quit()
