/** Privileged endpoint not yet included in the generated OpenAPI client. */
export async function deleteEmptyProject(
  projectId: string,
  input: { expectedVersion: number; confirmName: string },
): Promise<void> {
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(projectId)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    },
  );
  if (response.status === 204) return;
  const failure = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
  };
  throw new Error(
    failure.message
      ? `${failure.message}（${failure.code ?? response.status}）`
      : `删除失败：HTTP ${response.status}`,
  );
}
