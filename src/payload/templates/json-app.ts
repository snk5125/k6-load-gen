export type Template = (
  fields: Record<string, string>,
  seq: number,
) => { severity: string; body: string };

/** Structured JSON application log — the common shape for modern services. */
export const jsonApp: Template = (fields, seq) => {
  const severity = fields.level ?? 'INFO';
  return {
    severity,
    body: JSON.stringify({ ...fields, seq }),
  };
};
