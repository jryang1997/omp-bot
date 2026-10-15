// <omp-mascot>：OpenMausBot 吉祥物的原生自定义元素版本。
// 属性：body（10 种身体）、color（10 种颜色）、state（运行状态）、expression（固定表情序号）、size（像素）、
// paused（静止）、label（无障碍名）。所有实例共用一个 requestAnimationFrame，看不见的实例不画。
import {
  EXPRESSIONS, MOUTHS, GAZE, GAZE_TRAVEL, EXPRESSION_COUNT, MOUTH_STROKE, mouthFrame,
  POOLS, MOTION, CURSOR_STATES, updateEffects, bodyTransform, anchorTransform, mouthPath,
  displayed, displayedMouth, displayedGaze, blinkScale, clone, toPath, ringCentre, clamp,
  VIEW_BOX, SPHERE_C, SPHERE_R, EXPR_CADENCE, BLINK, FACE_BOX,
} from './upstream/engine';
import { MASCOT_BODIES, MASCOT_BODY_IDS, botMascotBody } from './upstream/mascot-bodies';

export { MASCOT_BODY_IDS, CURSOR_STATES };
export const MASCOT_COLORS = {
  green: '#009957', blue: '#377FE6', red: '#D94B52', orange: '#E78531', purple: '#8057C8',
  cyan: '#0EA5C6', pink: '#D84F8B', yellow: '#D8A729', teal: '#01A492', coral: '#E5634E',
} as const;
export const MASCOT_COLOR_IDS = Object.keys(MASCOT_COLORS) as (keyof typeof MASCOT_COLORS)[];

function mix(hex: string, toward: string, t: number) {
  const a = parseInt(hex.slice(1), 16), b = parseInt(toward.slice(1), 16);
  const ch = (s: number) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * t));
  return '#' + [ch(16), ch(8), ch(0)].map(v => v.toString(16).padStart(2, '0')).join('');
}
export function gradientOf(color: string): [string, string, string] {
  const fill = (MASCOT_COLORS as Record<string, string>)[color] ?? (/^#[0-9a-f]{6}$/i.test(color) ? color : MASCOT_COLORS.green);
  return [mix(fill, '#ffffff', 0.55), fill, mix(fill, '#000000', 0.42)];
}

const NS = 'http://www.w3.org/2000/svg';
const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
let serial = 0;

// 共用调度：一帧里依次画所有可见、未暂停的实例。
const live = new Set<OmpMascot>();
let frame = 0;
function loop(now: number) {
  frame = 0;
  for (const m of live) m.step(now);
  if (live.size) frame = requestAnimationFrame(loop);
}
function wake(m: OmpMascot) { live.add(m); if (!frame) frame = requestAnimationFrame(loop); }
function sleep(m: OmpMascot) { live.delete(m); }
const seen = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => { for (const e of entries) (e.target as OmpMascot).setVisible(e.isIntersecting); })
  : null;

type State = keyof typeof POOLS;

