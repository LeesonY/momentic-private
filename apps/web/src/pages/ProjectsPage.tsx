import React, { useEffect, useMemo, useState } from 'react';
import type {
  ModelProfile,
  Project,
  ProjectDeletionPreview,
} from '@localqa/contracts';
import { defaultApiClient } from '../api/index.ts';
import { useAppContext } from '../state/AppContext.tsx';
import { Page } from '../components/layout/Page.tsx';
import { CreateProjectDialog } from '../components/layout/CreateProjectDialog.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Field } from '../components/ui/Field.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import {
  deletionPreviewSummary,
  deletionBlocker,
  describeDefaultModel,
  isVersionConflict,
  nextProjectAfterRemoval,
  projectStatusLabel,
  validateProjectName,
} from '../utils/projectAdmin.ts';

type DialogState =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'rename'; project: Project }
  | { kind: 'status'; project: Project }
  | { kind: 'delete'; project: Project };

const formatDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/** 「项目管理」: every project of the platform, for platform admins only. */
export const ProjectsPage: React.FC = () => {
  const {
    currentUser,
    projects,
    currentProject,
    setCurrentProject,
    replaceProject,
    removeProject,
    refreshProjects,
  } = useAppContext();
  const isAdmin = currentUser?.globalRole === 'admin';

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        await refreshProjects();
        const modelPage = await defaultApiClient.listModels();
        if (!cancelled) setModels(modelPage.items);
      } catch (error) {
        if (!cancelled)
          setLoadError(
            error instanceof Error ? error.message : '加载项目列表失败',
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, refreshProjects]);

  const sorted = useMemo(
    () =>
      [...projects].sort((left, right) => {
        if (left.status !== right.status)
          return left.status === 'active' ? -1 : 1;
        return left.createdAt.localeCompare(right.createdAt);
      }),
    [projects],
  );

  if (!isAdmin) {
    return (
      <Page
        title="项目管理"
        description="创建、重命名、归档和删除平台上的项目。"
        testId="projects-page"
      >
        <EmptyState
          icon="lock"
          title="仅平台管理员可用"
          description="当前账号没有平台管理员权限，无法管理项目列表。"
        />
      </Page>
    );
  }

  const close = () => setDialog({ kind: 'none' });

  const activate = (project: Project) => setCurrentProject(project);

  return (
    <Page
      width="wide"
      title="项目管理"
      description="创建、重命名、归档和删除平台上的项目。归档不会删除数据，删除会让项目及其数据不再可见。"
      testId="projects-page"
      actions={
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setDialog({ kind: 'create' })}
          data-testid="btn-projects-create"
        >
          <AppIcon name="plus" size={16} />
          新建项目
        </button>
      }
    >
      {loadError && (
        <Alert
          tone="danger"
          role="alert"
          title="加载失败"
          testId="projects-load-error"
          action={
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void refreshProjects().catch(() => undefined)}
            >
              重试
            </button>
          }
        >
          {loadError}
        </Alert>
      )}

      {sorted.length === 0 && !loading ? (
        <EmptyState
          icon="inbox"
          title="还没有项目"
          description="项目是最外层的工作区：会话、用例、环境和模型授权都归属于某个项目。"
          actionText="新建项目"
          onAction={() => setDialog({ kind: 'create' })}
        />
      ) : (
        <div className="card card-flush">
          <div className="table-container">
            <table className="data-table" data-testid="projects-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>状态</th>
                  <th>默认模型</th>
                  <th>创建时间</th>
                  <th className="cell-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((project) => {
                  const isCurrent = project.id === currentProject?.id;
                  return (
                    <tr
                      key={project.id}
                      className={
                        project.status === 'archived' ? 'is-archived' : ''
                      }
                      data-testid={`project-row-${project.id}`}
                    >
                      <td>
                        <div className="cell-title">
                          {project.name}
                          {isCurrent && (
                            <span
                              className="badge badge-info lqa-project-current"
                              data-testid={`project-current-${project.id}`}
                            >
                              当前
                            </span>
                          )}
                        </div>
                        <div className="cell-sub mono">{project.id}</div>
                      </td>
                      <td>
                        <StatusBadge
                          status={project.status}
                          label={projectStatusLabel(project.status)}
                        />
                      </td>
                      <td data-testid={`project-model-${project.id}`}>
                        {describeDefaultModel(
                          models,
                          project.defaultModelProfileId,
                        )}
                      </td>
                      <td>{formatDate(project.createdAt)}</td>
                      <td className="cell-actions">
                        <div className="lqa-project-actions">
                          {!isCurrent && project.status === 'active' && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => activate(project)}
                              data-testid={`btn-project-switch-${project.id}`}
                            >
                              切换
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() =>
                              setDialog({ kind: 'rename', project })
                            }
                            data-testid={`btn-project-rename-${project.id}`}
                          >
                            重命名
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() =>
                              setDialog({ kind: 'status', project })
                            }
                            data-testid={`btn-project-archive-${project.id}`}
                          >
                            {project.status === 'active' ? '归档' : '恢复'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger-outline btn-sm"
                            onClick={() =>
                              setDialog({ kind: 'delete', project })
                            }
                            data-testid={`btn-project-delete-${project.id}`}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {dialog.kind === 'create' && <CreateProjectDialog onClose={close} />}
      {dialog.kind === 'rename' && (
        <RenameProjectDialog
          project={dialog.project}
          onClose={close}
          onSaved={(saved) => {
            replaceProject(saved);
            close();
          }}
        />
      )}
      {dialog.kind === 'status' && (
        <ProjectStatusDialog
          project={dialog.project}
          onClose={close}
          onSaved={(saved) => {
            replaceProject(saved);
            // An archived current project can no longer host new sessions.
            if (
              saved.status === 'archived' &&
              saved.id === currentProject?.id
            ) {
              const next = nextProjectAfterRemoval(projects, saved.id);
              if (next) setCurrentProject(next);
            }
            close();
          }}
        />
      )}
      {dialog.kind === 'delete' && (
        <DeleteProjectDialog
          project={dialog.project}
          onClose={close}
          onDeleted={(projectId) => {
            removeProject(projectId);
            close();
          }}
        />
      )}
    </Page>
  );
};

