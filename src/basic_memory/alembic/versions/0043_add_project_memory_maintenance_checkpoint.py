"""Track memory-maintenance settings and the accepted-change checkpoint.

Revision ID: 0043
Revises: 0042
Create Date: 2026-10-26
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0043"
down_revision: Union[str, None] = "0042"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add a per-project maintenance checkpoint to the accepted-change stream."""
    op.add_column(
        "project",
        sa.Column(
            "memory_maintenance_position",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column(
        "project",
        sa.Column("memory_maintenance_completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "project",
        sa.Column("memory_maintenance_baseline_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "project",
        sa.Column(
            "memory_maintenance_interval_days",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("14"),
        ),
    )
    # Existing projects have no completed-maintenance timestamp. Start their
    # first interval at upgrade time and skip journal positions that predate
    # this feature, so they are not immediately due with an empty batch.
    op.execute(
        sa.text(
            "UPDATE project "
            "SET memory_maintenance_position = partition_position, "
            "memory_maintenance_baseline_at = CURRENT_TIMESTAMP"
        )
    )
    op.add_column(
        "project",
        sa.Column(
            "memory_maintenance_note_threshold",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("20"),
        ),
    )


def downgrade() -> None:
    """Remove the project maintenance checkpoint."""
    op.drop_column("project", "memory_maintenance_note_threshold")
    op.drop_column("project", "memory_maintenance_interval_days")
    op.drop_column("project", "memory_maintenance_baseline_at")
    op.drop_column("project", "memory_maintenance_completed_at")
    op.drop_column("project", "memory_maintenance_position")
