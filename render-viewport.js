export const MAX_RENDER_PIXEL_RATIO = 1.75;

export function stablePixelRatio(value) {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio > 0 ? Math.min(ratio, MAX_RENDER_PIXEL_RATIO) : 1;
}

export function renderViewport(width, height, pixelRatio) {
  const w = Number(width), h = Number(height);
  // Hidden/transiently unmeasured canvases retain the last good framebuffer.
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
  const cssWidth = Math.round(w), cssHeight = Math.round(h);
  const ratio = stablePixelRatio(pixelRatio);
  return { cssWidth, cssHeight, pixelRatio: ratio, pixelWidth: Math.max(1, Math.floor(cssWidth * ratio)), pixelHeight: Math.max(1, Math.floor(cssHeight * ratio)) };
}

export function sameViewport(a, b) {
  return !!a && !!b && a.cssWidth === b.cssWidth && a.cssHeight === b.cssHeight && a.pixelWidth === b.pixelWidth && a.pixelHeight === b.pixelHeight;
}

export function viewportChange(current, desired, interactionActive = false) {
  if (!desired) return 'empty';
  if (sameViewport(current, desired)) return 'unchanged';
  if (current && interactionActive) return 'defer';
  return 'apply';
}

export function viewportDiagnostics() {
  return { requests: 0, applied: 0, skipped: 0, coalesced: 0, deferredFrames: 0, contextLost: 0, contextRestored: 0, frames: 0 };
}
