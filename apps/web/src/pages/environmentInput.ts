import type { EnvironmentCreate } from '@localqa/contracts';

/** Apply the same origin and TLS safeguards when editing an existing target. */
export function validatedEnvironmentInput(
  name: string,
  baseUrl: string,
  originsText: string,
  excludedPathsText: string,
  tlsPolicy: 'strict' | 'allow_self_signed',
  confirmedInsecureTls: boolean,
): EnvironmentCreate {
  const base = new URL(baseUrl.trim());
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.hash
  )
    throw new Error('基准地址必须是不包含账号、密码和 # 片段的 HTTP(S) URL');
  const parsedOrigins = originsText
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const normalizedOrigins = (
    parsedOrigins.length ? parsedOrigins : [base.origin]
  ).map((text) => {
    const url = new URL(text);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('获准 Origins 只能包含 HTTP(S) 协议、主机和端口');
    return url.origin;
  });
  if (!normalizedOrigins.includes(base.origin))
    throw new Error('获准 Origins 必须包含基准地址的 Origin');
  const excludedPaths = excludedPathsText
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (excludedPaths.some((s) => !s.startsWith('/') || s.length > 300))
    throw new Error('排除路径必须以 / 开头且不超过 300 字符');
  if (
    tlsPolicy === 'allow_self_signed' &&
    (!confirmedInsecureTls || base.protocol !== 'https:')
  )
    throw new Error('放宽 TLS 校验必须使用 HTTPS 并明确确认证书风险');
  if (!name.trim()) throw new Error('环境名称不能为空');
  return {
    name: name.trim(),
    baseUrl: base.toString(),
    allowedOrigins: [
      base.origin,
      ...new Set(normalizedOrigins.filter((origin) => origin !== base.origin)),
    ],
    excludedPaths: [...new Set(excludedPaths)],
    tlsPolicy,
  };
}
