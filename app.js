/* SF Isometric — map viewer.
 * A pan/zoom view over a grid of 512px mosaic quadrants, lazily fetched.
 *
 * Two things this does that the earlier downtown viewer did not need to:
 *  1. the mosaic does NOT start at quadrant 0, so every position is computed
 *     relative to the manifest's bounds (qx_min / qy_min), not from zero.
 *  2. there are ~1,300 quadrants, so images are attached only when they come
 *     near the viewport. Attaching them all up front would fetch ~30 MB before
 *     the first pixel appears.
 */
const viewport = document.querySelector('#map-viewport');
const stage = document.querySelector('#map-stage');
const readout = document.querySelector('#map-readout');
const lightbox = document.querySelector('#lightbox');
const lightboxImage = document.querySelector('#lightbox-image');
const lightboxCaption = document.querySelector('#lightbox-caption');

const QUAD = 512;
const MAX_SCALE = 4;
const MIN_ABS_SCALE = 0.002;   // a safety floor only; fit can go below a naive constant
const DRAG_SLOP = 4;           // px of movement before a press counts as a drag
const PRELOAD_MARGIN = 2;      // quadrants to preload beyond the viewport, each side
// Below this zoom the whole strip is on screen and fetching 1,200 full-res pieces to
// render them at a few pixels each would be absurd, so one downscaled overview stands in.
// Above it, quadrants take over and only the visible ones are fetched.
const OVERVIEW_MAX_SCALE = 0.085;

let overviewEl = null;
let usingOverview = null;

const tiles = new Map();       // "qx_qy" -> { el, url, caption, loaded }
const loadedOrder = [];
const MAX_LOADED = 400;        // drop far-away images so memory stays bounded

let mapWidth = 0, mapHeight = 0, originX = 0, originY = 0;
let scale = 1, fittedScale = 1;
let offsetX = 0, offsetY = 0;
let activePointerId = null, dragMoved = false;
let dragStartX = 0, dragStartY = 0, startOffsetX = 0, startOffsetY = 0;
let lastDragAt = 0;
let animationTimer = null;

function clampOffsets() {
  const w = mapWidth * scale, h = mapHeight * scale;
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  // cover the viewport when larger, centre it when smaller — never drift loose
  offsetX = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, offsetX));
  offsetY = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, offsetY));
}

function applyTransform() {
  clampOffsets();
  stage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  // nearest-neighbour only helps when magnifying; see styles.css
  stage.classList.toggle('magnified', scale >= 1);
  syncTiles();
  updateReadout();
}

function animateTransform() {
  clearTimeout(animationTimer);
  viewport.classList.add('is-animating');
  applyTransform();
  animationTimer = setTimeout(() => viewport.classList.remove('is-animating'), 480);
}

/* --- lazy tile management ------------------------------------------------- */

function visibleQuadRange() {
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  const x0 = (-offsetX) / scale, y0 = (-offsetY) / scale;
  const x1 = (vw - offsetX) / scale, y1 = (vh - offsetY) / scale;
  // ABSOLUTE quadrant ids, matching the keys in `tiles`. The mosaic does not start at
  // quadrant 0, so these must be offset by the manifest origin - comparing a
  // map-relative index against an absolute id silently loads the wrong region.
  return {
    qx0: Math.floor(x0 / QUAD) + originX - PRELOAD_MARGIN,
    qx1: Math.floor(x1 / QUAD) + originX + PRELOAD_MARGIN,
    qy0: Math.floor(y0 / QUAD) + originY - PRELOAD_MARGIN,
    qy1: Math.floor(y1 / QUAD) + originY + PRELOAD_MARGIN,
  };
}

function hideAllQuadrants() {
  tiles.forEach((t) => {
    if (t.loaded) { t.el.removeAttribute('src'); t.loaded = false; }
    t.el.style.display = 'none';
  });
  loadedOrder.length = 0;
}

function showQuadrants() {
  tiles.forEach((t) => { t.el.style.display = 'block'; });
}

