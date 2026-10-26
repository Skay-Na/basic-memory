"""Run the local Basic Memory browser workspace and HTTP API."""

import ipaddress
import os

import typer
import uvicorn

from basic_memory.cli.app import app


def _is_loopback_host(host: str) -> bool:
    """Return whether an HTTP bind address is local to this machine."""
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


@app.command()
def web(
    host: str = typer.Option(
        "127.0.0.1",
        help="Bind address. The web/API server has no authentication; keep the default local bind.",
    ),
    port: int = typer.Option(18888, min=1, max=65535, help="HTTP port for the web app and API."),
) -> None:
    """Open the local Basic Memory browser workspace."""
    os.environ["BASIC_MEMORY_FORCE_LOCAL"] = "true"
    os.environ.pop("BASIC_MEMORY_FORCE_CLOUD", None)
    os.environ["BASIC_MEMORY_EXPLICIT_ROUTING"] = "true"

    if not _is_loopback_host(host):
        typer.echo(
            "Warning: the web app and API have no authentication. Bind to 127.0.0.1 "
            "unless a trusted authenticated proxy protects this server.",
            err=True,
        )

    typer.echo(f"Basic Memory web app: http://{host}:{port}")
    uvicorn.run("basic_memory.api.app:app", host=host, port=port, log_level="info")
