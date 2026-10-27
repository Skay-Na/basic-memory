"""Track the last completed maintenance pass for each reviewed note.

Revision ID: a4b5c6d7e8f9
Revises: z9a0b1c2d3e4
Create Date: 2026-10-27
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a4b5c6d7e8f9"
down_revision: Union[str, None] = "z9a0b1c2d3e4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Persist note-level review times for the knowledge-graph freshness colors."""
    op.create_table(
        "memory_maintenance_review",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("note_external_id", sa.String(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reviewed_through_position", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id",
            "note_external_id",
            name="uq_memory_maintenance_review_project_note",
        ),
    )

def downgrade() -> None:
    """Remove per-note maintenance review timestamps."""
    op.drop_table("memory_maintenance_review")
