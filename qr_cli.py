#!/usr/bin/env python3
"""QR PNG generator: encode a file into QR code images with a slideshow."""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import mimetypes
import os
import shutil
import sys
import zlib
from pathlib import Path


PROTOCOL = "AGQR1"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def crc32_ascii(text: str) -> str:
    return f"{zlib.crc32(text.encode('ascii')) & 0xffffffff:08x}"


def make_frames(path: Path, chunk_chars: int) -> dict:
    data = path.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    sid = sha[:12]
    encoded = b64url(data)
    chunks = [encoded[i : i + chunk_chars] for i in range(0, len(encoded), chunk_chars)]
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    meta = "|".join(
        [
            PROTOCOL,
            "M",
            sid,
            str(len(chunks)),
            str(len(data)),
            sha,
            b64url(path.name.encode("utf-8")),
            b64url(mime.encode("utf-8")),
        ]
    )
    data_frames = [
        "|".join([PROTOCOL, "D", sid, str(index), str(len(chunks)), crc32_ascii(chunk), chunk])
        for index, chunk in enumerate(chunks)
    ]
    return {
        "sid": sid,
        "sha256": sha,
        "size": len(data),
        "filename": path.name,
        "mime": mime,
        "chunk_chars": chunk_chars,
        "data_frame_count": len(chunks),
        "frames": [meta] + data_frames,
    }


def write_qr_pngs(frames: list[str], out_dir: Path, ecc: str, box_size: int, border: int) -> list[str]:
    try:
        import qrcode
        from qrcode import constants
    except ImportError:
        print("Missing dependency: qrcode.", file=sys.stderr)
        raise SystemExit(2)

    ecc_map = {
        "L": constants.ERROR_CORRECT_L,
        "M": constants.ERROR_CORRECT_M,
        "Q": constants.ERROR_CORRECT_Q,
        "H": constants.ERROR_CORRECT_H,
    }
    frame_dir = out_dir / "frames"
    frame_dir.mkdir(parents=True, exist_ok=True)
    names = []
    for index, payload in enumerate(frames):
        qr = qrcode.QRCode(
            version=None,
            error_correction=ecc_map[ecc],
            box_size=box_size,
            border=border,
        )
        qr.add_data(payload)
        qr.make(fit=True)
        image = qr.make_image(fill_color="black", back_color="white")
        name = f"frame_{index:04d}_{'meta' if index == 0 else 'data'}.png"
        image.save(frame_dir / name)
        names.append(f"frames/{name}")
    return names


def write_slideshow(out_dir: Path, frame_paths: list[str], info: dict, interval_ms: int) -> None:
    payload = json.dumps({"frames": frame_paths, "info": info}, ensure_ascii=False)
    title = html.escape(info["filename"])
    html_text = f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QR Slideshow - {title}</title>
  <style>
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
      background: #f7f8fa;
      color: #17202a;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    header, footer {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      background: #fff;
      border-bottom: 1px solid #d7dde6;
    }}
    footer {{ border-top: 1px solid #d7dde6; border-bottom: 0; color: #5c6675; }}
    main {{ display: grid; place-items: center; padding: 18px; }}
    img {{
      width: min(86vh, calc(100vw - 36px));
      height: auto;
      max-width: 920px;
      background: #fff;
      border: 12px solid #fff;
      box-shadow: 0 1px 2px rgba(16, 24, 40, .12);
      image-rendering: pixelated;
    }}
    button {{
      min-height: 38px;
      border: 1px solid #d7dde6;
      border-radius: 7px;
      background: #fff;
      padding: 8px 11px;
      font: inherit;
      cursor: pointer;
    }}
    button.primary {{
      border-color: #0b63ce;
      background: #0b63ce;
      color: #fff;
      font-weight: 700;
    }}
    .row {{ display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }}
    .badge {{
      border-radius: 999px;
      padding: 5px 10px;
      background: #eaf2ff;
      color: #074b9b;
      font-weight: 750;
      font-variant-numeric: tabular-nums;
    }}
  </style>
</head>
<body>
  <header>
    <strong>{title}</strong>
    <span class="badge" id="badge">1 / {len(frame_paths)}</span>
  </header>
  <main><img id="qr" alt="QR frame"></main>
  <footer>
    <div class="row">
      <button id="prev">이전</button>
      <button id="next">다음</button>
      <button id="play" class="primary">재생</button>
      <button id="pause">정지</button>
      <button id="full">전체 화면</button>
    </div>
    <span id="detail"></span>
  </footer>
  <script>
    const data = {payload};
    let index = 0;
    let timer = null;
    const intervalMs = {interval_ms};
    const qr = document.getElementById("qr");
    const badge = document.getElementById("badge");
    const detail = document.getElementById("detail");
    function show(next) {{
      index = (next + data.frames.length) % data.frames.length;
      qr.src = data.frames[index];
      badge.textContent = `${{index + 1}} / ${{data.frames.length}}`;
      detail.textContent = index === 0 ? "meta" : `chunk ${{index}} / ${{data.info.data_frame_count}}`;
    }}
    function play() {{
      if (timer) return;
      timer = setInterval(() => show(index + 1), intervalMs);
    }}
    function pause() {{
      if (timer) clearInterval(timer);
      timer = null;
    }}
    document.getElementById("prev").onclick = () => {{ pause(); show(index - 1); }};
    document.getElementById("next").onclick = () => {{ pause(); show(index + 1); }};
    document.getElementById("play").onclick = play;
    document.getElementById("pause").onclick = pause;
    document.getElementById("full").onclick = () => document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    show(0);
  </script>
</body>
</html>
"""
    (out_dir / "slideshow.html").write_text(html_text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="QR PNG generator.")
    parser.add_argument("file", type=Path, help="File to encode.")
    parser.add_argument("--out", type=Path, default=Path("qr-out"), help="Output directory.")
    parser.add_argument("--chunk-size", type=int, default=300, help="Base64URL characters per data QR.")
    parser.add_argument("--ecc", choices=["L", "M", "Q", "H"], default="M", help="QR error correction level.")
    parser.add_argument("--box-size", type=int, default=6, help="Pixels per QR module.")
    parser.add_argument("--border", type=int, default=4, help="Quiet-zone modules.")
    parser.add_argument("--interval", type=int, default=300, help="Slideshow interval in ms.")
    parser.add_argument("--clean", action="store_true", help="Delete the output directory before writing.")
    args = parser.parse_args()

    if not args.file.is_file():
        raise SystemExit(f"File not found: {args.file}")
    if args.chunk_size < 100 or args.chunk_size > 2200:
        raise SystemExit("--chunk-size must be between 100 and 2200")
    if args.clean and args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True, exist_ok=True)

    info = make_frames(args.file, args.chunk_size)
    frame_paths = write_qr_pngs(info["frames"], args.out, args.ecc, args.box_size, args.border)
    manifest = {key: value for key, value in info.items() if key != "frames"}
    manifest.update({"ecc": args.ecc, "frame_count": len(frame_paths), "slideshow": "slideshow.html"})
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    write_slideshow(args.out, frame_paths, manifest, args.interval)

    print(f"Wrote {len(frame_paths)} QR frames to {args.out}")
    print(f"Open {args.out / 'slideshow.html'}")
    print(f"Session: {info['sid']}  SHA-256: {info['sha256']}")


if __name__ == "__main__":
    main()
