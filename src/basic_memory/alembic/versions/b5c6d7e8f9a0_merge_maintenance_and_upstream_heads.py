"""Merge memory-maintenance and upstream migration heads.

Revision ID: b5c6d7e8f9a0
Revises: 0043, a4b5c6d7e8f9
Create Date: 2026-10-27
"""

from typing import Sequence, Union


revision: str = "b5c6d7e8f9a0"
down_revision: Union[str, Sequence[str], None] = ("0043", "a4b5c6d7e8f9")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Both parent branches already applied their schema changes."""


def downgrade() -> None:
    """Splitting the migration graph requires no schema change."""
