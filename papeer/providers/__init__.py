"""AI connections behind one small interface.

Everything outside this package should import from here, not from the backend modules:

    provider = create_provider(settings, cancel)
    answer = provider.generate(instruction, data, schema)
"""
from papeer.providers.base import OptionField, ProviderBackend, ProviderSpec
from papeer.providers.common import Cancelled, UsageMeter, check_cancel, parse_json_answer
from papeer.providers.registry import BACKENDS, backend_class, create_provider, spec_for, specs

__all__ = [
    "BACKENDS", "Cancelled", "OptionField", "ProviderBackend", "ProviderSpec", "UsageMeter",
    "backend_class", "check_cancel", "create_provider", "parse_json_answer", "spec_for", "specs",
]
