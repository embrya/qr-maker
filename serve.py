#!/usr/bin/env python3
"""Local web server for QR Maker."""

from __future__ import annotations

import argparse
import http.server
import os
import socket
import socketserver
import webbrowser
from functools import partial


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format, *args) -> None:
        pass


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def local_ip() -> str:
    names = {socket.gethostname(), socket.getfqdn()}
    for name in names:
        try:
            for item in socket.getaddrinfo(name, None, socket.AF_INET):
                ip = item[4][0]
                if not ip.startswith("127."):
                    return ip
        except OSError:
            continue
    return "127.0.0.1"


def main() -> None:
    parser = argparse.ArgumentParser(description="QR Maker local server.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host. Use 0.0.0.0 for another device on the same LAN.")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on.")
    parser.add_argument("--open", choices=["maker", "scanner"], help="Open a page in the default browser after starting.")
    args = parser.parse_args()

    directory = os.path.dirname(os.path.abspath(__file__))
    handler = partial(Handler, directory=directory)

    with ReusableTCPServer((args.host, args.port), handler) as httpd:
        browser_host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
        print(f"QR Maker — http://{browser_host}:{args.port}")
        if args.open:
            webbrowser.open(f"http://{browser_host}:{args.port}/{args.open}.html")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
