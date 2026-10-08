export const MAX_YAML_BYTES = 262144; // 256 KiB in UTF-8
export const MAX_YAML_CHARS = 262144; // Max characters in DTO
export const SLUG_REGEX = /^[a-zA-Z0-9_.-]+$/;

export interface YamlImportInput {
  slug: string;
  name: string;
  yaml: string;
}

export interface YamlImportValidationResult {
  valid: boolean;
  errors: {
    slug?: string;
    name?: string;
    yaml?: string;
  };
  byteLength: number;
  charLength: number;
  isByteOverLimit: boolean;
  isCharOverLimit: boolean;
}

export function getUtf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function validateYamlImportInput(
  input: YamlImportInput,
): YamlImportValidationResult {
  const errors: { slug?: string; name?: string; yaml?: string } = {};
  const trimmedSlug = (input.slug || '').trim();
  const trimmedName = (input.name || '').trim();
  const yamlText = input.yaml || '';

  if (!trimmedSlug) {
    errors.slug = '请输入用例标识 (Slug)';
  } else if (trimmedSlug.length > 120) {
    errors.slug = '用例标识不能超过 120 个字符';
  } else if (!SLUG_REGEX.test(trimmedSlug)) {
    errors.slug =
      '用例标识仅支持英文、数字、下划线、中划线和句点 (^[a-zA-Z0-9_.-]+$)';
  }

  if (!trimmedName) {
    errors.name = '请输入用例名称';
  } else if (trimmedName.length > 200) {
    errors.name = '用例名称不能超过 200 个字符';
  }

  const byteLength = getUtf8ByteLength(yamlText);
  const charLength = yamlText.length;
  const isByteOverLimit = byteLength > MAX_YAML_BYTES;
  const isCharOverLimit = charLength > MAX_YAML_CHARS;

  if (!yamlText.trim()) {
    errors.yaml = '请输入或上传 YAML 测试用例文本';
  } else if (isByteOverLimit) {
    errors.yaml = `YAML 内容超出 256 KiB (262,144 字节) 限制 (当前 ${byteLength.toLocaleString()} 字节)`;
  } else if (isCharOverLimit) {
    errors.yaml = `YAML 内容超出最大 262,144 字符限制 (当前 ${charLength.toLocaleString()} 字符)`;
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    byteLength,
    charLength,
    isByteOverLimit,
    isCharOverLimit,
  };
}
