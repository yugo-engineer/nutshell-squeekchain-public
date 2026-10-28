"use client";
/**
 * Fig. 01, the machine: a dot grid where fees drift in from the left as amber grains and drop
 * into the shell on the right. Decorative only - no number here is data. Draws one still frame
 * under reduced motion and pauses while off screen.
 */
import { useEffect, useRef } from "react";

type Grain = { x: number; y: number; v: number; r: number };

export function Field() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0, h = 0, raf = 0, visible = true;
    const grains: Grain[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const spawn = (): Grain => ({ x: -10, y: h * (0.25 + Math.random() * 0.6), v: 0.6 + Math.random() * 1.2, r: 2.5 + Math.random() * 2.5 });

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      // the grid
      ctx.fillStyle = "rgba(22,22,26,.18)";
      for (let x = 24; x < w; x += 24) for (let y = 24; y < h; y += 24) ctx.fillRect(x, y, 1.5, 1.5);
      // grains drift right and fall toward the shell (right ~20% of the plate)
      const sink = w * 0.8;
      for (const g of grains) {
        const t = Math.max(0, (g.x - w * 0.35) / (sink - w * 0.35));
        const y = g.y + (h * 0.62 - g.y) * t * t;
        const a = g.x > sink ? Math.max(0, 1 - (g.x - sink) / 60) : 1;
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(g.x, y, g.r, 0, Math.PI * 2);
        ctx.fillStyle = "#ffc048";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#16161a";
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    const tick = () => {
      if (visible) {
        if (grains.length < 26 && Math.random() < 0.08) grains.push(spawn());
        for (let i = grains.length - 1; i >= 0; i--) {
          grains[i].x += grains[i].v;
          if (grains[i].x > w * 0.8 + 60) grains.splice(i, 1);
        }
        draw();
      }
      raf = requestAnimationFrame(tick);
    };

    resize();
    if (still) {
      for (let i = 0; i < 14; i++) grains.push({ ...spawn(), x: (w * 0.8 * i) / 14 });
      draw();
    } else {
      raf = requestAnimationFrame(tick);
    }
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(canvas);
    const onResize = () => {
      resize();
      draw();
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <canvas ref={ref} className="field" aria-hidden="true" />;
}
