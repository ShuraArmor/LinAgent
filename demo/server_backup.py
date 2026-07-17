
"""
代理模型平台后端 — FastAPI 服务 v2.5
新增: 启动时自动加载模型
"""

import sys, os, json, time, signal, atexit, csv, io
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import uvicorn
import numpy as np

from simulink_bridge import SimulinkBridge
from surrogate_engine import SurrogateEngine
from scan_env import scan as scan_environment

# ---- App & State ----

app = FastAPI(title="Surrogate Model Platform API", version="2.5")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_bridge: Optional[SimulinkBridge] = None
_project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MODEL_PATH = os.path.join(_project_dir, "power_system.slx")
_surrogate = SurrogateEngine()
_logs = []
_sampling_cache = {"X": None, "Y": None, "bounds": None}
_shutting_down = False
_model_path: Optional[str] = None
_last_sim_result: Optional[dict] = None


# ---- Lifecycle ----

@app.on_event("startup")
def on_startup():
    print("=" * 60)
    print("  Surrogate Model Platform API v2.5")
    print(f"  Project: {_project_dir}")
    print(f"  Model:   {_MODEL_PATH}  (exists: {os.path.exists(_MODEL_PATH)})")
    print(f"  http://127.0.0.1:8732")
    print("=" * 60)

    # ---- 启动时自动加载模型 ----
    if os.path.exists(_MODEL_PATH):
        try:
            bridge = get_bridge()
            model = bridge.open_model(_MODEL_PATH)
            global _model_path
            _model_path = _MODEL_PATH
            log(f"Auto-loaded model: {model}")
        except Exception as e:
            log(f"Auto-load failed: {e}")


@app.on_event("shutdown")
def on_shutdown():
    global _shutting_down, _bridge
    _shutting_down = True
    if _bridge is not None:
        try:
            _bridge.stop()
            log("Bridge stopped")
        except Exception as e:
            log(f"Bridge stop error: {e}")
        _bridge = None


def _cleanup():
    global _bridge
    if _bridge is not None:
        try:
            _bridge.stop()
        except Exception:
            pass


atexit.register(_cleanup)
signal.signal(signal.SIGINT, lambda *_: (_cleanup(), sys.exit(0)))
signal.signal(signal.SIGTERM, lambda *_: (_cleanup(), sys.exit(0)))


# ---- Helpers ----

def log(msg):
    entry = {"time": time.time(), "text": msg}
    _logs.append(entry)
    if len(_logs) > 500:
        _logs.pop(0)
    print(f"[API] {msg}")


def get_bridge():
    global _bridge
    if _shutting_down:
        raise HTTPException(503, "Server shutting down")
    if _bridge is None:
        _bridge = SimulinkBridge()
        _bridge.start()
        log("MATLAB Engine started")
    return _bridge


# ---- Request Models ----

class ModelPathReq(BaseModel):
    path: Optional[str] = None

class SetParamReq(BaseModel):
    block: str
    param: str
    value: str

class SimRunReq(BaseModel):
    model: Optional[str] = None
    stop_time: float = 10.0

class InteractiveSimReq(BaseModel):
    inports: dict = {}
    block_params: dict = {}
    stop_time: float = 10.0

class SampleReq(BaseModel):
    subsystem: str
    bounds: list
    n_samples: int = 500
    method: str = "lhs"
    stop_time: float = 0.5

class TrainReq(BaseModel):
    name: str
    model_type: str = "mlp"
    hyperparams: dict = {}
    X: list = []
    Y: list = []

class PredictReq(BaseModel):
    name: Optional[str] = None
    X: list = []

class ExportReq(BaseModel):
    name: str
    folder: Optional[str] = None
    format: str = "csv"

class ValidateReq(BaseModel):
    name: Optional[str] = None
    n_test: Optional[int] = None
    X_test: list = []
    Y_test: list = []
    bounds: list = []

class SpeedCompareReq(BaseModel):
    name: Optional[str] = None
    X_sample: list = []

class SurrogateNameReq(BaseModel):
    name: str

class ReplaceReq(BaseModel):
    name: str
    subsystem: str


# ==================== 基础端点 ====================

@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "timestamp": time.time(),
        "bridge": _bridge is not None and _bridge.is_running,
        "model_loaded": _bridge.model_loaded if _bridge else None,
    }


