#!/usr/bin/env python3
import json
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler

def gpu_stats():
    result = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ],
        capture_output=True,
        text=True,
        timeout=5,
    )
    gpus = []
    for line in result.stdout.strip().splitlines():
        name, util, temp, mem_used, mem_total = [x.strip() for x in line.split(",")]
        gpus.append({
            "name": name,
            "utilization_pct": int(util),
            "temp_c": int(temp),
            "mem_used_mb": int(mem_used),
            "mem_total_mb": int(mem_total),
            "mem_pct": round(int(mem_used) / int(mem_total) * 100, 1),
        })
    return gpus

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            data = gpu_stats()
        except Exception as e:
            data = {"error": str(e)}

        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

HTTPServer(("0.0.0.0", 8083), Handler).serve_forever()
