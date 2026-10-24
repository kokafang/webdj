/** @param {number} position @param {number} count */
export function clampPosition(position, count) {
  return Math.max(0, Math.min(Math.max(0, count - 1), Number.isFinite(position) ? position : 0));
}
/** @param {number} x @param {number} width @param {number} [maximum] */
export function edgeVelocity(x, width, maximum = 6) {
  if (!(width > 0)) return 0;
  const ratio = Math.max(0, Math.min(1, x / width));
  if (ratio < 0.35) return -maximum * ((0.35 - ratio) / 0.35);
  if (ratio > 0.65) return maximum * ((ratio - 0.65) / 0.35);
  return 0;
}
/** @param {number} dx @param {number} dy */
export function dragIntent(dx, dy) {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return 'pending';
  return Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
}
/** @param {number} start @param {number} dx @param {number} spacing @param {number} count */
export function dragPosition(start, dx, spacing, count) {
  return clampPosition(start - dx / Math.max(1, spacing), count);
}
/** @param {number} position @param {number} count */
export function snapPosition(position, count) {
  return Math.round(clampPosition(position, count));
}
