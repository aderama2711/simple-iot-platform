# app.py
from flask import Flask, request, jsonify, abort
from uuid import uuid4
from datetime import datetime
import storage
from flask import render_template, send_from_directory
import os

app = Flask(__name__)

# Simple token-based auth for device
API_KEY_HEADER = "X-API-KEY"

@app.route("/devices", methods=["POST"])
def register_device():
    payload = request.get_json(force=True)
    device_id = payload.get("device_id") or str(uuid4())
    name = payload.get("name", "")
    meta = payload.get("meta", {})

    api_key = uuid4().hex
    meta["api_key"] = api_key
    try:
        storage.register_device(device_id, {"name": name, **meta})
    except ValueError:
        return jsonify({"error": "device already exists"}), 409
    return jsonify({"device_id": device_id, "api_key": api_key}), 201

@app.route("/devices", methods=["GET"])
def list_devices():
    devices = storage.list_devices()
    return jsonify(devices)

@app.route("/telemetry", methods=["POST"])
def telemetry_ingest():
    payload = request.get_json(force=True)
    device_id = payload.get("device_id")
    if not device_id:
        return jsonify({"error":"device_id required"}), 400

    # simple api key check
    api_key = request.headers.get(API_KEY_HEADER)
    devices = storage.list_devices()
    dev = devices.get(device_id)
    if not dev:
        return jsonify({"error":"unknown device"}), 404
    expected_key = dev["meta"].get("api_key")
    if expected_key and api_key != expected_key:
        return jsonify({"error":"invalid api key"}), 401

    telemetry = {
        "timestamp": payload.get("timestamp") or datetime.utcnow().isoformat() + "Z",
        "data": payload.get("data", {})
    }
    try:
        storage.store_telemetry(device_id, telemetry)
    except KeyError:
        return jsonify({"error":"unknown device"}), 404
    return jsonify({"status":"ok"}), 201

@app.route("/telemetry/<device_id>", methods=["GET"])
def telemetry_query(device_id):
    start = request.args.get("start")
    end = request.args.get("end")
    limit = int(request.args.get("limit", "100"))
    items = storage.get_telemetry(device_id, start_iso=start, end_iso=end, limit=limit)
    return jsonify(items)

@app.route("/")
def index():
    devices = storage.list_devices()
    # devices is dict; convert to list of dicts for template
    dev_list = [{"device_id": k, "name": v.get("meta", {}).get("name", v.get("meta", {}).get("name", "")) or v.get("meta", {}).get("name", "")} for k, v in devices.items()]
    return render_template("index.html", devices=dev_list)

@app.route("/dashboard/<device_id>")
def dashboard(device_id):
    devices = storage.list_devices()
    if device_id not in devices:
        abort(404)
    device = devices[device_id]
    return render_template("dashboard.html", device_id=device_id, device_name=device.get("meta", {}).get("name", device_id))

@app.route("/api/telemetry/<device_id>")
def api_telemetry(device_id):
    # return last N telemetry items (JSON)
    limit = int(request.args.get("limit", "100"))
    items = storage.get_telemetry(device_id, limit=limit)
    return jsonify(items)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
