"""Acclimate Python SDK.

Import the client, delivery helpers and wire types from this package. Every name listed in ``__all__`` is
public; anything else is an implementation detail.
"""

# Fail with a readable message before importing modules that need Python 3.11.
from ._python_version import require_supported_python as _require_supported_python

_require_supported_python()

from .client import (
    AcclimateClient as AcclimateClient,
    ApiError as ApiError,
    TransportError as TransportError,
)
from .errors import (
    AcclimateError as AcclimateError,
    UsageError as UsageError,
)
from .delivery import (
    DeliveryError as DeliveryError,
    PreparedFiles as PreparedFiles,
    PreparedDelivery as PreparedDelivery,
    prepare_files as prepare_files,
    resolve_and_cache as resolve_and_cache,
    system_prompt as system_prompt,
    validate_payload as validate_payload,
)
from ._jobs import Acclimate as Acclimate, Job as Job
from .receipts import (
    DeliveryReporter as DeliveryReporter,
    BoundDeliveryReporter as BoundDeliveryReporter,
)
from .async_client import (
    AsyncAcclimate as AsyncAcclimate,
    AsyncAcclimateClient as AsyncAcclimateClient,
    AsyncJob as AsyncJob,
    AsyncPreparedDelivery as AsyncPreparedDelivery,
)
from .skills import (
    BundleSkill as BundleSkill,
    BundleSkillFile as BundleSkillFile,
    SkillLookup as SkillLookup,
    SkillSummary as SkillSummary,
    extract_bundle_skills as extract_bundle_skills,
    render_bundle_prompt as render_bundle_prompt,
    select_approved_memory as select_approved_memory,
)
from .telemetry import telemetry_attributes as telemetry_attributes

# Wire types. ``acclimate.types.__all__`` lists them, so typing helpers such as
# Literal and TypedDict stay out of the package namespace.
from . import types as _types
from .types import *

__all__ = [
    "AcclimateClient",
    "Acclimate",
    "Job",
    "AsyncAcclimateClient",
    "AsyncAcclimate",
    "AsyncJob",
    "AsyncPreparedDelivery",
    "AcclimateError",
    "UsageError",
    "ApiError",
    "TransportError",
    "DeliveryError",
    "PreparedFiles",
    "PreparedDelivery",
    "prepare_files",
    "resolve_and_cache",
    "system_prompt",
    "validate_payload",
    "DeliveryReporter",
    "BoundDeliveryReporter",
    "BundleSkill",
    "BundleSkillFile",
    "SkillLookup",
    "SkillSummary",
    "extract_bundle_skills",
    "render_bundle_prompt",
    "select_approved_memory",
    "telemetry_attributes",
]
__all__ += _types.__all__
