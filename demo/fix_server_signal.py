path = r'E:\ProjBuild\SelfLearn\LinProject\backend\server.py'
with open(path,'rb') as f: data = f.read()

# Insert signal extraction right after sim_with_output
marker = b'    result = bridge.sim_with_output(model, req.stop_time)\n    result[\"elapsed\"]'

insertion = b'''    # Extract signals from struct(so).Data (R2024b fix - bypass bridge bug)
    if not result.get(\"signals\") and result.get(\"time\"):
        try:
            eng = bridge.engine
            eng.eval(
                \"tmpS = struct(tmpSo); tmpD = tmpS.Data; tmpDFn = fieldnames(tmpD);\"
                \"for i = 1:length(tmpDFn)\"
                \"  fn = tmpDFn{i};\"
                \"  if ~strcmp(fn, 'tout')\"
                \"    assignin('base', ['sig_' fn{1}], tmpD.(fn));\"
                \"  end;\"
                \"end;\"
                \"clear tmpS tmpD tmpDFn fn\",
                nargout=0
            )
            sigs = {}
            for sn in [\"Freq_out\",\"I_bat_out\",\"P_gen_out\",\"SOC_out\",\"V_bat_out\",\"V_bus_out\",\"V_conv_out\",\"duty_out\"]:
                try:
                    raw = eng.workspace.get('sig_' + sn)
                    if raw is not None and hasattr(raw, '__iter__') and not isinstance(raw, str):
                        import numpy as np
                        vals = [float(x) for x in raw if x is not None]
                        sigs[sn] = vals
                except:
                    pass
            if sigs:
                result[\"signals\"] = sigs
            eng.eval(\"clear tmpSo\", nargout=0)
        except Exception as e:
            log(f\"Signal extraction fallback failed: {e}\")

    ''' + marker

if marker in data:
    data = data.replace(marker, insertion, 1)
    with open(path,'wb') as f: f.write(data)
    ok = b'Freq_out' in data
    with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\server_fix.txt','w') as rf:
        rf.write(f'OK={ok}')
else:
    with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\server_fix.txt','w') as rf:
        rf.write(f'NOT FOUND')
