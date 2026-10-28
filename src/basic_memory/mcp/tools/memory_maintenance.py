"""MCP tools for deferred, bounded project memory maintenance."""

from typing import Annotated, Literal

from fastmcp import Context
from pydantic import Field

from basic_memory.mcp.clients.project import ProjectClient
from basic_memory.mcp.project_context import get_project_client
from basic_memory.mcp.server import mcp


@mcp.tool(
    name="bm_memory_maintenance",
    title="Memory Maintenance",
    description=(
        "Check whether project memory maintenance is due and get a bounded list of changed "
        "notes, or acknowledge a completed batch. This tool only tracks progress; it does "
        "not call a model or modify notes. Run maintenance after answering the current user "
        "request, in a later turn. Review title quality along with note content: correct "
        "generic, opaque, or misleading titles using evidence in the note, while preserving "
        "the file path and permalink. On complete, include reviewed_note_ids only for notes "
        "actually reviewed and organized. The list must cover every note returned in the batch; "
        "if any note could not be reviewed, leave the checkpoint unchanged and retry later."
    ),
    tags={"notes", "maintenance"},
    annotations={
        "title": "Memory Maintenance",
        "readOnlyHint": False,
        "destructiveHint": False,
        "openWorldHint": False,
    },
)
async def memory_maintenance(
    command: Annotated[Literal["status", "complete"], Field(description="Operation to perform.")],
    project: str,
    through_position: Annotated[
        int | None,
        Field(
            ge=0,
            description="For complete: the through_position returned for the finished batch.",
        ),
    ] = None,
    expected_after_position: Annotated[
        int | None,
        Field(
            ge=0,
            description="For complete: the after_position returned for the finished batch.",
        ),
    ] = None,
    reviewed_note_ids: Annotated[
        list[str] | None,
        Field(
            description=(
                "For complete: external IDs of notes in this batch that were actually "
                "reviewed and organized."
            ),
        ),
    ] = None,
    batch_size: Annotated[int, Field(ge=1, le=100)] = 20,
    context: Context | None = None,
) -> dict[str, object]:
    """Inspect the due state or acknowledge completed maintenance progress."""
    async with get_project_client(project, context) as (http_client, active_project):
        client = ProjectClient(http_client)
        if command == "status":
            status = await client.memory_maintenance_status(
                active_project.external_id,
                batch_size=batch_size,
            )
            return status.model_dump(mode="json")
        if through_position is None or expected_after_position is None or reviewed_note_ids is None:
            raise ValueError(
                "complete requires after_position, through_position, and reviewed_note_ids"
            )
        completed = await client.complete_memory_maintenance(
            active_project.external_id,
            expected_after_position,
            through_position,
            reviewed_note_ids,
        )
        return completed.model_dump(mode="json")
