look at this repo: https://github.com/showlab/Code2Video

Investigate if it would make sense to include it into beedocs. Would be interesting to turn books or bookshelves into educational videos.

---

## Investigation findings (2026-08-16)

### What Code2Video is

A research framework (ICML 2026, showlab, MIT license, ~1.9k stars) that generates
educational videos by writing and rendering **Manim** animation code instead of using
a pixel-based text-to-video model. Tri-agent pipeline:

1. **Planner** — expands a "knowledge point" (a topic string) into a storyboard
2. **Coder** — writes executable Manim code, with auto-debug loops on render errors
3. **Critic** — a vision model looks at rendered frames and fixes layout/aesthetics

Input is a topic string; output is an MP4 plus the generated Manim source. Its
benchmark (MMMC) is 117 math-flavoured topics in the style of 3Blue1Brown.

### Practical constraints

- **Python CLI only** — no server/API mode; shell scripts + `api_config.json`.
  Heavy native dependency chain: Manim CE 0.19, LaTeX, ffmpeg, Cairo/Pango.
- **Cannot run fully locally** — needs a cloud LLM (Claude Opus recommended for
  Manim code quality) **and** a VLM (Gemini 2.5 Pro recommended) per run.
  BeeDocs' `llm_provider` abstraction speaks OpenAI-compatible chat completions,
  so OpenRouter could front both, but the recommended models are vendor-specific.
- **Slow and costly per video** — multi-agent loops with render→debug→critique
  cycles against frontier models. This is minutes-to-tens-of-minutes and dollars
  per video, not a click-to-preview feature. Needs an async job queue + progress UI.
- **Domain risk** — Manim excels at math animation; the benchmark is math concepts.
  BeeDocs content is software/hardware *architecture* documentation. Quality on
  "explain this system's architecture" is unproven, though BeeDocs' structured
  diagram JSON (BeeDiagram/isometric) could ground the Planner far better than a
  bare topic string.

### Verdict: don't embed it; maybe wrap it — prototype first

Embedding the repo into BeeDocs (a .NET + React monorepo with embedded SQLite and
deliberately no extra containers) is a poor fit. If pursued, the shape would be an
**optional sidecar worker container** (small FastAPI wrapper around Code2Video's
modules), with the API adding e.g. `POST /api/pages/{id}/video` → job queue →
worker pulls page Markdown (+ diagram JSON) as Planner input → stores MP4 under
`/uploads` → page embeds it. Optional, off by default, same spirit as storage
providers and LLM providers.

Before building any of that, the cheap validation step: run Code2Video standalone
against the content of 2–3 real BeeDocs pages (paste the Markdown as the knowledge
point) and judge whether the output is good enough on architecture-style content.
If it isn't, a cheaper in-house path already exists 80% of the way: **page → slide
deck (existing feature) → video** — render `SlideView` frames deterministically,
add TTS narration, mux with ffmpeg. That reuses the existing renderer and LLM
plumbing, is fast/cheap/predictable, and produces "narrated slideshow" videos
rather than animated Manim explainers — likely the better fit for documentation.
