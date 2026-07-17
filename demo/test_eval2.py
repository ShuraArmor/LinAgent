import matlab.engine

eng = matlab.engine.start_matlab()
eng.cd(r'E:\ProjBuild\SelfLearn\LinProject', nargout=0)
name = eng.open_system('power_system.slx', nargout=1)
print(f'Loaded: {name}')

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
    s = struct(so);
    fn = fieldnames(s);
    fprintf('struct fields: ');
    for i = 1:length(fn), fprintf('%s ', fn{i}); end;
    fprintf('\\n');
    clear ops ph so fn s
""", nargout=0)

tout = eng.workspace.get('tout', None)
if tout is not None and hasattr(tout, '__iter__'):
    print(f'tout: {len(tout)} pts')
else:
    print(f'tout not available')

vl = str(eng.eval('who', nargout=1))
print(f'Workspace vars: {vl}')

eng.quit()