function syncTiles() {
  if (!tiles.size) return;
  // The overview is ALWAYS the base layer - never hidden. Full-res pieces paint over it
  // as they arrive, so a piece that is still loading (or missing) shows the overview
  // underneath instead of a dark hole. This is what makes the map safe to zoom blind.
  const wantQuadrants = scale >= OVERVIEW_MAX_SCALE;
  if (wantQuadrants !== usingOverview) {
    usingOverview = wantQuadrants;
    if (wantQuadrants) showQuadrants(); else hideAllQuadrants();
  }
  if (!wantQuadrants) return;            // the overview is carrying the view by itself

  const r = visibleQuadRange();
  tiles.forEach((t, key) => {
    const [qx, qy] = key.split('_').map(Number);
    const inRange = qx >= r.qx0 && qx <= r.qx1 && qy >= r.qy0 && qy <= r.qy1;
    if (inRange && !t.loaded) {
      t.el.src = t.url;
      t.loaded = true;
      loadedOrder.push(key);
      evictFarTiles(r);
    }
  });
}

function evictFarTiles(r) {
  // keep memory bounded on a long ribbon: drop the images furthest from view
  if (loadedOrder.length <= MAX_LOADED) return;
  const cx = (r.qx0 + r.qx1) / 2, cy = (r.qy0 + r.qy1) / 2;
  loadedOrder.sort((a, b) => {
    const [ax, ay] = a.split('_').map(Number), [bx, by] = b.split('_').map(Number);
    return (Math.abs(bx - cx) + Math.abs(by - cy)) - (Math.abs(ax - cx) + Math.abs(ay - cy));
  });
  while (loadedOrder.length > MAX_LOADED) {
    const key = loadedOrder.shift();
    const t = tiles.get(key);
    if (t && !inViewport(t.qx, t.qy, r)) { t.el.removeAttribute('src'); t.loaded = false; }
  }
}

function inViewport(qx, qy, r) {
  return qx >= r.qx0 + PRELOAD_MARGIN && qx <= r.qx1 - PRELOAD_MARGIN
      && qy >= r.qy0 + PRELOAD_MARGIN && qy <= r.qy1 - PRELOAD_MARGIN;
}

function updateReadout() {
  if (!readout) return;
  const r = visibleQuadRange();
  const qxMax = Math.round(mapWidth / QUAD) + originX - 1;
  readout.textContent = `zoom ${(scale * 100).toFixed(scale < 0.1 ? 1 : 0)}%`
    + `  ·  columns ${Math.max(r.qx0, originX)}–${Math.min(r.qx1, qxMax)}`;
}

/* --- view control --------------------------------------------------------- */

function fitMap(animate = false) {
  if (!mapWidth || !mapHeight) return;
  const pad = viewport.clientWidth < 560 ? 12 : 24;
  fittedScale = Math.min(
    (viewport.clientWidth - pad) / mapWidth,
    (viewport.clientHeight - pad) / mapHeight
  );
  scale = Math.min(Math.max(fittedScale, MIN_ABS_SCALE), MAX_SCALE);
  offsetX = (viewport.clientWidth - mapWidth * scale) / 2;
  offsetY = (viewport.clientHeight - mapHeight * scale) / 2;
  if (animate) animateTransform(); else applyTransform();
}

// The strip is 9.45:1 and a window is ~1.7:1, so "fit everything" shrinks it to a ribbon
// occupying a fifth of the height - which reads as a blurry thumbnail. Filling the height
// instead shows the full 2.4 km width at ~5x the zoom, and panning covers the length.
function fitHeight(animate = false) {
  if (!mapWidth || !mapHeight) return;
  scale = Math.min(Math.max(viewport.clientHeight / mapHeight, MIN_ABS_SCALE), MAX_SCALE);
  offsetX = Math.min(0, Math.max(viewport.clientWidth - mapWidth * scale,
                                 -((mapWidth * scale - viewport.clientWidth) / 2)));
  offsetY = (viewport.clientHeight - mapHeight * scale) / 2;
  if (animate) animateTransform(); else applyTransform();
}

function zoomAt(factor, ax, ay) {
  if (ax === undefined) { ax = viewport.clientWidth / 2; ay = viewport.clientHeight / 2; }
  const prev = scale;
  scale = Math.min(Math.max(scale * factor, MIN_ABS_SCALE), MAX_SCALE);
  if (scale === prev) return;
  offsetX = ax - (ax - offsetX) * (scale / prev);
  offsetY = ay - (ay - offsetY) * (scale / prev);
  applyTransform();
}