@app.get("/api/env/scan")
def env_scan():
    try:
        config = scan_environment()
        ready = bool(
            config and
            any(i["simulink_available"] for i in config.get("matlab_installations", [])) and
            config.get("python", {}).get("matlab_engine_installed")
        )
        return {
            "ready": ready,
            "config_valid": True,
            "matlab": {
                "found": len(config.get("matlab_installations", [])) > 0,
                "installations": config.get("matlab_installations", []),
            },
            "python": config.get("python", {}),
            "primary_matlab": config.get("primary_matlab"),
        }
    except Exception as e:
        return {"ready": False, "error": str(e)}


@app.get("/api/logs")
def get_logs():
    return list(_logs)


@app.get("/api/bridge/status")
def bridge_status():
    bridge = get_bridge()
    return {
        "running": bridge.is_running,
        "model_loaded": bridge.model_loaded,
    }


# ==================== 模型管理 ====================

@app.post("/api/model/load")
def load_model(req: ModelPathReq):
    global _model_path
    bridge = get_bridge()
    path = req.path or _MODEL_PATH
    if not os.path.exists(path):
        log(f"Model not found: {path}")
        raise HTTPException(404, f"Model not found: {path}")
    model = bridge.open_model(path)
    _model_path = path
    log(f"Model loaded: {model}  ({path})")
    return {"model": model, "path": path}


@app.post("/api/model/close")
def close_model():
    global _model_path
    bridge = get_bridge()
    name = bridge.model_loaded
    if name:
        bridge.close_model(name)
        log(f"Model closed: {name}")
    _model_path = None
    return {"closed": name}


@app.get("/api/model/info")
def model_info():
    bridge = get_bridge()
    model = bridge.model_loaded
    if not model:
        raise HTTPException(400, "No model loaded")

    blocks = bridge.get_block_list(model)
    type_counts = {}
    for b in blocks:
        try:
            bt = bridge.get_block_type(b)
            type_counts[bt] = type_counts.get(bt, 0) + 1
        except Exception:
            type_counts["unknown"] = type_counts.get("unknown", 0) + 1

    subsystems = bridge.get_model_hierarchy(model)

    try:
        solver = bridge.get_param(model, "Solver")
    except Exception:
        solver = "unknown"
    try:
        stop_time = bridge.get_param(model, "StopTime")
    except Exception:
        stop_time = "unknown"

    return {
        "model": model,
        "path": _model_path,
        "total_blocks": len(blocks),
        "type_counts": type_counts,
        "subsystems": subsystems,
        "solver": solver,
        "stop_time": stop_time,
        "inports": [],
        "outports": [],
    }


@app.get("/api/model/tunable-params")
def tunable_params():
    bridge = get_bridge()
    params = bridge.scan_tunable_params()
    return {"params": params}


@app.get("/api/model/hierarchy")
def model_hierarchy():
    bridge = get_bridge()
    subsystems = bridge.get_model_hierarchy()
    return {"subsystems": subsystems}


@app.get("/api/model/blocks")
def model_blocks():
    bridge = get_bridge()
    model = bridge.model_loaded
    if not model:
        raise HTTPException(400, "No model loaded")
    blocks = bridge.get_block_list(model)
    result = []
    for b in blocks:
        try:
            result.append(bridge.get_block_info(b))
        except Exception:
            result.append({"path": b, "name": b.split("/")[-1], "type": "unknown"})
    return {"blocks": result}


# ==================== 方块参数 ====================

@app.get("/api/block/params")
def block_params(block: str):
    bridge = get_bridge()
    try:
        params = bridge.get_block_params(block)
        return {"block": block, "params": params}
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/block/set")
def block_set(req: SetParamReq):
    bridge = get_bridge()
    try:
        bridge.set_param(req.block, req.param, req.value)
        log(f"Set {req.block}/{req.param} = {req.value}")
        return {"block": req.block, "param": req.param, "value": req.value}
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/block/info")
def block_info(block: str):
    bridge = get_bridge()
    try:
        info = bridge.get_block_info(block)
        return info
    except Exception as e:
        raise HTTPException(400, str(e))


# ==================== 仿真 ====================

@app.post("/api/sim/run")
def sim_run(req: SimRunReq):
    bridge = get_bridge()
    model = req.model or bridge.model_loaded
    if not model:
        raise HTTPException(400, "No model loaded")
    log(f"Running sim: {model}, stop_time={req.stop_time}")
    result = bridge.sim_with_output(model, req.stop_time)
    global _last_sim_result
    _last_sim_result = result
    log(f"Sim done: {len(result.get('time', []))} time points, {len(result.get('signals', {}))} signals")
    return result