export class OmpMascot extends HTMLElement {
  static observedAttributes = ['body', 'color', 'state', 'expression', 'size', 'paused', 'label', 'fps'];
  #lastDraw = 0;
  #uid = `m${++serial}`;
  #svg?: SVGSVGElement;
  #parts: Record<string, SVGElement> = {};
  #visible = !seen;
  #timers: ReturnType<typeof setTimeout>[] = [];
  #e = {
    current: clone(EXPRESSIONS[0]), target: EXPRESSIONS[0],
    currentMouth: MOUTHS[0].slice(), targetMouth: MOUTHS[0],
    currentGaze: [...GAZE[0]], targetGaze: [...GAZE[0]],
    expression: 0, morph: 1, velocity: 0,
    blinkStart: null as number | null, spinStart: null as number | null, spinDuration: 900,
    last: 0, stateStart: 0, lastState: 'idle' as State, lastBodyTransform: '', still: '',
  };

  get state(): State { const s = this.getAttribute('state') as State; return s && s in POOLS ? s : 'idle'; }
  get #fixed() { const v = this.getAttribute('expression'); return v === null ? undefined : Number(v); }
  get #paused() { return this.hasAttribute('paused'); }
  get #strength() { return reduceMotion?.matches ? 0 : 1; }

  connectedCallback() {
    if (!this.#svg) this.#render();
    seen?.observe(this);
    this.#select(this.#fixed ?? POOLS[this.state][0]);
    this.#schedule();
    this.#e.last = performance.now();
    this.#refresh();
  }
  disconnectedCallback() { seen?.unobserve(this); sleep(this); this.#clearTimers(); }
  attributeChangedCallback(name: string, old: string | null, value: string | null) {
    if (!this.#svg || old === value) return;
    if (name === 'body' || name === 'color' || name === 'label') { this.#render(); return; }
    if (name === 'size') { this.#applySize(); return; }
    if (name === 'state' || name === 'expression') this.#select(this.#fixed ?? POOLS[this.state][0]);
    this.#schedule();
    this.#refresh();
  }
  setVisible(v: boolean) { this.#visible = v; this.#refresh(); }
  blink() { this.#e.blinkStart = performance.now(); this.#refresh(); }
  spin(ms = 900) { this.#e.spinDuration = ms; this.#e.spinStart = performance.now(); this.#refresh(); }

  #refresh() {
    if (!this.isConnected) return;
    if (this.#visible) { wake(this); } else sleep(this);
  }
  #applySize() {
    const size = this.getAttribute('size') ?? '36';
    const dim = /^\d+(\.\d+)?$/.test(size) ? `${size}px` : size;
    this.#svg!.setAttribute('width', dim); this.#svg!.setAttribute('height', dim);
  }
  #render() {
    const body = MASCOT_BODIES[botMascotBody(this.getAttribute('body'))];
    const grad = gradientOf(this.getAttribute('color') ?? 'green');
    const label = this.getAttribute('label');
    const id = this.#uid, paint = `url(#${id}-grad)`;
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>:host{display:inline-block;line-height:0}svg{display:block;overflow:visible}</style>
<svg viewBox="${VIEW_BOX}" xmlns="${NS}" ${label ? `role="img" aria-label="${label.replace(/[<&"]/g, '')}"` : 'aria-hidden="true"'}>
<defs><linearGradient id="${id}-grad" x1="1" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${grad[0]}"/><stop offset="55%" stop-color="${grad[1]}"/><stop offset="100%" stop-color="${grad[2]}"/></linearGradient>
<clipPath id="${id}-clip" transform="${body.fit}">${body.clip}</clipPath></defs>
<g><g data-p="trails"></g><g data-p="body"><g data-p="content"><g transform="${body.fit}">${body.body.replace(/\{\{GRADIENT\}\}/g, paint)}</g>
<g clip-path="url(#${id}-clip)"><g transform="${anchorTransform(body.anchor)}"><path data-p="eye0" fill="#ffffff"/><path data-p="eye1" fill="#ffffff"/>
<path data-p="mouth" fill="none" stroke="#ffffff" stroke-width="${MOUTH_STROKE}" stroke-linecap="round"/></g></g></g>
<g data-p="glyph" style="opacity:0"></g></g><g data-p="confetti"></g></g></svg>`;
    this.#svg = root.querySelector('svg')!;
    this.#parts = Object.fromEntries([...root.querySelectorAll('[data-p]')].map(n => [n.getAttribute('data-p')!, n as SVGElement]));
    this.#paint = paint;
    this.#e.lastBodyTransform = ''; this.#e.still = '';
    this.#applySize();
  }
  #paint = '';

  #select(index: number) {
    const e = this.#e;
    const i = ((index % EXPRESSION_COUNT) + EXPRESSION_COUNT) % EXPRESSION_COUNT;
    if (i === e.expression && e.morph >= 1) return;
    e.current = displayed(e); e.currentMouth = displayedMouth(e); e.currentGaze = displayedGaze(e);
    e.target = EXPRESSIONS[i]; e.targetMouth = MOUTHS[i]; e.targetGaze = GAZE[i];
    e.expression = i; e.morph = 0; e.velocity = 0;
  }
  #clearTimers() { this.#timers.forEach(clearTimeout); this.#timers = []; }
  // 与上游相同的节奏：按状态换表情、眨眼。
  #schedule() {
    this.#clearTimers();
    if (this.#paused || !this.isConnected) return;
    const state = this.state;
    if (this.#fixed === undefined) {
      const tick = () => {
        const [lo, hi] = EXPR_CADENCE[state];
        this.#timers[0] = setTimeout(() => {
          const pool = POOLS[state];
          const alt = pool.filter((x: number) => x !== this.#e.expression);
          this.#select(alt.length ? alt[Math.floor(Math.random() * alt.length)] : pool[0]);
          this.#refresh(); tick();
        }, lo + Math.random() * (hi - lo));
      };
      tick();
    }
    const cadence = BLINK[state];
    if (cadence) {
      const tick = () => {
        this.#timers[1] = setTimeout(() => { this.#e.blinkStart = performance.now(); this.#refresh(); tick(); },
          cadence[0] + Math.random() * (cadence[1] - cadence[0]));
      };
      tick();
    }
  }

  step(now: number) {
    const e = this.#e;
    // fps 属性给小尺寸降帧，例如侧边栏 30 帧。弹簧仍按真实时间推进，降帧只少画。
    const fps = Number(this.getAttribute('fps') ?? 60);
    if (fps < 60 && now - this.#lastDraw < 1000 / fps - 4) return;
    this.#lastDraw = now;
    if (this.#paused) {
      e.last = now;
      const still = `${this.state}|${this.#fixed ?? ''}`;
      if (e.still !== still) { e.still = still; e.morph = 1; e.velocity = 0; this.#draw(now, 0); }
      sleep(this);
      return;
    }
    e.still = '';
    const dt = Math.min((now - e.last) / 1000, 0.1);
    e.last = now;
    const f = 7;
    e.velocity += (-2 * f * e.velocity - f * f * (e.morph - 1)) * dt;
    e.morph += e.velocity * dt;
    if (!Number.isFinite(e.morph)) { e.morph = 1; e.velocity = 0; }
    let spinTurn = 0;
    if (e.spinStart !== null) {
      const t = (now - e.spinStart) / e.spinDuration;
      if (t >= 1) e.spinStart = null; else spinTurn = 360 * t;
    }
    this.#draw(now, spinTurn);
    // 表情已经停稳、身体不动、没有特效时，停下这一实例，等计时器再叫醒。
    const motion = MOTION[this.state];
    const resting = Math.abs(e.morph - 1) < 1e-3 && Math.abs(e.velocity) < 1e-3 && e.blinkStart === null && e.spinStart === null;
    const animated = this.#strength > 0 && (motion && Object.keys(motion).length > 0);
    if (resting && !animated && !hasEffects(this.state)) sleep(this);
  }

  #draw(now: number, spinTurn: number) {
    const e = this.#e, p = this.#parts;
    const g = displayedGaze(e), look = 0.5;
    const ox = g[0] * look, oy = g[1] * look;
    const rings = displayed(e).map((ring: [number, number][]) => ring.map((pt): [number, number] => [pt[0] + ox, pt[1] + oy]));
    const gx = 0 * GAZE_TRAVEL.x, gy = 0 * GAZE_TRAVEL.y;
    const radians = (spinTurn * Math.PI) / 180;
    const blink = blinkScale(e, now);
    rings.forEach((ring: [number, number][], i: number) => {
      const el = i === 0 ? p.eye0 : p.eye1;
      const c = ringCentre(ring);
      const base = Math.asin(clamp((c[0] - SPHERE_C) / SPHERE_R, -1, 1));
      const lon = base + radians, depth = Math.cos(lon);
      const persp = Math.max(depth, 0.02) / Math.max(Math.cos(base), 0.02);
      el.setAttribute('d', toPath(ring));
      el.setAttribute('transform', `translate(${(SPHERE_C + SPHERE_R * Math.sin(lon) + gx).toFixed(2)} ${(c[1] + gy).toFixed(2)}) scale(${clamp(persp, 0.02, 2.4).toFixed(4)} ${clamp(blink, 0.02, 2.4).toFixed(4)}) translate(${(-c[0]).toFixed(2)} ${(-c[1]).toFixed(2)})`);
      el.style.opacity = depth > 0.02 ? '1' : '0';
    });
    const spec = displayedMouth(e), fg = mouthFrame(rings, spec);
    const base = Math.asin(clamp((fg.x - SPHERE_C) / SPHERE_R, -1, 1));
    const lon = base + radians, depth = Math.cos(lon);
    const persp = Math.max(depth, 0.02) / Math.max(Math.cos(base), 0.02);
    p.mouth.setAttribute('d', mouthPath(fg, spec));
    p.mouth.setAttribute('transform', `translate(${(SPHERE_C + SPHERE_R * Math.sin(lon) + gx).toFixed(2)} ${(fg.y + gy).toFixed(2)}) scale(${clamp(persp, 0.02, 2.4).toFixed(4)} 1) translate(${(-fg.x).toFixed(2)} ${(-fg.y).toFixed(2)})`);
    p.mouth.style.opacity = depth > 0.02 ? '1' : '0';
    const state = this.state;
    if (state !== e.lastState) { e.lastState = state; e.stateStart = now; }
    const t = bodyTransform(MOTION[state] ?? {}, now - e.stateStart, this.#strength);
    if (t !== e.lastBodyTransform) { e.lastBodyTransform = t; t ? p.body.setAttribute('transform', t) : p.body.removeAttribute('transform'); }
    updateEffects({ trails: p.trails, confetti: p.confetti, glyph: p.glyph, bodyContent: p.content, state, elapsed: now - e.stateStart, strength: this.#strength, paint: this.#paint, showEffects: true, showGlyphs: true } as never);
  }
}

import { EFFECTS } from './upstream/engine';
const hasEffects = (s: string) => !!(EFFECTS as Record<string, unknown>)[s];

if (!customElements.get('omp-mascot')) customElements.define('omp-mascot', OmpMascot);
void FACE_BOX;
