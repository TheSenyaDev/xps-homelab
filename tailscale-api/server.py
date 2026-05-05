#!/usr/bin/env python3
import json
import socket
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler

TAILSCALE_SOCKET = "/var/run/tailscale/tailscaled.sock"

def tailscale_request(path):
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.connect(TAILSCALE_SOCKET)
    request = f"GET {path} HTTP/1.0\r\nHost: local-tailscaled.sock\r\n\r\n"
    conn.sendall(request.encode())
    response = b""
    while True:
        chunk = conn.recv(4096)
        if not chunk:
            break
        response += chunk
    conn.close()
    body = response.split(b"\r\n\r\n", 1)[1]
    return json.loads(body)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            status = tailscale_request("/localapi/v0/status")
            peers = status.get("Peer", {})
            online_peers = [p for p in peers.values() if p.get("Online")]

            data = {
                "state": status.get("BackendState", "Unknown"),
                "hostname": status["Self"]["HostName"],
                "ip": status["Self"]["TailscaleIPs"][0] if status["Self"]["TailscaleIPs"] else "N/A",
                "dns": status["Self"]["DNSName"].rstrip("."),
                "total_peers": len(peers),
                "online_peers": len(online_peers),
                "peers": [
                    {
                        "hostname": p["HostName"],
                        "ip": p["TailscaleIPs"][0] if p["TailscaleIPs"] else "N/A",
                        "online": p.get("Online", False),
                        "os": p.get("OS", ""),
                    }
                    for p in peers.values()
                ],
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

HTTPServer(("0.0.0.0", 8082), Handler).serve_forever()
