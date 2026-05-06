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
    # Return first GPU as a single object (Infinity datasource requires non-array root)
    line = result.stdout.strip().splitlines()[0]
    name, util, temp, mem_used, mem_total = [x.strip() for x in line.split(",")]
    mem_used_mb = int(mem_used)
    mem_total_mb = int(mem_total)
    return {
        "name": name,
        "utilization_pct": int(util),
        "temp_c": int(temp),
        "mem_used_mb": mem_used_mb,
        "mem_total_mb": mem_total_mb,
        "mem_pct": round(mem_used_mb / mem_total_mb * 100, 1),
        "mem_used_bytes": mem_used_mb * 1024 * 1024,
        "mem_total_bytes": mem_total_mb * 1024 * 1024,
    }

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
