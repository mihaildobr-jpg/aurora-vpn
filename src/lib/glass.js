// «Жидкое стекло»: для каждой панели строим SVG-фильтр с картой смещения ровно под её размер.
// Карта нейтральна в центре и плавно нарастает к краям — фон (сетка) у кромки изгибается, как в линзе.
// backdrop-filter: url(...) работает в Chromium/WebView2; в других движках остаётся обычное размытие.

const SVG_NS = 'http://www.w3.org/2000/svg';
const EDGE = 26; // ширина «линзы» у края, px
const STRENGTH = 34; // сила преломления, px

let seq = 0;

function buildMap(w, h, radius) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Расстояние до ближайшей кромки скруглённого прямоугольника и направление от центра.
      const qx = Math.max(Math.abs(x + 0.5 - w / 2) - (w / 2 - radius), 0);
      const qy = Math.max(Math.abs(y + 0.5 - h / 2) - (h / 2 - radius), 0);
      const inner = Math.min(Math.max(Math.abs(x + 0.5 - w / 2) - (w / 2 - radius), Math.abs(y + 0.5 - h / 2) - (h / 2 - radius)), 0);
      const dist = radius - (Math.hypot(qx, qy) + inner); // 0 на кромке, растёт внутрь
      const t = Math.max(0, 1 - dist / EDGE);
      const k = t * t * (3 - 2 * t); // плавный спуск к нулю
      const nx = (x + 0.5 - w / 2) / (w / 2);
      const ny = (y + 0.5 - h / 2) / (h / 2);
      const len = Math.hypot(nx, ny) || 1;
      const i = (y * w + x) * 4;
      d[i] = 128 - (nx / len) * k * 127;
      d[i + 1] = 128 - (ny / len) * k * 127;
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

function apply(el, defs) {
  const w = Math.round(el.offsetWidth);
  const h = Math.round(el.offsetHeight);
  if (!w || !h) return;
  if (el._glass && el._glass.w === w && el._glass.h === h) return;
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  const id = el._glass?.id || `glass-${++seq}`;
  defs.querySelector(`#${id}`)?.remove();

  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', id);
  filter.setAttribute('filterUnits', 'userSpaceOnUse');
  filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  for (const [k, v] of [['x', 0], ['y', 0], ['width', w], ['height', h]]) filter.setAttribute(k, v);
  const image = document.createElementNS(SVG_NS, 'feImage');
  for (const [k, v] of [['x', 0], ['y', 0], ['width', w], ['height', h], ['result', 'map'], ['preserveAspectRatio', 'none']]) image.setAttribute(k, v);
  image.setAttribute('href', buildMap(w, h, radius));
  const disp = document.createElementNS(SVG_NS, 'feDisplacementMap');
  for (const [k, v] of [['in', 'SourceGraphic'], ['in2', 'map'], ['scale', STRENGTH], ['xChannelSelector', 'R'], ['yChannelSelector', 'G']]) disp.setAttribute(k, v);
  filter.append(image, disp);
  defs.append(filter);

  const blur = el.classList.contains('modal-box') ? 24 : 7;
  const value = `url(#${id}) blur(${blur}px) saturate(140%)`;
  el.style.backdropFilter = value;
  el.style.webkitBackdropFilter = value;
  el._glass = { id, w, h };
}

export function initGlass(selector) {
  const defs = document.getElementById('glass-defs');
  if (!defs || !/Chrome\//.test(navigator.userAgent)) return; // url() в backdrop-filter есть только в Chromium/WebView2
  const ro = new ResizeObserver((entries) => entries.forEach((e) => apply(e.target, defs)));
  const watch = () => document.querySelectorAll(selector).forEach((el) => {
    if (!el._glassWatched) { el._glassWatched = true; ro.observe(el); }
  });
  watch();
  // Модальные окна и новые карточки появляются позже.
  new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
}
