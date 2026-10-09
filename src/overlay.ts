declare global {
  interface Window {
    ov: {
      move: (x: number, y: number) => void;
      up: (x: number, y: number) => void;
      cancel: () => void;
    };
  }
}

const ghost = document.getElementById('ghost')!;
let raf = 0;
let pending: { x: number; y: number } | null = null;

export {};

const flush = () => {
  raf = 0;
  if (pending) {
    window.ov.move(pending.x, pending.y);
    pending = null;
  }
};

window.addEventListener('pointermove', (e) => {
  ghost.style.display = 'block';
  ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
  pending = { x: e.clientX, y: e.clientY };
  if (!raf) raf = requestAnimationFrame(flush);
});

window.addEventListener('pointerup', (e) => {
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  window.ov.up(e.clientX, e.clientY);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.ov.cancel();
});

// 兜底：若 pointerup 因故未被转发（拖拽状态卡死），下一次点击也能解除
window.addEventListener('click', () => window.ov.cancel());

window.addEventListener('contextmenu', (e) => e.preventDefault());
