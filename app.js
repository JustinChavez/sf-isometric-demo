const viewport = document.querySelector('#map-viewport');
const stage = document.querySelector('#map-stage');
const statusLabel = document.querySelector('#map-status');
const dimensions = document.querySelector('#map-dimensions');
const lightbox = document.querySelector('#lightbox');
const lightboxImage = document.querySelector('#lightbox-image');
const lightboxCaption = document.querySelector('#lightbox-caption');
const markerButtons = [...document.querySelectorAll('.map-marker')];
const placeButtons = [...document.querySelectorAll('.place-button')];

const QUAD = 512;
const MIN_SCALE = 0.05;
const MAX_SCALE = 3;
const DRAG_SLOP = 4;
// Real-world positions of the landmarks inside the 5632 x 4608 px mosaic
// (derived from the tile plan's lat/lon grid).
const LANDMARKS = {
  coit: { x: 5376, y: 2304 },
  washington: { x: 3328, y: 2816 }
};

const quadrants = new Map();
let mapWidth = 0;
let mapHeight = 0;
let scale = 1;
let fittedScale = 1;
let offsetX = 0;
let offsetY = 0;
let userZoomed = false;
let animationTimer = null;
let activePointerId = null;
let dragMoved = false;
let dragStartX = 0;
let dragStartY = 0;
let startOffsetX = 0;
let startOffsetY = 0;

function clampOffsets() {
  const width = mapWidth * scale;
  const height = mapHeight * scale;
  const viewWidth = viewport.clientWidth;
  const viewHeight = viewport.clientHeight;

  // The map always covers the viewport when it is larger than it; when smaller,
  // it stays centered.
  offsetX = width <= viewWidth ? (viewWidth - width) / 2
    : Math.min(0, Math.max(viewWidth - width, offsetX));
  offsetY = height <= viewHeight ? (viewHeight - height) / 2
    : Math.min(0, Math.max(viewHeight - height, offsetY));
}

function updateMarkerPositions() {
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  markerButtons.forEach((marker) => {
    const x = Number(marker.dataset.mapX);
    const y = Number(marker.dataset.mapY);
    let left = offsetX + x * scale;
    let top = offsetY + y * scale;
    // Keep the label pill fully inside the map frame at every zoom.
    const w = marker.offsetWidth || 0;
    const h = marker.offsetHeight || 0;
    left = Math.min(Math.max(left, w / 2 + 4), Math.max(w / 2 + 4, vw - w / 2 - 4));
    top = Math.min(Math.max(top, h + 2), Math.max(h + 2, vh - 6));
    marker.style.left = `${left}px`;
    marker.style.top = `${top}px`;
  });
}

function applyTransform() {
  clampOffsets();
  stage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  updateMarkerPositions();
}

function animateTransform() {
  clearTimeout(animationTimer);
  viewport.classList.add('is-animating');
  applyTransform();
  animationTimer = setTimeout(() => viewport.classList.remove('is-animating'), 500);
}

function setActivePlace(name) {
  placeButtons.forEach((button) => {
    const active = name === 'overview'
      ? button.dataset.mapAction === 'fit'
      : button.dataset.mapLandmark === name;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  markerButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.mapLandmark === name);
  });
}

function fitMap(animate = false) {
  if (!mapWidth || !mapHeight) return;
  const pad = viewport.clientWidth < 560 ? 16 : 28;
  fittedScale = Math.min(
    (viewport.clientWidth - pad) / mapWidth,
    (viewport.clientHeight - pad) / mapHeight
  );
  scale = Math.min(Math.max(fittedScale, MIN_SCALE), MAX_SCALE);
  offsetX = (viewport.clientWidth - mapWidth * scale) / 2;
  offsetY = (viewport.clientHeight - mapHeight * scale) / 2;
  userZoomed = false;
  setActivePlace('overview');
  if (animate) animateTransform();
  else applyTransform();
}

function focusLandmark(name) {
  const landmark = LANDMARKS[name];
  if (!landmark || !mapWidth) return;
  scale = Math.min(Math.max(fittedScale * 3.2, 0.4), 0.72);
  // Center on the landmark; clampOffsets keeps the map covering the viewport.
  offsetX = viewport.clientWidth / 2 - landmark.x * scale;
  offsetY = viewport.clientHeight / 2 - landmark.y * scale;
  userZoomed = true;
  setActivePlace(name);
  animateTransform();
}

function zoomAt(factor, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
  const previous = scale;
  scale = Math.min(Math.max(scale * factor, MIN_SCALE), MAX_SCALE);
  if (scale === previous) return;
  userZoomed = true;
  setActivePlace(null);
  offsetX = anchorX - (anchorX - offsetX) * (scale / previous);
  offsetY = anchorY - (anchorY - offsetY) * (scale / previous);
  applyTransform();
}

