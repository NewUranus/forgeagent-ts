"""Standalone exercise adapted from SWE-bench Pro, not Ansible source."""


def is_valid_collection_name(value):
    if not isinstance(value, str):
        return False
    parts = value.split(".")
    return len(parts) == 2 and all(part.isidentifier() for part in parts)
