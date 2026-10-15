// 上游对照：原样使用 OpenMausBot 的 React CursorAvatar，每个实例各自一个 requestAnimationFrame。
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CursorAvatar } from '@oms/components/CursorAvatar';
import { MASCOT_BODIES, MASCOT_BODY_IDS } from '@oms-shared/mascot-bodies';
const q = new URLSearchParams(location.search);
const n = Number(q.get('n') ?? 20), size = Number(q.get('size') ?? 36), state = (q.get('state') ?? 'working') as never;
const app = document.getElementById('app')!;
createRoot(app).render(<>{Array.from({ length: n }, (_, i) => {
  const { id: _id, ...silhouette } = MASCOT_BODIES[MASCOT_BODY_IDS[i % 10]];
  return <CursorAvatar key={i} size={size} state={state} silhouette={silhouette} />;
})}</>);
