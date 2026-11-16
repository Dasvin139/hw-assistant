export function cleanString(value, max = 200) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function deepClean(value, max = 400) {
  if (typeof value === 'string') return cleanString(value, max);
  if (Array.isArray(value)) return value.map((v) => deepClean(v, max));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClean(v, max)]));
  }
  return value;
}
