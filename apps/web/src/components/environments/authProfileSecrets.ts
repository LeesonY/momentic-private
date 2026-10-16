import type {
  AuthProfile,
  AuthProfilePatch,
  AuthVariable,
} from '@localqa/contracts';

export interface AgentVariableDraft {
  name: string;
  value: string;
  sensitive: boolean;
  note: string;
}

const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_AUTH_SECRET_LENGTH = 1_000_000;
export const AUTH_SECRET_SAVED_NOTICE =
  '已保存为新版本。正在进行的会话中，之后新开始的登录会使用新的账号；可以回到会话让主 AI 重试。';

/** Copy only public metadata. Stored values are never read or prefilled. */
export const emptyAgentVariables = (
  variables: readonly AuthVariable[],
): AgentVariableDraft[] =>
  variables.map((variable) => ({
    name: variable.name,
    sensitive: variable.sensitive,
    note: variable.note ?? '',
    value: '',
  }));

const hasValue = (value: string): boolean =>
  value.length > 0 && value.length <= MAX_AUTH_SECRET_LENGTH;

export const agentSecretInput = (
  variables: readonly AgentVariableDraft[],
): Record<string, string> => {
  const names = variables.map((variable) => variable.name.trim());
  if (
    variables.length < 1 ||
    variables.length > 20 ||
    new Set(names).size !== names.length ||
    variables.some(
      (variable, index) =>
        !VARIABLE_NAME.test(names[index]!) || !hasValue(variable.value),
    )
  )
    throw new Error('MISSING_AUTH_MATERIAL');
  return Object.fromEntries(
    variables.map((variable, index) => [names[index]!, variable.value]),
  );
};

export const formSecretInput = (
  username: string,
  password: string,
): Record<string, string> => {
  if (!hasValue(username) || !hasValue(password))
    throw new Error('MISSING_AUTH_MATERIAL');
  return { username, password };
};

export const canEditAuthSecrets = (profile: AuthProfile): boolean =>
  profile.status === 'active' &&
  ((profile.mode === 'form' && Boolean(profile.formConfig)) ||
    (profile.mode === 'agent' &&
      Boolean(profile.agentConfig?.variables.length)));

/** PATCH replaces the entire secret; every declared value must be supplied. */
export const authSecretPatch = (
  profile: AuthProfile,
  variables: readonly AgentVariableDraft[],
  username: string,
  password: string,
): AuthProfilePatch => {
  if (!canEditAuthSecrets(profile)) throw new Error('INVALID_AUTH_PROFILE');
  if (profile.mode === 'agent') {
    const names = profile.agentConfig!.variables.map(
      (variable) => variable.name,
    );
    if (
      variables.length !== names.length ||
      variables.some((variable, index) => variable.name !== names[index])
    )
      throw new Error('MISSING_AUTH_MATERIAL');
  }
  return {
    expectedVersion: profile.version,
    secretInput:
      profile.mode === 'agent'
        ? agentSecretInput(variables)
        : formSecretInput(username, password),
  };
};

/** Do not display server diagnostics: they may contain submitted credentials. */
export const authSecretUpdateError = (reason: unknown): string => {
  if (
    (reason &&
      typeof reason === 'object' &&
      (('code' in reason && reason.code === 'VERSION_CONFLICT') ||
        ('status' in reason && reason.status === 409))) ||
    (reason instanceof Error && reason.message === 'VERSION_CONFLICT')
  )
    return '配置已被修改，请刷新后重试';
  return '保存失败，请完整填写所有新值后重试。';
};
