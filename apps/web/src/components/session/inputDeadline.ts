/** Deadline label for the coordinator's question: "10月17日 14:05", or
 * just "14:05" when it is today. Returns '' when expiresAt is missing or
 * unparsable (older servers omit it), so the UI never invents a duration. */
export const inputRequestDeadlineLabel = (
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): string => {
  if (!expiresAt) return '';
  const deadline = new Date(expiresAt);
  if (!Number.isFinite(deadline.getTime())) return '';
  const time = deadline.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const sameDay =
    deadline.getFullYear() === now.getFullYear() &&
    deadline.getMonth() === now.getMonth() &&
    deadline.getDate() === now.getDate();
  return sameDay
    ? time
    : `${deadline.getMonth() + 1}月${deadline.getDate()}日 ${time}`;
};
