"""Project memory-maintenance status and checkpoint payloads."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ChangedMemoryNote(BaseModel):
    """One distinct note changed since the maintenance checkpoint."""

    external_id: str
    permalink: str
    title: str
    operation: str
    partition_position: int = Field(ge=1)


class MemoryMaintenanceSettings(BaseModel):
    """User-configurable project maintenance thresholds."""

    model_config = ConfigDict(extra="forbid")

    interval_days: int = Field(default=14, ge=1, le=365)
    note_threshold: int = Field(default=20, ge=1, le=1000)


class MemoryMaintenanceStatus(BaseModel):
    """Read-only maintenance signal for one project."""

    model_config = ConfigDict(extra="forbid")

    project_id: str
    project_name: str
    due: bool
    reason: str | None = None
    changed_note_count: int = Field(ge=0)
    after_position: int = Field(ge=0)
    through_position: int = Field(ge=0)
    last_completed_at: datetime | None = None
    changed_notes: list[ChangedMemoryNote]


class MemoryMaintenanceCompletion(BaseModel):
    """Acknowledge a bounded, successfully reviewed journal range."""

    model_config = ConfigDict(extra="forbid")

    through_position: int = Field(ge=0)


class MemoryMaintenanceCompletionResponse(BaseModel):
    """Persisted progress after acknowledging a range."""

    project_id: str
    through_position: int = Field(ge=0)
    completed_at: datetime