@app.post("/api/sim/interactive")
def interactive_sim(req: InteractiveSimReq):
    bridge = get_bridge()
    model = bridge.model_loaded
    if not model:
        raise HTTPException(400, "No model loaded")

    t0 = time.time()

    # 设置 block_params
    for block_path, val in req.block_params.items():
        try:
            bridge.set_param(block_path, "Value", str(val))
        except Exception as e:
            log(f"Warn: set {block_path} = {val} failed: {e}")

    # 设置 inports
    for port_name, val in req.inports.items():
        bridge.set_variable(port_name, float(val))

    log(f"Interactive sim: params={len(req.block_params)}, stop_time={req.stop_time}")
    result = bridge.sim_with_output(model, req.stop_time)
    result["elapsed"] = round(time.time() - t0, 3)
    result["block_params"] = req.block_params
    result["inputs"] = req.inports

    global _last_sim_result
    _last_sim_result = result
    n_sig = len(result.get("signals", {}))
    log(f"Interactive sim done: {result['elapsed']}s, {len(result.get('time', []))} time points, {n_sig} signals")
    return result


@app.post("/api/data/export")
def data_export(req: ExportReq):
    if not _last_sim_result:
        raise HTTPException(400, "No simulation data")

    folder = req.folder or os.path.join(_project_dir, "exports")
    os.makedirs(folder, exist_ok=True)

    fmt = req.format or "csv"
    result = _last_sim_result
    t = result.get("time", [])
    signals = result.get("signals", {})
    files = []

    if fmt == "csv":
        path = os.path.join(folder, f"{req.name or 'export'}.csv")
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            header = ["time"] + list(signals.keys())
            writer.writerow(header)
            n = max(len(t), max((len(v) if isinstance(v, list) else 0) for v in signals.values())) if signals else len(t)
            for i in range(n):
                row = [t[i] if i < len(t) else ""]
                for k in signals:
                    v = signals[k]
                    if isinstance(v, list) and i < len(v):
                        row.append(v[i] if v[i] is not None else "")
                    else:
                        row.append("")
                writer.writerow(row)
        files.append(path)
    elif fmt == "json":
        path = os.path.join(folder, f"{req.name or 'export'}.json")
        # convert to serializable
        export_data = {
            "model": result.get("model"),
            "stop_time": result.get("stop_time"),
            "time": t,
            "signals": {k: (v if isinstance(v, list) else [v]) for k, v in signals.items()},
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(export_data, f, indent=2)
        files.append(path)
    elif fmt == "mat":
        # Save as .mat using scipy
        from scipy.io import savemat
        path = os.path.join(folder, f"{req.name or 'export'}.mat")
        mat_dict = {"time": np.array(t)}
        for k, v in signals.items():
            mat_dict[k] = np.array(v if isinstance(v, list) else [v])
        savemat(path, mat_dict)
        files.append(path)

    log(f"Exported {fmt}: {files}")
    return {"files": [os.path.basename(f) for f in files], "folder": folder, "format": fmt}


# ==================== 代理模型 ====================

@app.post("/api/surrogate/sample")
def surrogate_sample(req: SampleReq):
    try:
        if req.method == "lhs":
            X = _surrogate.sample_lhs(req.bounds, req.n_samples)
        else:
            X = _surrogate.sample_random(req.bounds, req.n_samples)

        # Run simulation for each sample
        bridge = get_bridge()
        model = bridge.model_loaded
        Y = np.zeros((req.n_samples, 1))

        for i in range(req.n_samples):
            # Set inputs
            for j, (lo, hi) in enumerate(req.bounds):
                bridge.set_variable(f"in{j+1}", float(X[i, j]))
            result = bridge.sim_with_output(model, req.stop_time)
            # Use first output signal if available
            sigs = result.get("signals", {})
            if sigs:
                first_key = list(sigs.keys())[0]
                vals = sigs[first_key]
                Y[i, 0] = float(vals[-1]) if isinstance(vals, list) and len(vals) > 0 else 0.0
            else:
                Y[i, 0] = 0.0

        _sampling_cache["X"] = X.tolist()
        _sampling_cache["Y"] = Y.tolist()
        _sampling_cache["bounds"] = req.bounds

        log(f"Sampled {req.n_samples} points via {req.method}")
        return {
            "n_samples": req.n_samples,
            "method": req.method,
            "X": X.tolist(),
            "Y": Y.tolist(),
            "bounds": req.bounds,
        }
    except Exception as e:
        log(f"Sample failed: {e}")
        raise HTTPException(500, str(e))


@app.post("/api/surrogate/train")
def surrogate_train(req: TrainReq):
    if not req.X or not req.Y:
        raise HTTPException(400, "No training data")
    try:
        X = np.array(req.X)
        Y = np.array(req.Y)
        _surrogate.train(X, Y, req.model_type, req.hyperparams)
        path = _surrogate.save(req.name)
        log(f"Trained {req.model_type} model '{req.name}', saved to {path}")

        # Validate
        y_pred = _surrogate.predict(X)
        from sklearn.metrics import mean_squared_error, r2_score
        rmse = float(np.sqrt(mean_squared_error(Y, y_pred)))
        r2 = float(r2_score(Y, y_pred))

        return {
            "name": req.name,
            "model_type": req.model_type,
            "path": path,
            "validation": {"rmse": round(rmse, 6), "r2": round(r2, 6)},
        }
    except Exception as e:
        log(f"Train failed: {e}")
        raise HTTPException(500, str(e))


@app.post("/api/surrogate/predict")
def surrogate_predict(req: PredictReq):
    if req.name:
        _surrogate.load(req.name)
    try:
        X = np.array(req.X)
        y_pred = _surrogate.predict(X)
        return {"predictions": y_pred.flatten().tolist()}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/surrogate/list")
def surrogate_list():
    return {"models": SurrogateEngine.list_models()}


@app.post("/api/surrogate/validate")
def surrogate_validate(req: ValidateReq):
    if req.name:
        _surrogate.load(req.name)

    try:
        if req.X_test and req.Y_test:
            X_test = np.array(req.X_test)
            Y_test = np.array(req.Y_test)
        elif req.bounds and req.n_test:
            X_test = _surrogate.sample_random(req.bounds, req.n_test)
            Y_test = np.zeros((req.n_test, 1))
            # Can't run sim without bounds mapping, just return predictions
        else:
            # Use cached sampling data
            if _sampling_cache["X"] is None:
                raise HTTPException(400, "No test data")
            X_test = np.array(_sampling_cache["X"])
            Y_test = np.array(_sampling_cache["Y"])

        result = _surrogate.validate(X_test, Y_test)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/surrogate/compare-speed")
def surrogate_compare_speed(req: SpeedCompareReq):
    if req.name:
        _surrogate.load(req.name)

    X_sample = np.array(req.X_sample) if req.X_sample else np.array(_sampling_cache.get("X", [[0]]))

    # Surrogate prediction speed
    t0 = time.time()
    for _ in range(100):
        _surrogate.predict(X_sample[:1])
    surrogate_time = (time.time() - t0) / 100

    # Estimate Simulink speed (typical ~50ms per eval)
    sim_time_estimate = 0.05
    speedup = round(sim_time_estimate / max(surrogate_time, 1e-6), 1)

    return {
        "surrogate_eval_ms": round(surrogate_time * 1000, 3),
        "simulink_estimate_ms": round(sim_time_estimate * 1000, 1),
        "speedup_estimate": speedup,
    }


@app.post("/api/surrogate/export")
def surrogate_export(req: SurrogateNameReq):
    try:
        _surrogate.load(req.name)
        code = _surrogate.generate_matlab_function(req.name)
        out_dir = os.path.join(_project_dir, "surrogate_models")
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, f"{req.name}.m")
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)
        log(f"Exported MATLAB function: {path}")
        return {"name": req.name, "path": path, "code": code}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/surrogate/replace")
def surrogate_replace(req: ReplaceReq):
    try:
        _surrogate.load(req.name)
        code = _surrogate.generate_matlab_function(req.name)
        out_dir = os.path.join(_project_dir, "surrogate_models")
        os.makedirs(out_dir, exist_ok=True)
        m_file = os.path.join(out_dir, f"{req.name}.m")
        with open(m_file, "w", encoding="utf-8") as f:
            f.write(code)

        bridge = get_bridge()
        # Add MATLAB Function block if model is loaded
        if bridge.model_loaded:
            block_path = f"{bridge.model_loaded}/{req.name}_surrogate"
            try:
                bridge.eval(f"add_block('simulink/User-Defined Functions/MATLAB Function', '{block_path}')")
                log(f"Created surrogate block: {block_path}")
            except Exception as e:
                log(f"Block creation skipped: {e}")

        return {"name": req.name, "m_file": m_file, "block": f"{bridge.model_loaded}/{req.name}_surrogate" if bridge.model_loaded else None}
    except Exception as e:
        raise HTTPException(500, str(e))


# ==================== Main ====================

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8732)
