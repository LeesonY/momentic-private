import { parseContract, type SavedCaseVersion } from '@localqa/contracts';

export interface LocatorMaintenanceInfo {
  maintenanceId: string;
  candidateVersionId: string;
  sourceVersionId: string;
  taskId: string;
}
export interface LocatorMaintenanceVerification {
  id: string;
  status: 'queued' | 'running' | 'completed';
  outcome: 'passed' | 'failed' | 'inconclusive' | null;
  reasonCode: string | null;
  observedSteps: number;
  verifiedCriteria: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface LocatorMaintenanceEvidence {
  id: string;
  stepIndex: number;
  stepKind: string;
  criterionId: string | null;
  criterionPassed: boolean | null;
  snapshotSha256: string;
  screenshotSha256: string | null;
  retention: string;
}
const root = '/api/v1';
const encode = encodeURIComponent;

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(root + path, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { message?: string };
    const e = new Error(error.message || `HTTP ${res.status}`);
    (e as Error & { status: number }).status = res.status;
    throw e;
  }
  return res.json() as Promise<T>;
}

export async function createLocatorMaintenanceDraft(
  caseId: string,
  taskId: string,
  expectedVersion: number,
  suggestionIndex = 0,
  autoVerify = false,
): Promise<SavedCaseVersion> {
  const body = await call<unknown>(
    `/saved-cases/${encode(caseId)}/locator-maintenance/${encode(taskId)}/draft`,
    { expectedVersion, suggestionIndex, autoVerify },
  );
  return parseContract('SavedCaseVersion', body);
}

export interface LocatorCandidateComparison {
  suggestionIndex: number | null;
  candidateVersionId: string;
  version: number;
  reviewStatus: 'draft' | 'approved' | 'rejected';
  verificationId: string | null;
  status: 'queued' | 'running' | 'completed' | null;
  outcome: 'passed' | 'failed' | 'inconclusive' | null;
  reasonCode: string | null;
  observedSteps: number;
  verifiedCriteria: number;
  evidenceBacked: boolean;
}
export function listLocatorCandidateComparison(
  caseId: string,
  taskId: string,
): Promise<{ items: LocatorCandidateComparison[] }> {
  return call(
    `/saved-cases/${encode(caseId)}/locator-maintenance/${encode(taskId)}/comparison`,
  );
}

/** Retrospective metrics based only on trusted DB bindings and human reviews.
 * A 90-day sample, max 100 drafts; not an AI recommendation accuracy score. */
export interface LocatorMaintenanceEffectiveness {
  sampleWindowDays: number;
  sampleLimit: number;
  truncated: boolean;
  metrics: {
    drafts: number;
    verifiedCompleted: number;
    verifiedPassed: number;
    verifiedFailed: number;
    verifiedInconclusive: number;
    verificationPending: number;
    humanReviewed: number;
    humanApproved: number;
    humanRejected: number;
    passedButRejected: number;
  };
  byKind: {
    kind: 'locator_name_variation' | 'locator_semantic_candidate';
    drafts: number;
    verifiedPassed: number;
    humanApproved: number;
    passedButRejected: number;
  }[];
  items: {
    candidateVersionId: string;
    version: number;
    taskId: string;
    suggestionIndex: number | null;
    kind: 'locator_name_variation' | 'locator_semantic_candidate' | null;
    createdAt: string;
    reviewStatus: 'draft' | 'approved' | 'rejected';
    reviewedAt: string | null;
    reviewReason: string | null;
    verificationStatus: 'queued' | 'running' | 'completed' | null;
    verificationOutcome: 'passed' | 'failed' | 'inconclusive' | null;
    verifiedPassed: boolean;
    screenshotAvailable: boolean;
  }[];
}
export function getLocatorMaintenanceEffectiveness(
  caseId: string,
): Promise<LocatorMaintenanceEffectiveness> {
  return call(`/saved-cases/${encode(caseId)}/locator-maintenance/effectiveness`);
}
export function getLocatorMaintenanceInfo(
  versionId: string,
): Promise<LocatorMaintenanceInfo> {
  return call(`/saved-case-versions/${encode(versionId)}/locator-maintenance`);
}
export function listLocatorMaintenanceVerifications(
  versionId: string,
): Promise<{ items: LocatorMaintenanceVerification[] }> {
  return call(
    `/saved-case-versions/${encode(versionId)}/locator-maintenance/verifications`,
  );
}
export function startLocatorMaintenanceVerification(
  versionId: string,
): Promise<LocatorMaintenanceVerification> {
  return call(
    `/saved-case-versions/${encode(versionId)}/locator-maintenance/verifications`,
    {},
  );
}
export async function listLocatorMaintenanceEvidence(
  versionId: string,
  verificationId: string,
): Promise<{ items: LocatorMaintenanceEvidence[] }> {
  const result = await call<unknown>(
    `/saved-case-versions/${encode(versionId)}/locator-maintenance/verifications/${encode(verificationId)}/evidence`,
  );
  return parseContract('RepairCandidateEvidencePage', result);
}
export function locatorMaintenanceScreenshotUrl(
  versionId: string,
  verificationId: string,
  evidenceId: string,
): string {
  return (
    root +
    `/saved-case-versions/${encode(versionId)}/locator-maintenance/verifications/${encode(verificationId)}/evidence/${encode(evidenceId)}/screenshot`
  );
}
