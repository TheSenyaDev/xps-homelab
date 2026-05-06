#!/usr/bin/env python3
"""Prometheus exporter — scrapes the homelab APIs and exposes /metrics."""
import json
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler

def fetch(url, timeout=6):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None

def label(v):
    return str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")

def collect():
    lines = []

    # ── CPU ──────────────────────────────────────────────────────────────────
    cpu = fetch("http://glances:61208/api/4/cpu")
    if isinstance(cpu, dict):
        for field in ("total", "user", "system"):
            if field in cpu:
                lines.append(f'homelab_cpu_usage_percent{{type="{field}"}} {cpu[field]}')

    # ── RAM ───────────────────────────────────────────────────────────────────
    mem = fetch("http://glances:61208/api/4/mem")
    if isinstance(mem, dict):
        for key, metric in (("percent", "homelab_ram_usage_percent"),
                            ("used",    "homelab_ram_used_bytes"),
                            ("total",   "homelab_ram_total_bytes")):
            if key in mem:
                lines.append(f"{metric} {mem[key]}")

    # ── Disk ──────────────────────────────────────────────────────────────────
    fs = fetch("http://glances:61208/api/4/fs")
    if isinstance(fs, list):
        seen_devices = set()
        for disk in fs:
            dev = disk.get("device_name", "unknown")
            if dev in seen_devices:
                continue
            seen_devices.add(dev)
            dev_label = label(dev)
            for key, metric in (("percent", "homelab_disk_usage_percent"),
                                ("used",    "homelab_disk_used_bytes"),
                                ("size",    "homelab_disk_size_bytes")):
                if key in disk:
                    lines.append(f'{metric}{{device="{dev_label}"}} {disk[key]}')

    # ── Power / Temp / Battery / Fans ─────────────────────────────────────────
    power = fetch("http://power-api:8081")
    if isinstance(power, dict):
        for key, metric in (("power_w",    "homelab_cpu_power_watts"),
                            ("cpu_temp_c", "homelab_cpu_temp_celsius"),
                            ("capacity",   "homelab_battery_capacity_percent")):
            if key in power:
                lines.append(f"{metric} {power[key]}")
        for fan in power.get("fans") or []:
            name = label(fan.get("name", "fan"))
            lines.append(f'homelab_fan_speed_rpm{{fan="{name}"}} {fan["rpm"]}')

    # ── GPU ───────────────────────────────────────────────────────────────────
    gpu = fetch("http://nvidia-api:8083")
    if isinstance(gpu, dict):
        for key, metric in (("utilization_pct", "homelab_gpu_usage_percent"),
                            ("temp_c",          "homelab_gpu_temp_celsius"),
                            ("mem_used_mb",      "homelab_gpu_vram_used_mb"),
                            ("mem_total_mb",     "homelab_gpu_vram_total_mb"),
                            ("mem_pct",          "homelab_gpu_vram_percent"),
                            ("mem_used_bytes",   "homelab_gpu_vram_used_bytes"),
                            ("mem_total_bytes",  "homelab_gpu_vram_total_bytes")):
            if key in gpu:
                lines.append(f"{metric} {gpu[key]}")

    return "\n".join(lines) + "\n"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/metrics":
            body = collect().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


HTTPServer(("0.0.0.0", 9091), Handler).serve_forever()