/** Rename: trimmed, non-empty, ≤120 characters, optimistic-versioned. */
const RenameProjectDialog: React.FC<{
  project: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}> = ({ project, onClose, onSaved }) => {
  const { refreshProjects } = useAppContext();
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = validateProjectName(name);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !check.ok) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await defaultApiClient.updateProject(project.id, {
        expectedVersion: project.version,
        name: check.name,
      });
      onSaved(saved);
    } catch (reason) {
      if (isVersionConflict(reason)) {
        await refreshProjects().catch(() => undefined);
        setError('项目已被其他人修改，列表已刷新，请重新操作。');
      } else {
        setError(reason instanceof Error ? reason.message : '重命名失败');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="重命名项目"
      onClose={onClose}
      closeOnOverlay={!saving}
      testId="project-rename-dialog"
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={saving}
            data-testid="project-rename-cancel"
          >
            取消
          </button>
          <button
            type="submit"
            form="project-rename-form"
            className="btn btn-primary"
            disabled={saving || !check.ok || check.name === project.name}
            data-testid="project-rename-confirm"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <form id="project-rename-form" onSubmit={submit}>
        <Field
          label="项目名称"
          required
          htmlFor="project-rename-name"
          hint="最多 120 个字符，首尾空格会被去掉。"
        >
          <input
            id="project-rename-name"
            className="form-input"
            data-testid="project-rename-name"
            value={name}
            autoFocus
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {!check.ok && name.length > 0 && (
          <p className="field-error" data-testid="project-rename-error">
            {check.error}
          </p>
        )}
        {error && (
          <Alert
            tone="danger"
            role="alert"
            testId="project-rename-submit-error"
          >
            {error}
          </Alert>
        )}
      </form>
    </Modal>
  );
};