function zoomToFitWidth() {
  if (!mapWidth) return;
  scale = Math.min(Math.max((viewport.clientWidth - 24) / mapWidth, MIN_ABS_SCALE), MAX_SCALE);
  offsetX = 0;
  offsetY = (viewport.clientHeight - mapHeight * scale) / 2;
  animateTransform();
}

function realScale() {
  // 512px of quadrant == 0.5 tile step; one tile step covers ~100 m, so one
  // quadrant is ~100 m of ground across. Used only for the readout.
  return (0.1002 * QUAD) / scale;
}

function quadrantAt(clientX, clientY) {
  const rect = viewport.getBoundingClientRect();
  const x = (clientX - rect.left - offsetX) / scale;
  const y = (clientY - rect.top - offsetY) / scale;
  if (x < 0 || y < 0 || x >= mapWidth || y >= mapHeight) return null;
  return tiles.get(`${Math.floor(x / QUAD) + originX}_${Math.floor(y / QUAD) + originY}`) || null;
}

function openLightbox(t) {
  lightboxImage.src = t.url;
  lightboxImage.alt = t.caption;
  lightboxCaption.textContent = t.caption;
  if (typeof lightbox.showModal === 'function') lightbox.showModal();
  else lightbox.setAttribute('open', '');
}

/* --- events --------------------------------------------------------------- */

viewport.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  // The zoom buttons and the social link live inside the viewport. Without this they
  // would be swallowed by the drag handling below (preventDefault on pointerdown).
  if (event.target.closest('a, button, dialog, input')) return;
  event.preventDefault();
  activePointerId = event.pointerId;
  dragStartX = event.clientX; dragStartY = event.clientY;
  startOffsetX = offsetX; startOffsetY = offsetY;
  dragMoved = false;
  try { viewport.setPointerCapture(activePointerId); } catch (_) {}
  viewport.classList.add('is-dragging');
});

viewport.addEventListener('pointermove', (event) => {
  if (event.pointerId !== activePointerId) return;
  const dx = event.clientX - dragStartX, dy = event.clientY - dragStartY;
  if (!dragMoved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
  dragMoved = true;
  offsetX = startOffsetX + dx; offsetY = startOffsetY + dy;
  applyTransform();
});

function endPointer(event) {
  if (event && event.pointerId !== activePointerId) return;
  if (dragMoved) lastDragAt = Date.now();
  try { viewport.releasePointerCapture(activePointerId); } catch (_) {}
  activePointerId = null;
  viewport.classList.remove('is-dragging');
}
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);
viewport.addEventListener('lostpointercapture', endPointer);
window.addEventListener('blur', () => { activePointerId = null; });
window.addEventListener('resize', () => applyTransform());

// a still click inspects the quadrant under the cursor; a drag must not
viewport.addEventListener('click', (event) => {
  if (Date.now() - lastDragAt < 220) return;
  const t = quadrantAt(event.clientX, event.clientY);
  if (t) openLightbox(t);
});

viewport.addEventListener('wheel', (event) => {
  event.preventDefault();
  const rect = viewport.getBoundingClientRect();
  zoomAt(event.deltaY < 0 ? 1.14 : 1 / 1.14, event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });

document.querySelectorAll('[data-map-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.mapAction;
    if (action === 'in') zoomAt(1.5);
    else if (action === 'out') zoomAt(1 / 1.5);
    else if (action === 'fill') fitHeight(true);
    else fitMap(true);
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key === '+' || event.key === '=') zoomAt(1.4);
  else if (event.key === '-' || event.key === '_') zoomAt(1 / 1.4);
  else if (event.key === 'f' || event.key === 'F') fitHeight(true);
  else if (event.key === '0') fitMap(true);
  else if (event.key === 'Escape' && lightbox.open) lightbox.close();
});

/* --- boot ----------------------------------------------------------------- */

