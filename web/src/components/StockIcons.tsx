/**
 * Pixel stock coins, ported from the nutshell-fi mockup: a 20x20 glyph centred on a 40x40 coin
 * with a dark rim, a highlight and a shaded edge, all in the brand's own colours.
 */
import { GLYPHS } from "@/lib/stock-glyphs";

export type Sprite = { rows: string[]; palette: Record<string, string> };

export const STOCK_STYLE: Record<string, { face: string; ink: string }> = {
  NVDA: { face: "#111111", ink: "#76B900" },
  AAPL: { face: "#1d1d1f", ink: "#f5f5f7" },
  GOOGL: { face: "#ffffff", ink: "#202124" },
  MSFT: { face: "#f3f3f3", ink: "#262626" },
  TSLA: { face: "#E31937", ink: "#ffffff" },
  COIN: { face: "#0052FF", ink: "#ffffff" },
};

const grid = (f: (x: number, y: number) => string) =>
  Array.from({ length: 20 }, (_, y) => Array.from({ length: 20 }, (_, x) => f(x, y)).join(""));

function glyph(symbol: string, ink: string): Sprite {
  switch (symbol) {
    case "GOOGL":
      return {
        rows: grid((x, y) => {
          if (GLYPHS.GOOGL[y][x] !== "#") return ".";
          const a = (180 * Math.atan2(y + 0.5 - 10, x + 0.5 - 10)) / Math.PI;
          return a > -30 && a <= 40 ? "b" : a > 40 && a <= 140 ? "g" : a > 140 || a <= -165 ? "y" : "r";
        }),
        palette: { b: "#4285F4", g: "#34A853", y: "#FBBC05", r: "#EA4335" },
      };
    case "MSFT":
      return {
        rows: grid((x, y) => (x === 9 || x === 10 || y === 9 || y === 10 ? "." : x < 9 ? (y < 9 ? "r" : "b") : y < 9 ? "g" : "y")),
        palette: { r: "#F25022", g: "#7FBA00", b: "#00A4EF", y: "#FFB900" },
      };
    case "COIN":
      return {
        rows: grid((x, y) => {
          const dx = x + 0.5 - 10;
          const dy = y + 0.5 - 10;
          const d = Math.hypot(dx, dy);
          return d > 9.6 || d < 4.8 || (dx > 0 && Math.abs(dy) < 2.6) ? "." : "m";
        }),
        palette: { m: ink },
      };
    default:
      return { rows: GLYPHS[symbol as keyof typeof GLYPHS].map((r) => r.replace(/#/g, "m")), palette: { m: ink } };
  }
}

/** Mixes two #rrggbb colours: t = 0 gives a, t = 1 gives b. */
function mix(a: string, b: string, t: number) {
  const x = parseInt(a.slice(1), 16);
  const y = parseInt(b.slice(1), 16);
  const c = (s: number) => Math.round(((x >> s) & 255) + (((y >> s) & 255) - ((x >> s) & 255)) * t);
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, "0")}`;
}

export function coin(g: Sprite, face: string): Sprite {
  const a = Array.from({ length: 40 }, () => Array<string>(40).fill("."));
  for (let y = 0; y < 40; y++)
    for (let x = 0; x < 40; x++) {
      const dx = x + 0.5 - 20;
      const dy = y + 0.5 - 20;
      const d = Math.hypot(dx, dy);
      if (d > 19.5) continue;
      a[y][x] = d > 18.3 ? "o" : d > 16.4 ? (dx + dy < -6 ? "h" : dx + dy > 6 ? "s" : "r") : d > 15.3 ? "g" : "b";
    }
  const keys = Object.keys(g.palette);
  const map = Object.fromEntries(keys.map((k, i) => [k, String.fromCharCode(65 + i)]));
  const ox = Math.round(20 - Math.max(...g.rows.map((r) => r.length)) / 2);
  const oy = Math.round(20 - g.rows.length / 2);
  g.rows.forEach((row, y) => [...row].forEach((c, x) => { if (c !== "." && map[c]) a[oy + y][ox + x] = map[c]; }));
  return {
    rows: a.map((r) => r.join("")),
    palette: {
      o: "#000000",
      h: mix(face, "#ffffff", 0.4),
      r: mix(face, "#000000", 0.12),
      s: mix(face, "#000000", 0.35),
      g: mix(face, "#000000", 0.45),
      b: face,
      ...Object.fromEntries(keys.map((k) => [map[k], g.palette[k]])),
    },
  };
}

export function stockCoin(symbol: string): Sprite {
  const s = STOCK_STYLE[symbol];
  return coin(glyph(symbol, s.ink), s.face);
}

/**
 * A 22x22 version of the same coin for the wheel scene's conveyor, where the 40px coin is too
 * tall for the machine's intake. The 20x20 glyph is halved by 2x2 blocks: a block takes the
 * colour of its first lit pixel, so thin strokes survive the shrink.
 */
export function stockCoinSmall(symbol: string): Sprite {
  const s = STOCK_STYLE[symbol];
  const g = glyph(symbol, s.ink);
  const half = Array.from({ length: 10 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const c = g.rows[2 * y + dy]?.[2 * x + dx];
        if (c && c !== ".") return c;
      }
      return ".";
    }).join("")
  );
  const N = 22;
  const a = Array.from({ length: N }, () => Array<string>(N).fill("."));
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = x + 0.5 - N / 2;
      const dy = y + 0.5 - N / 2;
      const d = Math.hypot(dx, dy);
      if (d > 10.6) continue;
      a[y][x] = d > 9.6 ? "o" : d > 8.4 ? (dx + dy < -3 ? "h" : dx + dy > 3 ? "s" : "r") : "b";
    }
  const keys = Object.keys(g.palette);
  const map = Object.fromEntries(keys.map((k, i) => [k, String.fromCharCode(65 + i)]));
  half.forEach((row, y) => [...row].forEach((c, x) => { if (c !== "." && map[c]) a[6 + y][6 + x] = map[c]; }));
  return {
    rows: a.map((r) => r.join("")),
    palette: {
      o: "#000000",
      h: mix(s.face, "#ffffff", 0.4),
      r: mix(s.face, "#000000", 0.12),
      s: mix(s.face, "#000000", 0.35),
      b: s.face,
      ...Object.fromEntries(keys.map((k) => [map[k], g.palette[k]])),
    },
  };
}

/** Run-length rects, crisp at any scale. */
export function PixelSprite({ sprite, scale = 4, label }: { sprite: Sprite; scale?: number; label?: string }) {
  const w = Math.max(...sprite.rows.map((r) => r.length));
  const h = sprite.rows.length;
  const rects: React.ReactNode[] = [];
  sprite.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === c) end++;
      const fill = sprite.palette[c];
      if (c !== "." && fill) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={end - x} height={1} fill={fill} />);
      x = end;
    }
  });
  return (
    <svg width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" role={label ? "img" : undefined} aria-label={label} aria-hidden={!label || undefined}>
      {rects}
    </svg>
  );
}

export function StockIcon({ symbol, name }: { symbol: string; name: string }) {
  return <PixelSprite sprite={stockCoin(symbol)} scale={4} label={`${name} logo`} />;
}
