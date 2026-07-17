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
    assignin('base', 'stout', so.tout);
    % Explore Data field
    d = so.Data;
    fprintf('Data class: %s\\n', class(d));
    dfn = fieldnames(d);
    fprintf('Data fields (%d): ', length(dfn));
    for i = 1:length(dfn), fprintf('%s ', dfn{i}); end;
    fprintf('\\n');
    % Check if there's a logsout-like field
    if isfield(d, 'logsout')
        fprintf('logsout exists! numElements=%d\\n', d.logsout.numElements);
    end;
    if isfield(d, 'yout')
        fprintf('yout exists! numElements=%d\\n', d.yout.numElements);
    end;
    clear ops ph so d dfn
""", nargout=0)

stout = eng.workspace['stout']
if hasattr(stout, '__iter__'):
    print(f'tout: {len(stout)} pts, first={float(stout[0]):.6f}')

eng.eval('clear stout', nargout=0)
eng.quit()
print('Done')
