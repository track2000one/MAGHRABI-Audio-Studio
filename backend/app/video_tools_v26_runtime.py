from __future__ import annotations

import os
import socket

from . import video_tools_v26 as base

# RAILWAY_REPLICA_ID is the preferred stable identity. When it is absent,
# never fall back to deployment id alone because a deployment may have more
# than one replica. Hostname + PID keeps the runtime node identity unique.
base.DEPLOYMENT_ID = os.getenv("RAILWAY_DEPLOYMENT_ID", "")
base.INSTANCE_ID = os.getenv("RAILWAY_REPLICA_ID") or os.getenv("HOSTNAME") or socket.gethostname()
base.NODE_ID = (
    os.getenv("RAILWAY_REPLICA_ID")
    or f"{base.DEPLOYMENT_ID or 'local'}:{socket.gethostname()}:{os.getpid()}"
)

router = base.router
install_reliability = base.install_reliability
