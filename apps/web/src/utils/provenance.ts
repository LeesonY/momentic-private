import { validateContract, type RegressionBinding } from '@localqa/contracts';

export interface ProvenanceStatus {
  isComplete: boolean;
  statusLabel:
    '来源信息完整' | '来源信息不完整 (未验证)' | '来源信息缺失 (未验证)';
  badgeVariant: 'success' | 'warning';
  missingFields: string[];
}

const FIELD_LABELS: Record<string, string> = {
  sourceVersionId: '源版本ID (UUID)',
  sourceDocumentSha256: '源文档指纹 (SHA-256)',
  document: '用例契约文档 (RegressionDocument)',
  moduleSnapshots: '模块版本快照 (moduleSnapshots)',
  snapshotDocumentSha256: '快照文档指纹 (SHA-256)',
};

/**
 * Validates the completeness and canonical schema conformance of regression provenance metadata for UI presentation.
 * Note: When all canonical fields are present and conform strictly to the canonical RegressionBinding schema
 * (including UUID format, 64-char lowercase hex SHA, valid RegressionDocument, and valid moduleSnapshots),
 * it is labeled as "来源信息完整" (Provenance Complete).
 * Legal historical cases where optional snapshotDocumentSha256 is omitted are cleanly accepted.
 * Field presence is strictly not described as "独立验证" (Independently Verified), and unverified status
 * is NOT a test verdict (未验证不是裁决).
 */
export function getRegressionProvenanceStatus(
  regression?: RegressionBinding | null,
): ProvenanceStatus {
  if (!regression || typeof regression !== 'object') {
    return {
      isComplete: false,
      statusLabel: '来源信息缺失 (未验证)',
      badgeVariant: 'warning',
      missingFields: ['regression: 缺少回归来源绑定对象'],
    };
  }

  const validation = validateContract('RegressionBinding', regression);
  if (validation.success) {
    return {
      isComplete: true,
      statusLabel: '来源信息完整',
      badgeVariant: 'success',
      missingFields: [],
    };
  }

  const missingFields: string[] = [];
  for (const err of validation.errors ?? []) {
    const rawPath = err.instancePath
      ? err.instancePath.replace(/^\//, '').replace(/\//g, '.')
      : '';
    const prop = (err.params as { missingProperty?: string } | undefined)
      ?.missingProperty;
    const targetProp = prop ? (rawPath ? `${rawPath}.${prop}` : prop) : rawPath;
    const rootProp = targetProp.split('.')[0] || '';
    const friendlyLabel = FIELD_LABELS[rootProp] || targetProp || '契约字段';
    const detail =
      targetProp && targetProp !== rootProp
        ? `${friendlyLabel} [${targetProp}]: ${err.message}`
        : `${friendlyLabel}: ${err.message}`;
    missingFields.push(detail);
  }

  return {
    isComplete: false,
    statusLabel: '来源信息不完整 (未验证)',
    badgeVariant: 'warning',
    missingFields,
  };
}
