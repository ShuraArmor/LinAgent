path = r'E:\ProjBuild\SelfLearn\LinProject\backend\server.py'
with open(path,'rb') as f: data = f.read()

# Find and replace the fallback block that uses get()
old_fallback = b"""    # Extract signals from struct(so).Data (R2024b fix - bypass bridge bug)
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
"""

new_fallback = b"""    # R2024b signal extraction: read struct(so).Data
    if not result.get(\"signals\") and result.get(\"time\"):
        try:
            eng = bridge.engine
            eng.eval(
                \"tmpS = struct(tmpSo); tmpD = tmpS.Data; assignin('base','sigStruct',tmpD); clear tmpS tmpD\",
                nargout=0
            )
            sig_struct = eng.eval(\"sigStruct\", nargout=1)
            sigs = {}
            for sn in [\"Freq_out\",\"I_bat_out\",\"P_gen_out\",\"SOC_out\",\"V_bat_out\",\"V_bus_out\",\"V_conv_out\",\"duty_out\"]:
                try:
                    raw = eng.getfield(sig_struct, sn)
                    if raw is not None and hasattr(raw, '__iter__') and not isinstance(raw, str):
                        vals = [float(x) for x in raw if x is not None]
                        if len(vals) > 0:
                            sigs[sn] = vals
                except:
                    pass
            if sigs:
                result[\"signals\"] = sigs
            eng.eval(\"clear sigStruct tmpSo\", nargout=0)
        except Exception as e:
            log(f\"Signal fallback: {e}\")
"""

if old_fallback in data:
    data = data.replace(old_fallback, new_fallback, 1)
    with open(path,'wb') as f: f.write(data)
    ok = b'sigStruct' in data
    with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\server_v2.txt','w') as rf:
        rf.write(f'OK={ok}')
else:
    idx = data.find(b'Freq_out')
    with open(r'E:\ProjBuild\SelfLearn\LinAgent\demo\server_v2.txt','w') as rf:
        rf.write(f'Freq_out at {idx}')
