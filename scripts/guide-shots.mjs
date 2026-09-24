// Рендерит иллюстрации для /guide из assets/guide/guide.html в web/public/guide/step-N.png.
// Нужен Chromium-браузер (Edge/Chrome); путь можно задать через BROWSER=...
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const candidates = [
  process.env.BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter(Boolean);
const browser = candidates.find((p) => existsSync(p));
if (!browser) throw new Error("Не нашёл Edge/Chrome — укажи путь в BROWSER");

const src = pathToFileURL(resolve("assets/guide/guide.html")).href;
const out = resolve("web/public/guide");
mkdirSync(out, { recursive: true });

for (const n of [1, 2, 3, 4]) {
  const file = resolve(out, `step-${n}.png`);
  execFileSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1.5", "--window-size=1200,760", `--screenshot=${file}`, `${src}?step=${n}`], {
    stdio: "ignore",
  });
  console.log("✓", file);
}