/** Archive or restore; archiving only changes what new work is allowed. */
const ProjectStatusDialog: React.FC<{
  project: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}> = ({ project, onClose, onSaved }) => {
  const { refreshProjects } = useAppContext();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archiving = project.status === 'active';

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await defaultApiClient.updateProject(project.id, {
        expectedVersion: project.version,
        status: archiving ? 'archived' : 'active',
      });
      onSaved(saved);
    } catch (reason) {
      if (isVersionConflict(reason)) {
        await refreshProjects().catch(() => undefined);
        setError('项目已被其他人修改，列表已刷新，请重新操作。');
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : archiving
              ? '归档失败'
              : '恢复失败',
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={archiving ? '归档项目' : '恢复项目'}
      onClose={onClose}
      closeOnOverlay={!saving}
      testId="project-status-dialog"
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={saving}
            data-testid="project-status-cancel"
          >
            取消
          </button>
          <button
            type="button"
            className={archiving ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={saving}
            onClick={() => void submit()}
            data-testid="project-status-confirm"
          >
            {saving ? '处理中…' : archiving ? '确认归档' : '恢复项目'}
          </button>
        </>
      }
    >
      <p>
        {archiving
          ? `归档「${project.name}」后不能再发起新的冒烟或回归会话，历史报告、用例和证据都会保留。`
          : `恢复「${project.name}」后可以重新发起会话。已停用的定时计划不会自动重新启用，需要到定时回归页手动开启。`}
      </p>
      {error && (
        <Alert tone="danger" role="alert" testId="project-status-error">
          {error}
        </Alert>
      )}
    </Modal>
  );
};

/** Deletion: preview what disappears, block on running sessions, confirm by name. */
const DeleteProjectDialog: React.FC<{
  project: Project;
  onClose: () => void;
  onDeleted: (projectId: string) => void;
}> = ({ project, onClose, onDeleted }) => {
  const [preview, setPreview] = useState<ProjectDeletionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setPreviewError(null);
      try {
        const loaded = await defaultApiClient.getProjectDeletionPreview(
          project.id,
        );
        if (!cancelled) setPreview(loaded);
      } catch (reason) {
        if (!cancelled)
          setPreviewError(
            reason instanceof Error ? reason.message : '无法读取项目的删除预览',
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const blocked = deletionBlocker(preview);
  const nameMatches = confirmName === project.name;
  const canDelete =
    Boolean(preview) && !blocked && nameMatches && !deleting && !loading;

  const submit = async () => {
    if (!canDelete || !preview) return;
    setDeleting(true);
    setError(null);
    try {
      await defaultApiClient.deleteProject(project.id, {
        expectedVersion: preview.version,
        confirmName,
      });
      onDeleted(project.id);
    } catch (reason) {
      const code = (reason as { code?: string } | null)?.code;
      if (code === 'VERSION_CONFLICT') {
        setError('项目已被其他人修改，请关闭后重新打开删除确认。');
      } else {
        setError(reason instanceof Error ? reason.message : '删除项目失败');
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      title="删除项目"
      onClose={onClose}
      closeOnOverlay={!deleting}
      testId="project-delete-dialog"
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={deleting}
            data-testid="project-delete-cancel"
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!canDelete}
            onClick={() => void submit()}
            data-testid="project-delete-confirm"
          >
            {deleting ? '正在删除…' : '确认删除'}
          </button>
        </>
      }
    >
      <p>
        删除「{project.name}
        」后，项目及其会话、用例、证据都不再可见，无法在页面恢复。
      </p>
      {loading && <p className="field-hint">正在读取项目中包含的数据…</p>}
      {preview && (
        <Alert
          tone={preview.empty ? 'warning' : 'danger'}
          testId="project-delete-preview"
        >
          {deletionPreviewSummary(preview)}
        </Alert>
      )}
      {blocked && (
        <Alert
          tone="warning"
          role="alert"
          testId="project-delete-blocked"
          title="现在不能删除"
        >
          {blocked}
        </Alert>
      )}
      {previewError && (
        <Alert tone="danger" role="alert" testId="project-delete-preview-error">
          {previewError}
        </Alert>
      )}
      {error && (
        <Alert tone="danger" role="alert" testId="project-delete-error">
          {error}
        </Alert>
      )}
      <Field
        label={`输入项目名称「${project.name}」以确认`}
        htmlFor="project-delete-name"
        hint="重名项目不会一起删除。"
      >
        <input
          id="project-delete-name"
          className="form-input"
          data-testid="project-delete-name"
          value={confirmName}
          autoComplete="off"
          disabled={deleting || !preview || Boolean(blocked)}
          onChange={(event) => setConfirmName(event.target.value)}
        />
      </Field>
    </Modal>
  );
};
