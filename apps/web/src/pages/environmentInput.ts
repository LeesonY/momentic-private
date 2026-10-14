import type { EnvironmentCreate } from '@localqa/contracts';

/** Keep origin restrictions, and treat TLS controls as inapplicable to HTTP. */
export function validatedEnvironmentInput(
  name: string,
  baseUrl: string,
  originsText: string,
  excludedPathsText: string,
  tlsPolicy: 'strict' | 'allow_self_signed',
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
  // HTTP has no server certificate; do not persist a meaningless bypass
  // that could become dangerous if the environment URL later changes.
  // For HTTPS, selecting 'allow_self_signed' explicitly is the user's choice;
  // show the risk notice in the form rather than requiring a second checkbox.
  const effectiveTlsPolicy = base.protocol === 'https:' ? tlsPolicy : 'strict';
  if (!name.trim()) throw new Error('环境名称不能为空');
  return {
    name: name.trim(),
    baseUrl: base.toString(),
    allowedOrigins: [
      base.origin,
      ...new Set(normalizedOrigins.filter((origin) => origin !== base.origin)),
    ],
    excludedPaths: [...new Set(excludedPaths)],
    tlsPolicy: effectiveTlsPolicy,
  };
}
