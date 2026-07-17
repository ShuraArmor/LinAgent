"""分析交互仿真结果"""
import json, urllib.request

data = json.dumps({
    "block_params": {
        "power_system/V_ref_set": "220",
        "power_system/P_ref_set": "60000",
        "power_system/Freq_set": "1.0",
        "power_system/Vconv_ref": "50",
        "power_system/Bat_cmd": "0.1"
    },
    "stop_time": 5.0
}).encode()

req = urllib.request.Request("http://127.0.0.1:8732/api/sim/interactive",
    data=data, headers={"Content-Type": "application/json"})
resp = urllib.request.urlopen(req, timeout=120)
d = json.loads(resp.read())

print(f"=== 仿真结果摘要 ===")
print(f"模型: {d.get('model','?')}")
print(f"仿真时长: {d.get('stop_time', '?')}s")
print(f"时间步数: {len(d.get('time',[]))}")
print(f"耗时: {d.get('elapsed', '?')}")

# 检查 output
out = d.get('output', {})
if isinstance(out, dict):
    print(f"\noutput 信号 ({len(out)} 个):")
    for name, vals in out.items():
        if isinstance(vals, list) and len(vals) > 0:
            print(f"  {name}: [{vals[0]:.6g} ... {vals[-1]:.6g}], 长度={len(vals)}")

# 检查 signals
sig = d.get('signals', {})
if isinstance(sig, dict):
    print(f"\nsignals ({len(sig)} 个):")
    for name, vals in list(sig.items())[:5]:
        if isinstance(vals, list) and len(vals) > 0:
            print(f"  {name}: [{vals[0]:.6g} ... {vals[-1]:.6g}], 长度={len(vals)}")

print(f"\n输入参数:")
for k, v in d.get('block_params', {}).items():
    print(f"  {k} = {v}")
