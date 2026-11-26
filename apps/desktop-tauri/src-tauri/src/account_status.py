import base64
import json
import os
import subprocess
import sys
from pathlib import Path

claude = sys.argv[1] == "claude"
cmd = ["claude", "auth", "status", "--json"] if claude else ["codex", "login", "status"]
result = subprocess.run(cmd, capture_output=True, timeout=12)
connected = result.returncode == 0
email = None
if connected:
    try:
        if claude:
            status = json.loads(result.stdout)
            connected = status.get("loggedIn", True)
            email = status.get("email")
        else:
            directory = Path(os.getenv("CODEX_HOME") or Path.home() / ".codex")
            auth = json.loads((directory / "auth.json").read_bytes())
            claim = auth["tokens"]["id_token"].split(".")[1]
            email = json.loads(base64.urlsafe_b64decode(claim + "===")).get("email")
    except (ValueError, KeyError, OSError, AttributeError, IndexError, TypeError):
        pass
print(json.dumps({"authenticated": connected, "email": email}))
