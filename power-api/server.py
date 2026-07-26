#!/usr/bin/env python3
import json
import os
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

RAPL = "/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj"
BAT = "/sys/class/power_supply/BAT0"
THERMAL = "/sys/class/thermal"
HWMON = "/sys/class/hwmon"

def read_file(path):
    with open(path) as f:
        return f.read().strip()

def cpu_temp_c():
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

def fan_speeds():
    fans = []
    try:
        for hwmon in sorted(os.listdir(HWMON)):
            hwmon_path = f"{HWMON}/{hwmon}"
            try:
                name = read_file(f"{hwmon_path}/name")
            except Exception:
                name = hwmon
            for i in range(1, 10):
                fan_file = f"{hwmon_path}/fan{i}_input"
                if os.path.exists(fan_file):
                    try:
                        rpm = int(read_file(fan_file))
                        label_file = f"{hwmon_path}/fan{i}_label"
                        try:
                            label = read_file(label_file) if os.path.exists(label_file) else f"fan{i}"
                        except Exception:
                            label = f"fan{i}"
                        fans.append({"name": f"{name} {label}", "rpm": rpm})
                    except Exception:
                        pass
    except Exception:
        pass
    return fans

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Each field is collected independently: a desktop (no BAT0) or a board
        # without RAPL should still report everything else it *can* read, rather
        # than collapsing the whole response into {"error": ...}.
        data = {}
        errors = {}

        for key, fn in (
            ("power_w",    lambda: round(measure_power_w(), 2)),
            ("cpu_temp_c", cpu_temp_c),
            ("capacity",   lambda: int(read_file(f"{BAT}/capacity"))),
            ("status",     lambda: read_file(f"{BAT}/status")),
            ("fans",       fan_speeds),
        ):
            try:
                value = fn()
            except Exception as e:
                errors[key] = str(e)
                continue
            if value is not None:
                data[key] = value

        if errors:
            data["errors"] = errors

        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

HTTPServer(("0.0.0.0", 8081), Handler).serve_forever()