fetch('map/manifest.json')
  .then((response) => {
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    return response.json();
  })
  .then((manifest) => {
    const b = manifest.bounds;
    originX = b.qx_min; originY = b.qy_min;
    const cols = b.qx_max - b.qx_min + 1, rows = b.qy_max - b.qy_min + 1;
    mapWidth = cols * QUAD;
    mapHeight = rows * QUAD;
    stage.style.width = `${mapWidth}px`;
    stage.style.height = `${mapHeight}px`;

    manifest.quadrants.forEach((q) => {
      const el = document.createElement('img');
      el.className = 'quadrant';
      el.alt = `Map quadrant ${q.qx}, ${q.qy}`;
      el.draggable = false;
      el.width = QUAD; el.height = QUAD;
      el.style.left = `${(q.qx - originX) * QUAD}px`;
      el.style.top = `${(q.qy - originY) * QUAD}px`;
      el.decoding = 'async';
      el.style.display = 'none';   // hidden until the zoom level calls for full-res pieces
      // NO native loading="lazy": these are absolutely positioned inside a transformed
      // stage, where the browser's viewport heuristic misfires. This script decides.
      const webp = `map/${q.url.replace(/\.png$/, '.webp')}`;
      const png = `map/${q.url}`;
      const data = {
        el, qx: q.qx, qy: q.qy, url: webp, fallback: png,
        caption: `Quadrant ${q.qx}, ${q.qy}${q.src ? ` · source tile ${q.src}` : ''}`,
        loaded: false,
      };
      // a missing .webp (e.g. mid-re-encode) falls back to the .png rather than 404ing
      el.addEventListener('error', () => {
        if (!el.dataset.fellBack && data.url !== png) {
          el.dataset.fellBack = '1';
          data.url = png;
          el.src = png;
        }
      });
      stage.appendChild(el);
      tiles.set(`${q.qx}_${q.qy}`, data);
    });

    const ext = manifest.extent_km
      ? `${manifest.extent_km.north_south} km × ${manifest.extent_km.east_west} km`
      : '';
    const facts = document.querySelector('#map-facts');
    if (facts) facts.textContent = `${manifest.count} quadrants · ${mapWidth} × ${mapHeight} px${ext ? ` · ${ext}` : ''}`;

    // the overview sits under the quadrants and carries every zoomed-out view
    overviewEl = document.createElement('img');
    overviewEl.className = 'overview';
    overviewEl.alt = 'San Francisco, isometric pixel-art map';
    overviewEl.draggable = false;
    overviewEl.width = mapWidth;
    overviewEl.height = mapHeight;
    overviewEl.style.width = `${mapWidth}px`;
    overviewEl.style.height = `${mapHeight}px`;
    overviewEl.src = 'map/overview.webp';
    overviewEl.onerror = () => { overviewEl.src = 'map/overview.png'; };  // fallback
    overviewEl.style.display = 'block';
    stage.appendChild(overviewEl);

    // Opening view, chosen by the owner: 16% framed on the Civic Center with City Hall
    // sitting left of centre. Coordinates come from the tile grid (origin col 26, row 20,
    // 512 px per step); City Hall itself is col 45.3, row 26.1, and the view centre is
    // offset a little past it so the dome lands left of frame.
    const HOME = { x: 11520, y: 3328, scale: 0.16 };
    scale = Math.min(Math.max(HOME.scale, MIN_ABS_SCALE), MAX_SCALE);
    offsetX = viewport.clientWidth / 2 - HOME.x * scale;
    offsetY = viewport.clientHeight / 2 - HOME.y * scale;
    applyTransform();

    // deep link: #z=<scale>&c=<column>&r=<row> centres the view there, so a framing can
    // be linked, and a zoom state can be rendered headlessly for verification
    const m = /z=([\d.]+)(?:&c=(\d+))?(?:&r=(\d+))?/.exec(location.hash);
    if (m) {
      scale = Math.min(Math.max(parseFloat(m[1]), MIN_ABS_SCALE), MAX_SCALE);
      const cx = m[2] !== undefined ? (Number(m[2]) - originX + 0.5) * QUAD : HOME.x;
      const cy = m[3] !== undefined ? (Number(m[3]) - originY + 0.5) * QUAD : HOME.y;
      offsetX = viewport.clientWidth / 2 - cx * scale;
      offsetY = viewport.clientHeight / 2 - cy * scale;
      applyTransform();
    }
  })
  .catch((error) => {
    if (readout) readout.textContent = `could not load the map (${error.message})`;
  });

if (lightbox) {
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) lightbox.close();     // click the backdrop to close
  });
}
