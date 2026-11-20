from typing import TypedDict


class CaseKey(TypedDict):
    caseId: str
    repetition: int


class Usage(TypedDict, total=False):
    inputTokens: int
    outputTokens: int
    costUsd: float


class EvaluationDescriptor(TypedDict):
    datasetRevision: str
    graderRevision: str
    runtime: dict[str, str]
    expectedCases: list[CaseKey]


