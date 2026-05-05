#!/usr/bin/env python3
import json
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

RAPL = "/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj"
BAT = "/sys/class/power_supply/BAT0"
THERMAL = "/sys/class/thermal"

def read_file(path):
    with open(path) as f:
        return f.read().strip()

def cpu_temp_c():
    import os
    for zone in sorted(os.listdir(THERMAL)):
        path = f"{THERMAL}/{zone}"
        try:
            if read_file(f"{path}/type") == "x86_pkg_temp":
                return round(int(read_file(f"{path}/temp")) / 1000, 1)
        except Exception:
            continue
    return None

def measure_power_w():
    e1 = int(read_file(RAPL))
    t1 = time.monotonic()
    time.sleep(1)
    e2 = int(read_file(RAPL))
    t2 = time.monotonic()
    delta_uj = e2 - e1
    if delta_uj < 0:
        # counter wrapped
        max_uj = int(read_file(RAPL.replace("energy_uj", "max_energy_range_uj")))
        delta_uj += max_uj
    return delta_uj / ((t2 - t1) * 1_000_000)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            power_w = measure_power_w()
            data = {
                "power_w": round(power_w, 2),
                "cpu_temp_c": cpu_temp_c(),
                "capacity": int(read_file(f"{BAT}/capacity")),
                "status": read_file(f"{BAT}/status"),
            }
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

HTTPServer(("0.0.0.0", 8081), Handler).serve_forever()
