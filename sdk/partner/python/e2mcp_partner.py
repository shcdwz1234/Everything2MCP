"""Thin Python stub for the E2MCP Partner protocol.

Apps do not implement MCP. This module is a documented helper, not a
full client. Use register / heartbeat / unregister against the loopback
control plane, and serve an HTTP invoke callback.

See docs/PARTNER.md.
"""

from __future__ import annotations

import json
import urllib.request
from typing import Any, Callable, Mapping


def register(base_url: str, token: str, manifest: Mapping[str, Any]) -> Any:
    return _post(f"{base_url.rstrip('/')}/api/partner/v1/register", token, dict(manifest))


def heartbeat(base_url: str, token: str, capability_id: str) -> Any:
    return _post(f"{base_url.rstrip('/')}/api/partner/v1/heartbeat", token, {"capability_id": capability_id})


def unregister(base_url: str, token: str, capability_id: str) -> Any:
    return _post(
        f"{base_url.rstrip('/')}/api/partner/v1/unregister",
        token,
        {"capability_id": capability_id, "confirm": True},
    )


def serve_invoke(handler: Callable[[dict[str, Any]], Any], host: str = "127.0.0.1", port: int = 0) -> None:
    """Placeholder: use http.server in your app, or the Node SDK serveInvoke."""
    raise NotImplementedError("Use Node sdk/partner serveInvoke or a tiny HTTP server; see examples/partner-demo-chat")


def _post(url: str, token: str, body: dict[str, Any]) -> Any:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
            "x-partner-token": token,
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode("utf-8"))
