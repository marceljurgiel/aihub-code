"""Small test helpers."""
import io

from PIL import Image


def png_bytes(w=40, h=30, mode="RGB"):
    buf = io.BytesIO()
    Image.new(mode, (w, h), (200, 30, 30, 128) if mode == "RGBA" else (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()
