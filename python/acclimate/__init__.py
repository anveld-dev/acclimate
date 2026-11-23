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
    validate_payload as validate_payload,
)
from ._jobs import Acclimate as Acclimate, Job as Job
from .receipts import (
    DeliveryReporter as DeliveryReporter,
    BoundDeliveryReporter as BoundDeliveryReporter,
)

# Wire types. ``acclimate.types.__all__`` lists them, so typing helpers such as
# Literal and TypedDict stay out of the package namespace.
from . import types as _types
from .types import *

__all__ = [
    "AcclimateClient",
    "Acclimate",
    "Job",
    "AcclimateError",
    "UsageError",
    "ApiError",
    "TransportError",
    "DeliveryError",
    "PreparedFiles",
    "PreparedDelivery",
    "prepare_files",
    "resolve_and_cache",
    "validate_payload",
    "DeliveryReporter",
    "BoundDeliveryReporter",
]
__all__ += _types.__all__
