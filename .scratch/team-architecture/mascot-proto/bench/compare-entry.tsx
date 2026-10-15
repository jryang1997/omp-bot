// 逐像素对照：同一身体、同一表情、静止，上游 React 版画在 #react，原生版画在 #native。
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CursorAvatar } from '@oms/components/CursorAvatar';
import { MASCOT_BODIES, MASCOT_BODY_IDS } from '@oms-shared/mascot-bodies';
import '../omp-mascot.js';
const COLORS = ['#009957', '#377FE6', '#D94B52', '#E78531', '#8057C8', '#0EA5C6', '#D84F8B', '#D8A729', '#01A492', '#E5634E'];
const mix = (hex: string, to: string, t: number) => { const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16); const c = (s: number) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * t)); return '#' + [c(16), c(8), c(0)].map(v => v.toString(16).padStart(2, '0')).join(''); };
const grad = (f: string): [string, string, string] => [mix(f, '#ffffff', 0.55), f, mix(f, '#000000', 0.42)];
const names = ['green', 'blue', 'red', 'orange', 'purple', 'cyan', 'pink', 'yellow', 'teal', 'coral'];
createRoot(document.getElementById('react')!).render(<>{MASCOT_BODY_IDS.map((id, i) => {
  const { id: _x, ...silhouette } = MASCOT_BODIES[id];
  return <span className="cell" key={id}><CursorAvatar size={80} paused expression={0} state="idle" silhouette={silhouette} gradient={grad(COLORS[i])} lookAround={0.5} /></span>;
})}</>);
const native = document.getElementById('native')!;
MASCOT_BODY_IDS.forEach((id, i) => {
  const cell = document.createElement('span'); cell.className = 'cell';
  const el = document.createElement('omp-mascot');
  for (const [k, v] of Object.entries({ body: id, color: names[i], size: '80', paused: '', expression: '0', state: 'idle' })) el.setAttribute(k, v);
  cell.append(el); native.append(cell);
});
(window as never as { ready: boolean }).ready = true;
