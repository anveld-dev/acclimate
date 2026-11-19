type VersionIdentity = { versionId: string; digest: string };

export function isCurrentDelivery(report: VersionIdentity, current: VersionIdentity) {
  return report.versionId === current.versionId && report.digest === current.digest;
}
