import matlab.engine

eng = matlab.engine.start_matlab()
eng.cd(r'E:\ProjBuild\SelfLearn\LinProject', nargout=0)
eng.load_system('power_system', nargout=0)
print('Model loaded: power_system')

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
    assignin('base', 'stout', so.tout);
    s = struct(so);
    fn = fieldnames(s);
    fprintf('struct fields: ');
    for i = 1:length(fn), fprintf('%s ', fn{i}); end;
    fprintf('\\n');
    % Check if logsout field exists in the struct
    for i = 1:length(fn)
        fname = fn{i};
        val = s.(fname);
        fprintf('  %s: class=%s, size=', fname, class(val));
        sz = size(val);
        fprintf('%dx%d\\n', sz(1), sz(2));
    end;
    clear ops ph so fn s val
""", nargout=0)

tout = eng.workspace.get('stout', None)
if tout is not None and hasattr(tout, '__iter__'):
    print(f'tout: {len(tout)} pts')
else:
    print(f'tout: {type(tout)}')

eng.eval('clear stout', nargout=0)
eng.quit()
print('Done')