function quadrantAt(clientX, clientY) {
  const rect = viewport.getBoundingClientRect();
  const x = (clientX - rect.left - offsetX) / scale;
  const y = (clientY - rect.top - offsetY) / scale;
  if (x < 0 || y < 0 || x >= mapWidth || y >= mapHeight) return null;
  return quadrants.get(`${Math.floor(x / QUAD)}_${Math.floor(y / QUAD)}`) || null;
}

function openLightbox(src, caption) {
  lightboxImage.src = src;
  lightboxImage.alt = caption;
  lightboxCaption.textContent = caption;
  if (typeof lightbox.showModal === 'function') lightbox.showModal();
  else lightbox.setAttribute('open', '');
}

fetch('map/manifest.json')
  .then((response) => {
    if (!response.ok) throw new Error(`Manifest request failed: ${response.status}`);
    return response.json();
  })
  .then((manifest) => {
    const bounds = manifest.bounds;
    mapWidth = (bounds.qx_max + 1) * QUAD;
    mapHeight = (bounds.qy_max + 1) * QUAD;
    stage.style.width = `${mapWidth}px`;
    stage.style.height = `${mapHeight}px`;

    manifest.quadrants.forEach((quadrant) => {
      const caption = `Map quadrant ${quadrant.qx}, ${quadrant.qy} · source tile ${quadrant.src}`;
      const image = document.createElement('img');
      image.className = 'quadrant';
      image.src = `map/${quadrant.url}`;
      image.alt = caption;
      image.draggable = false;
      image.style.left = `${quadrant.qx * QUAD}px`;
      image.style.top = `${quadrant.qy * QUAD}px`;
      stage.appendChild(image);
      quadrants.set(`${quadrant.qx}_${quadrant.qy}`, { src: image.src, caption });
    });

    if (statusLabel) statusLabel.textContent = `${manifest.tiles} tiles · ${manifest.count} mosaic pieces`;
    if (dimensions) dimensions.textContent = `${mapWidth} × ${mapHeight} px mosaic`;
    requestAnimationFrame(() => fitMap(false));
  })
  .catch((error) => {
    if (statusLabel) statusLabel.textContent = 'Map unavailable';
    console.error(error);
  });

function endDrag(event, allowInspect) {
  if (activePointerId === null) return;
  if (event && event.pointerId !== activePointerId) return;

  if (allowInspect && !dragMoved && event) {
    const quadrant = quadrantAt(event.clientX, event.clientY);
    if (quadrant) openLightbox(quadrant.src, quadrant.caption);
  }

  if (event && viewport.hasPointerCapture?.(event.pointerId)) {
    try {
      viewport.releasePointerCapture(event.pointerId);
    } catch {
      // Synthetic events may not support pointer capture.
    }
  }

  activePointerId = null;
  dragMoved = false;
  viewport.classList.remove('is-dragging');
}

viewport.addEventListener('pointerdown', (event) => {
  if (event.target.closest('button')) return;
  if (event.button > 0 || activePointerId !== null) return;
  event.preventDefault();
  clearTimeout(animationTimer);
  viewport.classList.remove('is-animating');
  activePointerId = event.pointerId;
  dragMoved = false;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  startOffsetX = offsetX;
  startOffsetY = offsetY;
  viewport.classList.add('is-dragging');
  try {
    viewport.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is optional; move events still bubble.
  }
});

viewport.addEventListener('pointermove', (event) => {
  if (event.pointerId !== activePointerId) return;
  event.preventDefault();
  const dx = event.clientX - dragStartX;
  const dy = event.clientY - dragStartY;
  if (!dragMoved && Math.hypot(dx, dy) > DRAG_SLOP) dragMoved = true;
  if (!dragMoved) return;
  setActivePlace(null);
  offsetX = startOffsetX + dx;
  offsetY = startOffsetY + dy;
  applyTransform();
});

viewport.addEventListener('pointerup', (event) => endDrag(event, true));
viewport.addEventListener('pointercancel', (event) => endDrag(event, false));
viewport.addEventListener('lostpointercapture', (event) => endDrag(event, false));
viewport.addEventListener('dragstart', (event) => event.preventDefault());
window.addEventListener('blur', () => endDrag(null, false));

viewport.addEventListener('wheel', (event) => {
  event.preventDefault();
  const rect = viewport.getBoundingClientRect();
  zoomAt(
    event.deltaY < 0 ? 1.12 : 0.89,
    event.clientX - rect.left,
    event.clientY - rect.top
  );
}, { passive: false });

document.querySelectorAll('[data-map-action]').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.mapAction === 'fit') fitMap(true);
    if (button.dataset.mapAction === 'in') zoomAt(1.2);
    if (button.dataset.mapAction === 'out') zoomAt(0.83);
  });
});

document.querySelectorAll('[data-map-landmark]').forEach((button) => {
  button.addEventListener('click', () => focusLandmark(button.dataset.mapLandmark));
});

window.addEventListener('resize', () => {
  if (userZoomed) applyTransform();
  else fitMap(false);
});

document.querySelector('#lightbox-close').addEventListener('click', () => lightbox.close());
lightbox.addEventListener('click', (event) => {
  if (event.target === lightbox) lightbox.close();
});
