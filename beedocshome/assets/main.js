/* BeeDocs marketing site.
 *
 * The hero is an isometric diagram of the BeeDocs stack, built the same way
 * the product's isometric editor builds one: items on a 2:1 dimetric tile
 * grid, each shape drawn as three faces shaded from a single base colour,
 * connectors routed along the grid. Tile-space is mapped to screen-space with
 * the affine 2:1 projection, so straight tile segments stay straight on screen.
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------- scene

  var TILE_W = 100; // full tile width on screen
  var TILE_H = 50;  // 2:1 dimetric
  var OX = 385;     // screen origin of tile (0,0)
  var OY = 95;

  function iso(x, y) {
    return [OX + (x - y) * (TILE_W / 2), OY + (x + y) * (TILE_H / 2)];
  }

  function pts(list) {
    return list.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
  }

  function lift(p, h) { return [p[0], p[1] - h]; }

  // Face shades from one base colour, like isoShapes.ts: top is lit,
  // south-west face is the base, south-east face is in shadow.
  function mix(hex, target, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(r + (target - r) * amt);
    g = Math.round(g + (target - g) * amt);
    b = Math.round(b + (target - b) * amt);
    return "rgb(" + r + "," + g + "," + b + ")";
  }
  function lighten(hex, amt) { return mix(hex, 255, amt); }
  function darken(hex, amt) { return mix(hex, 0, amt); }

  var ITEMS = [
    { x: 0.0, y: 0.0, w: 1.6, d: 1.6, h: 54, color: "#EBA312", label: "beedocs-web", sub: "React workspace" },
    { x: 0.2, y: 4.2, w: 1.3, d: 1.3, h: 40, color: "#A79F87", label: "AI agent", sub: "Claude · Cursor · …" },
    { x: 3.6, y: 1.0, w: 2.0, d: 2.0, h: 80, color: "#4E6E9B", label: "BeeDocs.Api", sub: ":5080 · .NET 10" },
    { x: 7.2, y: 0.0, w: 1.5, d: 1.5, h: 30, color: "#8A8574", label: "beedocs.db", sub: "SQLite · one file" },
    { x: 3.8, y: 4.8, w: 1.5, d: 1.5, h: 50, color: "#D98E04", label: "BeeDocs.Mcp", sub: ":5090 · MCP" }
  ];

  // Ground routes in tile-space; each maps to a straight-segment polyline.
  var EDGES = [
    [[1.6, 0.8], [2.6, 0.8], [2.6, 2.0], [3.6, 2.0]],     // web   -> api
    [[5.6, 2.0], [6.4, 2.0], [6.4, 0.75], [7.2, 0.75]],   // api   -> sqlite
    [[1.5, 4.85], [2.6, 4.85], [2.6, 5.55], [3.8, 5.55]], // agent -> mcp
    [[4.55, 4.8], [4.55, 3.0]]                            // mcp   -> api
  ];

  var ZONE = { x0: -0.5, y0: -0.6, x1: 9.2, y1: 6.8, label: "self-hosted · one VPS" };

  function cubeSvg(it, delay) {
    var pN = iso(it.x, it.y);
    var pE = iso(it.x + it.w, it.y);
    var pS = iso(it.x + it.w, it.y + it.d);
    var pW = iso(it.x, it.y + it.d);
    var h = it.h;

    var top = pts([lift(pN, h), lift(pE, h), lift(pS, h), lift(pW, h)]);
    var sw = pts([lift(pW, h), lift(pS, h), pS, pW]);
    var se = pts([lift(pS, h), lift(pE, h), pE, pS]);

    var cx = (pN[0] + pS[0]) / 2;
    var topY = (pN[1] + pS[1]) / 2 - h - ((it.w + it.d) * TILE_H) / 4;

    return '<g class="iso-item" style="animation-delay:' + delay + 's">' +
      '<polygon class="iso-face" points="' + sw + '" fill="' + it.color + '"/>' +
      '<polygon class="iso-face" points="' + se + '" fill="' + darken(it.color, 0.22) + '"/>' +
      '<polygon class="iso-face" points="' + top + '" fill="' + lighten(it.color, 0.34) + '"/>' +
      '<text class="iso-label" x="' + cx.toFixed(1) + '" y="' + (topY - 26).toFixed(1) + '" text-anchor="middle">' + it.label + '</text>' +
      '<text class="iso-sub" x="' + cx.toFixed(1) + '" y="' + (topY - 10).toFixed(1) + '" text-anchor="middle">' + it.sub + '</text>' +
      '</g>';
  }

  function edgeSvg(route, delay) {
    var mapped = route.map(function (p) { return lift(iso(p[0], p[1]), 2); });
    return '<g class="iso-edge" style="animation-delay:' + delay + 's">' +
      '<polyline points="' + pts(mapped) + '" pathLength="1" marker-end="url(#iso-arrow)"/>' +
      '</g>';
  }

  function zoneSvg() {
    var corners = pts([
      iso(ZONE.x0, ZONE.y0), iso(ZONE.x1, ZONE.y0),
      iso(ZONE.x1, ZONE.y1), iso(ZONE.x0, ZONE.y1)
    ]);
    var lp = iso((ZONE.x0 + ZONE.x1) / 2, ZONE.y1);
    return '<g class="iso-zone-g">' +
      '<polygon class="iso-zone" points="' + corners + '"/>' +
      '<text class="iso-zone-label" x="' + lp[0].toFixed(1) + '" y="' + (lp[1] + 18).toFixed(1) + '" text-anchor="middle">' + ZONE.label + '</text>' +
      '</g>';
  }

  function buildHero() {
    var svg = document.getElementById("iso-hero");
    if (!svg) return;

    // Painter's order: farther footprints (smaller x+y extent) first.
    var ordered = ITEMS.slice().sort(function (a, b) {
      return (a.x + a.w + a.y + a.d) - (b.x + b.w + b.y + b.d);
    });

    var parts = [
      '<defs><marker id="iso-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#4E6E9B"/></marker></defs>',
      zoneSvg()
    ];

    EDGES.forEach(function (route, i) {
      parts.push(edgeSvg(route, 0.9 + i * 0.16));
    });

    ordered.forEach(function (it, i) {
      parts.push(cubeSvg(it, 0.15 + i * 0.13));
    });

    svg.innerHTML = parts.join("");
  }

  // -------------------------------------------------------- scroll reveal

  function setupReveal() {
    var sections = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window)) {
      sections.forEach(function (el) { el.classList.add("visible"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    sections.forEach(function (el) { io.observe(el); });
  }

  // ------------------------------------------------------ tour video

  // The tour clip autoplays muted; honour a reduced-motion preference by
  // leaving it paused on its poster frame instead.
  function setupTourVideo() {
    var video = document.querySelector(".tour-video video");
    if (!video) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      video.removeAttribute("autoplay");
      video.pause();
      video.setAttribute("controls", "");
    }
  }

  buildHero();
  setupReveal();
  setupTourVideo();
})();
