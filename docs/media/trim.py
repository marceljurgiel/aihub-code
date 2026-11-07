"""Shorten every still stretch of a GIF to KEEP seconds (the last to END),
optionally cropping it to a height. Usage: trim.py file.gif [height]"""
import re
import subprocess
import sys

KEEP, END = 3.0, 4.0
gif = sys.argv[1]
height = int(sys.argv[2]) if len(sys.argv) > 2 else None

dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", gif], capture_output=True, text=True).stdout)
log = subprocess.run(["ffmpeg", "-v", "info", "-i", gif, "-vf", "freezedetect=n=0.001:d=4",
                      "-map", "0:v", "-f", "null", "-"], capture_output=True, text=True).stderr
starts = [float(x) for x in re.findall(r"freeze_start: ([0-9.]+)", log)]
ends = [float(x) for x in re.findall(r"freeze_end: ([0-9.]+)", log)]
cuts = []
for i, s in enumerate(starts):
    e = ends[i] if i < len(ends) else None
    if e is None:                       # still to the end: keep END seconds
        if dur - s > END:
            cuts.append((s + END, dur + 1))
    elif e - s > KEEP:
        cuts.append((s + KEEP, e))
keep = "*".join(f"not(between(t,{a:.2f},{b:.2f}))" for a, b in cuts) or "1"
vf = f"select='{keep}',setpts=N/10/TB"
if height:
    vf += f",crop=iw:{height}:0:0"
vf += ",split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4"
tmp = gif + ".tmp.gif"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", gif, "-vf", vf, "-r", "10", tmp], check=True)
subprocess.run(["mv", tmp, gif], check=True)
new = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", gif], capture_output=True, text=True).stdout)
print(f"{gif}: {dur:.1f}s -> {new:.1f}s, cut {len(cuts)} still stretches")
