# storage.py
import json
import os
import tempfile
from threading import Lock
from datetime import datetime

DATA_FILE = os.path.join(os.path.dirname(__file__), "data.json")
_lock = Lock()

def _ensure_datafile():
    if not os.path.exists(DATA_FILE):
        initial = {"devices": {}, "telemetry": {}}
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(initial, f, indent=2)

def read_all():
    _ensure_datafile()
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def write_atomic(data):
    # atomic write: write to temp then replace
    dirn = os.path.dirname(DATA_FILE)
    fd, tmp = tempfile.mkstemp(dir=dirn, prefix="._tmp_data_", text=True)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, DATA_FILE)

def with_lock_read():
    with _lock:
        return read_all()

def with_lock_write(mutator_fn):
    with _lock:
        data = read_all()
        result = mutator_fn(data)
        # accept either in-place modification or returned object
        to_write = result if result is not None else data
        write_atomic(to_write)
        return to_write

# Convenience helpers
def register_device(device_id, meta):
    def mut(d):
        if device_id in d["devices"]:
            raise ValueError("Device already exists")
        d["devices"][device_id] = {
            "meta": meta,
            "registered_at": datetime.utcnow().isoformat() + "Z"
        }
        # prepare telemetry bucket
        d["telemetry"].setdefault(device_id, [])
        return d
    return with_lock_write(mut)

def list_devices():
    d = with_lock_read()
    return d["devices"]

def store_telemetry(device_id, payload):
    def mut(d):
        if device_id not in d["devices"]:
            raise KeyError("Unknown device")
        d["telemetry"].setdefault(device_id, [])
        d["telemetry"][device_id].append(payload)
        # Optionally truncate very old entries here
        return d
    return with_lock_write(mut)

def get_telemetry(device_id, start_iso=None, end_iso=None, limit=100):
    d = with_lock_read()
    if device_id not in d["telemetry"]:
        return []
    items = d["telemetry"][device_id]
    # filter by time if provided (assumes each item has 'timestamp' ISO string)
    def to_dt(s):
        try:
            from dateutil import parser
            return parser.isoparse(s)
        except Exception:
            return None
    if start_iso or end_iso:
        s_dt = to_dt(start_iso) if start_iso else None
        e_dt = to_dt(end_iso) if end_iso else None
        filtered = []
        for it in items:
            ts = it.get("timestamp")
            tdt = to_dt(ts) if ts else None
            if tdt is None:
                continue
            if s_dt and tdt < s_dt:
                continue
            if e_dt and tdt > e_dt:
                continue
            filtered.append(it)
        items = filtered
    # return last `limit` entries
    return items[-limit:]
