const MAX_SIGNALS_CHARS = 3_000;
const CONTEXT_RADIUS = 80; // caratteri di contesto intorno a ogni match

// Marker noti di librerie/tecniche di animazione legate allo scroll.
// Cercati nell'HTML renderizzato (post-JS), non nel markdown.
// Attenzione ai falsi positivi: "THREE" da solo matcha testo normale
// ("Three elevators"), servono forme più specifiche.
const MARKERS = [
  "gsap",
  "ScrollTrigger",
  "framer-motion",
  "three.js",
  "three.min",
  "THREE.",
  "locomotive-scroll",
  "has-scroll-smooth",
  "lenis",
  "swiper",
  "<canvas",
  "data-scroll-sticky",
  "data-scroll-section",
  "data-scroll",
  "data-plugin=\"parallax\"",
  "parallax",
  "sticky",
  "will-change",
  "transform:",
  "IntersectionObserver",
];

/**
 * Scansione euristica dell'HTML renderizzato per marker di librerie/tecniche
 * di animazione (gsap, three.js, parallax, sticky...). Restituisce un blocco
 * di testo compatto con gli snippet trovati, da usare come evidenza tecnica
 * per il modello — non una diagnosi accurata, solo indizi concreti.
 */
export function extractAnimationSignals(html: string | null | undefined): string {
  if (!html) return "";

  const lower = html.toLowerCase();
  const found = new Set<string>();
  let out = "";

  for (const marker of MARKERS) {
    if (out.length >= MAX_SIGNALS_CHARS) break;

    const needle = marker.toLowerCase();
    const idx = lower.indexOf(needle);
    if (idx === -1) continue;

    let count = 0;
    for (let i = idx; i !== -1; i = lower.indexOf(needle, i + needle.length)) count++;

    const start = Math.max(0, idx - CONTEXT_RADIUS);
    const end = Math.min(html.length, idx + marker.length + CONTEXT_RADIUS);
    const snippet = html.slice(start, end).replace(/\s+/g, " ").trim();

    if (found.has(snippet)) continue;
    found.add(snippet);
    out += `- [${marker} ×${count}] …${snippet}…\n`;
  }

  return out ? out.slice(0, MAX_SIGNALS_CHARS) : "";
}
