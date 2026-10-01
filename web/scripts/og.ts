// Renders the Open Graph image, `public/og.png`, with takumi: `node scripts/og.ts`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { render } from "takumi-js";
import { googleFonts } from "takumi-js/helpers";

const W = 1200;
const H = 630;

const svg = (s: string) => `data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}`;

const logo = svg(readFileSync(new URL("../../.github/logo-light.svg", import.meta.url), "utf8"));

// Lucide arrow-up-right, to mark the url as a link.
const arrow = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#0369a1" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>`,
);

// Lucide icons. Colors stay above 3:1 contrast on their tile.
const icon = (paths: string, color: string) =>
  svg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
  );

// The four headline measures, given equal weight, each with its own [stroke, tile] color.
const measures: {
  icon: string;
  color: [string, string];
  title: string;
  text: string;
  code?: boolean;
}[] = [
  {
    icon: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    color: ["#c2410c", "#ffedd5"],
    title: "Native speed",
    text: "pure TS, no binary",
  },
  {
    icon: '<path d="M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/>',
    color: ["#047857", "#d1fae5"],
    title: "Tiny",
    text: "zero dependencies",
  },
  {
    icon: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
    color: ["#1d4ed8", "#dbeafe"],
    title: "Drop-in",
    text: "npm, pnpm, bun locks",
  },
  {
    icon: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
    color: ["#7e22ce", "#f3e8ff"],
    title: "JS API",
    text: "await install()",
    code: true,
  },
];

const boxes = measures
  .map(
    (m) => `
    <div class="box">
      <div class="icon" style="background-color: ${m.color[1]}">
        <img src="${icon(m.icon, m.color[0])}" width="26" height="26" />
      </div>
      <div class="name">${m.title}</div>
      <div class="${m.code ? "text code" : "text"}">${m.text}</div>
    </div>`,
  )
  .join("");

const html = `
<div class="card">
  <div class="glow"></div>
  <div class="top">
    <img src="${logo}" width="117" height="40" />
    <div class="url">upm.sh<img src="${arrow}" width="20" height="20" /></div>
  </div>
  <div class="title">
    <div class="line"><div>A</div><div class="hl">fast, tiny</div><div>package manager</div></div>
    <div class="dim">for the npm registry.</div>
  </div>
  <div class="boxes">${boxes}</div>
</div>`;

const css = `
.card { width: 100%; height: 100%; display: flex; flex-direction: column; position: relative; overflow: hidden;
  padding: 56px 64px; background-color: #f5f5f7; color: #1d1d1f; font-family: Geist; }
.glow { position: absolute; top: -420px; left: 620px; width: 1000px; height: 760px;
  background-image: radial-gradient(ellipse, rgba(251,146,60,0.16), rgba(251,146,60,0) 60%); }
.top { display: flex; align-items: center; justify-content: space-between; }
.url { display: flex; align-items: center; gap: 6px; padding: 10px 16px 10px 20px; border-radius: 999px;
  background-color: rgba(255,255,255,0.8); border: 1px solid rgba(2,132,199,0.25);
  font-size: 22px; font-weight: 600; color: #0369a1; }
.hl { background-image: linear-gradient(90deg, #ea580c, #db2777); background-clip: text; color: transparent; }
.title { display: flex; flex-direction: column; margin-top: 48px; font-size: 64px; font-weight: 700;
  line-height: 1.08; letter-spacing: -0.035em; }
.line { display: flex; gap: 17px; }
.dim { color: #6e6e73; }
.boxes { display: flex; gap: 20px; margin-top: auto; }
.box { display: flex; flex-direction: column; flex: 1; padding: 26px 26px 28px; border-radius: 26px;
  background-color: #ffffff; border: 1px solid rgba(0,0,0,0.06);
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 12px 32px rgba(0,0,0,0.06); }
.icon { display: flex; align-items: center; justify-content: center; width: 48px; height: 48px;
  border-radius: 14px; }
.name { margin-top: 22px; font-size: 28px; font-weight: 700; letter-spacing: -0.025em; }
.text { margin-top: 6px; font-size: 18px; line-height: 1.35; color: #515154; }
.code { font-family: Geist Mono; font-size: 17px; color: #7e22ce; }
`;

const fonts = await googleFonts([
  { name: "Geist", weight: [400, 600, 700] },
  { name: "Geist Mono", weight: [400] },
]);
const png = await render(html, { width: W, height: H, css, fonts });

const out = new URL("../public/og.png", import.meta.url);
mkdirSync(new URL(".", out), { recursive: true });
writeFileSync(out, png);
console.log(`og: wrote ${out.pathname} (${png.byteLength} bytes)`);
