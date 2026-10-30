"""aihub-code: a Claude-Code-style coding CLI built on AIhub's engine."""
import logging

__version__ = "0.3.0"

# Library default: modules log to "aihub_code.*" and stay silent unless a
# front-end (the bridge, the CLI) installs a handler.
logging.getLogger("aihub_code").addHandler(logging.NullHandler())
