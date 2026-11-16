const trim = (n) => String(parseFloat(n.toFixed(1)));


export function fmtBinary(bytes) {
  if (bytes == null) return null;
  const gib = bytes / 2 ** 30;
  if (gib >= 1024) return `${trim(gib / 1024)} TB`;
  if (gib >= 1) return `${trim(gib)} GB`;
  return `${trim(bytes / 2 ** 20)} MB`;
}


export function fmtDecimal(bytes) {
  if (bytes == null) return null;
  const gb = bytes / 1e9;
  if (gb >= 950) return `${trim(gb / 1000)} TB`;
  if (gb >= 1) return `${Math.round(gb)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}
