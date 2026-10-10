//! BeeDocs animation engine, ported from `animModel.ts` for fframes.
//!
//! The animation is the same JSON document BeeDocs stores (`animation.json`,
//! embedded at compile time). `render_frame_svg(doc, t)` is a line-for-line
//! port of the TypeScript renderer: frame = f(t) -> SVG markup, which fframes
//! parses and rasterises (`Svgr::from(String)` without `compile-time-svgtree`).
//! Keep the two in sync — the web app ships this file verbatim in every export.
#![allow(clippy::too_many_arguments)]

use serde::Deserialize;
use std::f32::consts::PI;
use std::fmt::Write as _;

#[derive(Debug, Clone, Deserialize)]
pub struct Cue {
    pub preset: String,
    pub at: f32,
    pub duration: f32,
    #[serde(default)]
    pub easing: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Keyframe {
    pub t: f32,
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub opacity: Option<f32>,
    pub scale: Option<f32>,
    pub rotate: Option<f32>,
    #[serde(default)]
    pub easing: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub x2: Option<f32>,
    pub y2: Option<f32>,
    pub text: Option<String>,
    pub font_size: Option<f32>,
    pub font: Option<String>,
    pub bold: Option<bool>,
    pub align: Option<String>,
    pub color: Option<String>,
    pub fill: Option<String>,
    pub stroke: Option<String>,
    pub stroke_width: Option<f32>,
    pub radius: Option<f32>,
    pub opacity: Option<f32>,
    pub src: Option<String>,
    /// Path data relative to the element's top-left (x, y).
    pub d: Option<String>,
    pub dashed: Option<bool>,
    pub enter: Option<Cue>,
    pub emphasis: Option<Cue>,
    pub exit: Option<Cue>,
    pub keyframes: Option<Vec<Keyframe>>,
}

// `id`, `title` and `fps` are not needed to draw a frame but are part of the document.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub id: String,
    pub title: String,
    pub duration: f32,
    pub background: Option<String>,
    pub narration: Option<String>,
    pub transition: Option<String>,
    pub transition_duration: Option<f32>,
    #[serde(default)]
    pub elements: Vec<Element>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct AnimDoc {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub background: String,
    #[serde(default = "yes")]
    pub captions: bool,
    pub scenes: Vec<Scene>,
}

fn yes() -> bool {
    true
}

impl AnimDoc {
    pub fn parse(json: &str) -> AnimDoc {
        serde_json::from_str(json).expect("animation.json is not a BeeDocs animation document")
    }

    pub fn total_duration(&self) -> f32 {
        self.scenes.iter().map(|s| s.duration).sum()
    }
}

// --- easing ---------------------------------------------------------------

fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

pub fn ease(name: Option<&str>, p: f32) -> f32 {
    let x = clamp01(p);
    match name.unwrap_or("easeOut") {
        "linear" => x,
        "easeIn" => x * x * x,
        "easeInOut" => {
            if x < 0.5 {
                4.0 * x * x * x
            } else {
                1.0 - (-2.0 * x + 2.0).powi(3) / 2.0
            }
        }
        "easeOutBack" => {
            let c1 = 1.70158;
            let c3 = c1 + 1.0;
            1.0 + c3 * (x - 1.0).powi(3) + c1 * (x - 1.0).powi(2)
        }
        "easeOutElastic" => {
            if x == 0.0 || x == 1.0 {
                x
            } else {
                2f32.powf(-10.0 * x) * ((x * 10.0 - 0.75) * ((2.0 * PI) / 3.0)).sin() + 1.0
            }
        }
        "easeOutBounce" => {
            let n1 = 7.5625;
            let d1 = 2.75;
            let mut v = x;
            if v < 1.0 / d1 {
                n1 * v * v
            } else if v < 2.0 / d1 {
                v -= 1.5 / d1;
                n1 * v * v + 0.75
            } else if v < 2.5 / d1 {
                v -= 2.25 / d1;
                n1 * v * v + 0.9375
            } else {
                v -= 2.625 / d1;
                n1 * v * v + 0.984375
            }
        }
        // "easeOut" and anything unknown
        _ => 1.0 - (1.0 - x).powi(3),
    }
}

fn lerp(a: f32, b: f32, p: f32) -> f32 {
    a + (b - a) * p
}

// --- timeline -------------------------------------------------------------

pub fn scene_at(doc: &AnimDoc, t: f32) -> (usize, f32) {
    let mut start = 0.0;
    let n = doc.scenes.len();
    for (i, s) in doc.scenes.iter().enumerate() {
        if t < start + s.duration || i == n - 1 {
            return (i, (t - start).max(0.0).min(s.duration));
        }
        start += s.duration;
    }
    (0, 0.0)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Reveal {
    None,
    Draw,
    Type,
    Wipe,
}

#[derive(Debug, Clone, Copy)]
struct State {
    visible: bool,
    x: f32,
    y: f32,
    opacity: f32,
    scale: f32,
    rotate: f32,
    dx: f32,
    dy: f32,
    reveal: f32,
    reveal_mode: Reveal,
    glow: f32,
}

struct Pose {
    x: f32,
    y: f32,
    opacity: f32,
    scale: f32,
    rotate: f32,
    t: f32,
}

fn keyframed(el: &Element, t: f32) -> Pose {
    let mut prev = Pose { x: el.x, y: el.y, opacity: el.opacity.unwrap_or(1.0), scale: 1.0, rotate: 0.0, t: 0.0 };
    let Some(kfs) = el.keyframes.as_ref() else { return prev };
    for k in kfs {
        let next = Pose {
            x: k.x.unwrap_or(prev.x),
            y: k.y.unwrap_or(prev.y),
            opacity: k.opacity.unwrap_or(prev.opacity),
            scale: k.scale.unwrap_or(prev.scale),
            rotate: k.rotate.unwrap_or(prev.rotate),
            t: k.t,
        };
        if t < k.t {
            let span = k.t - prev.t;
            let p = if span <= 0.0 { 1.0 } else { ease(Some(k.easing.as_deref().unwrap_or("easeInOut")), (t - prev.t) / span) };
            return Pose {
                x: lerp(prev.x, next.x, p),
                y: lerp(prev.y, next.y, p),
                opacity: lerp(prev.opacity, next.opacity, p),
                scale: lerp(prev.scale, next.scale, p),
                rotate: lerp(prev.rotate, next.rotate, p),
                t,
            };
        }
        prev = next;
    }
    prev
}

fn element_state(el: &Element, t: f32) -> State {
    let k = keyframed(el, t);
    let mut s = State {
        visible: true,
        x: k.x,
        y: k.y,
        opacity: k.opacity,
        scale: k.scale,
        rotate: k.rotate,
        dx: 0.0,
        dy: 0.0,
        reveal: 1.0,
        reveal_mode: Reveal::None,
        glow: 0.0,
    };

    if let Some(enter) = el.enter.as_ref().filter(|c| c.preset != "none") {
        if t < enter.at {
            s.visible = false;
            return s;
        }
        let raw = (t - enter.at) / enter.duration;
        if raw < 1.0 {
            let default = match enter.preset.as_str() {
                "pop" => "easeOutBack",
                "type" => "linear",
                _ => "easeOut",
            };
            let p = ease(Some(enter.easing.as_deref().unwrap_or(default)), raw);
            match enter.preset.as_str() {
                "fade" => s.opacity *= p,
                "rise" => {
                    s.dy += (1.0 - p) * 60.0;
                    s.opacity *= clamp01(raw * 1.6);
                }
                "drop" => {
                    s.dy -= (1.0 - p) * 160.0;
                    s.opacity *= clamp01(raw * 3.0);
                }
                "slide-left" => {
                    s.dx -= (1.0 - p) * 220.0;
                    s.opacity *= clamp01(raw * 2.0);
                }
                "slide-right" => {
                    s.dx += (1.0 - p) * 220.0;
                    s.opacity *= clamp01(raw * 2.0);
                }
                "pop" => s.scale *= p.max(0.0),
                "zoom" => {
                    s.scale *= 0.4 + 0.6 * p;
                    s.opacity *= clamp01(raw * 1.5);
                }
                "draw" => {
                    s.reveal = p;
                    s.reveal_mode = Reveal::Draw;
                }
                "type" => {
                    s.reveal = p;
                    s.reveal_mode = Reveal::Type;
                }
                "wipe" => {
                    s.reveal = p;
                    s.reveal_mode = Reveal::Wipe;
                }
                _ => {}
            }
        }
    }

    if let Some(em) = el.emphasis.as_ref() {
        if t >= em.at && t < em.at + em.duration {
            let q = (t - em.at) / em.duration;
            let bell = (PI * q).sin();
            match em.preset.as_str() {
                "pulse" => s.scale *= 1.0 + 0.14 * bell,
                "shake" => s.dx += (q * PI * 8.0).sin() * 12.0 * (1.0 - q),
                "glow" => s.glow = bell,
                "spin" => s.rotate += 360.0 * ease(Some(em.easing.as_deref().unwrap_or("easeInOut")), q),
                _ => {}
            }
        }
    }

    if let Some(exit) = el.exit.as_ref().filter(|c| c.preset != "none") {
        if t >= exit.at {
            let raw = (t - exit.at) / exit.duration;
            if raw >= 1.0 {
                s.visible = false;
                return s;
            }
            let p = ease(Some(exit.easing.as_deref().unwrap_or("easeIn")), raw);
            match exit.preset.as_str() {
                "fade" => s.opacity *= 1.0 - p,
                "sink" => {
                    s.dy += p * 60.0;
                    s.opacity *= 1.0 - p;
                }
                "shrink" => s.scale *= 1.0 - p,
                "slide-left" => {
                    s.dx -= p * 220.0;
                    s.opacity *= 1.0 - p;
                }
                "slide-right" => {
                    s.dx += p * 220.0;
                    s.opacity *= 1.0 - p;
                }
                _ => {}
            }
        }
    }
    if s.opacity <= 0.001 {
        s.visible = false;
    }
    s
}

// --- rendering ------------------------------------------------------------

const SANS: &str = "Inter, 'Segoe UI', system-ui, Helvetica, Arial, sans-serif";
const SERIF: &str = "Georgia, 'Times New Roman', serif";
const MONO: &str = "'JetBrains Mono', 'Cascadia Code', Consolas, Menlo, monospace";

fn font_stack(font: Option<&str>) -> &'static str {
    match font {
        Some("serif") => SERIF,
        Some("mono") => MONO,
        _ => SANS,
    }
}

fn fmt(n: f32) -> String {
    if !n.is_finite() {
        return "0".into();
    }
    let r = (n * 100.0).round() / 100.0;
    if r == r.trunc() { format!("{}", r as i64) } else { format!("{r}") }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn attr(s: &str) -> String {
    esc(s).replace('"', "&quot;")
}

fn safe_id(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

pub fn render_frame_svg(doc: &AnimDoc, time: f32) -> String {
    let (index, local) = scene_at(doc, time);
    let scene = &doc.scenes[index];
    let (w, h) = (doc.width as f32, doc.height as f32);
    let transition = if index > 0 { scene.transition.as_deref().unwrap_or("none") } else { "none" };
    let t_dur = scene.transition_duration.unwrap_or(0.6).max(0.05).min(scene.duration);

    let mut body = String::new();
    if transition != "none" && local < t_dur {
        let prev = &doc.scenes[index - 1];
        let p = ease(Some("easeInOut"), local / t_dur);
        let prev_layer = scene_layer(doc, prev, prev.duration, "bee-p");
        let cur_layer = scene_layer(doc, scene, local, "bee-c");
        match transition {
            "fade" => {
                let _ = write!(body, "<g>{prev_layer}</g><g opacity=\"{}\">{cur_layer}</g>", fmt(p));
            }
            "slide" => {
                let _ = write!(
                    body,
                    "<g transform=\"translate({} 0)\">{prev_layer}</g><g transform=\"translate({} 0)\">{cur_layer}</g>",
                    fmt(-w * p),
                    fmt(w * (1.0 - p))
                );
            }
            _ => {
                let s = 0.8 + 0.2 * p;
                let _ = write!(
                    body,
                    "<g opacity=\"{}\">{prev_layer}</g><g opacity=\"{}\" transform=\"translate({} {}) scale({})\">{cur_layer}</g>",
                    fmt(1.0 - p),
                    fmt(p),
                    fmt(w * (1.0 - s) / 2.0),
                    fmt(h * (1.0 - s) / 2.0),
                    fmt(s)
                );
            }
        }
    } else {
        body = scene_layer(doc, scene, local, "bee-c");
    }

    if doc.captions {
        if let Some(n) = scene.narration.as_deref() {
            body += &caption_bar(doc, n, local, scene.duration);
        }
    }

    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 {} {}\" width=\"{}\" height=\"{}\">{body}</svg>",
        doc.width, doc.height, doc.width, doc.height
    )
}

fn scene_layer(doc: &AnimDoc, scene: &Scene, t: f32, prefix: &str) -> String {
    let bg = scene.background.as_deref().unwrap_or(&doc.background);
    let mut out = format!("<rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"{}\"/>", doc.width, doc.height, attr(bg));
    for el in &scene.elements {
        out += &render_element(el, element_state(el, t), prefix);
    }
    out
}

fn caption_bar(doc: &AnimDoc, text: &str, t: f32, duration: f32) -> String {
    let (w, h) = (doc.width as f32, doc.height as f32);
    let font_size = (h * 0.034).round();
    let max_w = w * 0.8;
    let lines: Vec<String> = wrap_text(text, font_size, max_w, "sans").into_iter().take(3).collect();
    let line_h = font_size * 1.3;
    let box_h = lines.len() as f32 * line_h + font_size * 0.9;
    let y = h - box_h - h * 0.04;
    let o = clamp01(t / 0.3).min(clamp01((duration - t) / 0.3));
    let longest = lines.iter().map(|l| estimate_width(l, font_size, "sans")).fold(0.0, f32::max).min(max_w);
    let box_w = longest + font_size * 1.6;
    let x = (w - box_w) / 2.0;
    let mut spans = String::new();
    for (i, line) in lines.iter().enumerate() {
        let _ = write!(
            spans,
            "<tspan x=\"{}\" y=\"{}\">{}</tspan>",
            fmt(w / 2.0),
            fmt(y + font_size * 0.45 + line_h * i as f32 + font_size),
            esc(line)
        );
    }
    format!(
        "<g opacity=\"{}\"><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"#000\" fill-opacity=\"0.62\"/><text font-family=\"{}\" font-size=\"{}\" fill=\"#fff\" text-anchor=\"middle\">{spans}</text></g>",
        fmt(o),
        fmt(x),
        fmt(y),
        fmt(box_w),
        fmt(box_h),
        fmt(font_size * 0.5),
        attr(SANS),
        fmt(font_size)
    )
}

fn render_element(el: &Element, s: State, prefix: &str) -> String {
    if !s.visible {
        return String::new();
    }
    let is_line = el.kind == "line" || el.kind == "arrow";
    let off_x = s.x - el.x + s.dx;
    let off_y = s.y - el.y + s.dy;
    let x2 = el.x2.unwrap_or(el.x + el.w);
    let y2 = el.y2.unwrap_or(el.y);
    let (cx, cy) = if is_line { ((el.x + x2) / 2.0, (el.y + y2) / 2.0) } else { (el.x + el.w / 2.0, el.y + el.h / 2.0) };

    let mut transforms: Vec<String> = Vec::new();
    if off_x != 0.0 || off_y != 0.0 {
        transforms.push(format!("translate({} {})", fmt(off_x), fmt(off_y)));
    }
    if s.rotate != 0.0 || s.scale != 1.0 {
        transforms.push(format!("translate({} {})", fmt(cx), fmt(cy)));
        if s.rotate != 0.0 {
            transforms.push(format!("rotate({})", fmt(s.rotate)));
        }
        if s.scale != 1.0 {
            transforms.push(format!("scale({})", fmt(s.scale.max(0.0))));
        }
        transforms.push(format!("translate({} {})", fmt(-cx), fmt(-cy)));
    }
    let id = format!("{prefix}-{}", safe_id(&el.id));
    let mut defs = String::new();
    let mut wrap = String::new();
    if !transforms.is_empty() {
        let _ = write!(wrap, " transform=\"{}\"", transforms.join(" "));
    }
    if s.opacity < 1.0 {
        let _ = write!(wrap, " opacity=\"{}\"", fmt(clamp01(s.opacity)));
    }
    if s.glow > 0.01 {
        let color = el.stroke.as_deref().or(el.fill.as_deref()).or(el.color.as_deref()).unwrap_or("#ffffff");
        let _ = write!(
            defs,
            "<filter id=\"{id}-glow\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\"><feDropShadow dx=\"0\" dy=\"0\" stdDeviation=\"{}\" flood-color=\"{}\" flood-opacity=\"{}\"/></filter>",
            fmt(4.0 + 14.0 * s.glow),
            attr(color),
            fmt(0.9 * s.glow)
        );
        let _ = write!(wrap, " filter=\"url(#{id}-glow)\"");
    }
    let wiping = s.reveal_mode == Reveal::Wipe && s.reveal < 1.0;
    if wiping {
        let bx = if is_line { el.x.min(x2) - 20.0 } else { el.x - 4.0 };
        let by = if is_line { el.y.min(y2) - 20.0 } else { el.y - 4.0 };
        let bw = (if is_line { (x2 - el.x).abs() + 40.0 } else { el.w + 8.0 }) * s.reveal;
        let bh = if is_line { (y2 - el.y).abs() + 40.0 } else { el.h + 8.0 };
        let _ = write!(
            defs,
            "<clipPath id=\"{id}-wipe\"><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"/></clipPath>",
            fmt(bx),
            fmt(by),
            fmt(bw),
            fmt(bh)
        );
    }
    let clip = if wiping { format!(" clip-path=\"url(#{id}-wipe)\"") } else { String::new() };
    let inner = element_shape(el, &s);
    if inner.is_empty() {
        return String::new();
    }
    let defs = if defs.is_empty() { defs } else { format!("<defs>{defs}</defs>") };
    format!("{defs}<g{wrap}><g{clip}>{inner}</g></g>")
}

fn element_shape(el: &Element, s: &State) -> String {
    let draw = if s.reveal_mode == Reveal::Draw { s.reveal } else { 1.0 };
    let sw0 = el.stroke_width.unwrap_or(3.0);
    let dash = if el.dashed.unwrap_or(false) {
        format!(" stroke-dasharray=\"{} {}\"", fmt(sw0 * 3.0), fmt(sw0 * 2.0))
    } else {
        String::new()
    };
    let draw_attrs = |len: f32| -> String {
        if draw < 1.0 {
            format!(" stroke-dasharray=\"{}\" stroke-dashoffset=\"{}\"", fmt(len), fmt(len * (1.0 - draw)))
        } else {
            dash.clone()
        }
    };
    match el.kind.as_str() {
        "text" => text_block(el, s, el.x, el.y, el.w, el.h, el.color.as_deref().unwrap_or("#f8fafc"), false, 1.0, None),
        "box" | "circle" => {
            let is_box = el.kind == "box";
            let fill = el.fill.as_deref().unwrap_or(if is_box { "#1e293b" } else { "#334155" });
            let stroke = el.stroke.as_deref().unwrap_or("none");
            let sw = el.stroke_width.unwrap_or(if el.stroke.is_some() { 3.0 } else { 0.0 });
            let fill_opacity = if draw < 1.0 { clamp01((draw - 0.55) / 0.45) } else { 1.0 };
            let outline_stroke = if draw < 1.0 {
                el.stroke.as_deref().or(el.fill.as_deref()).unwrap_or("#e2e8f0")
            } else {
                stroke
            };
            let outline_w = if draw < 1.0 { sw.max(3.0) } else { sw };
            let shape = if is_box {
                let r = el.radius.unwrap_or(12.0).min(el.w / 2.0).min(el.h / 2.0);
                let perimeter = 2.0 * (el.w + el.h);
                format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"{}\" fill-opacity=\"{}\" stroke=\"{}\" stroke-width=\"{}\"{}/>",
                    fmt(el.x),
                    fmt(el.y),
                    fmt(el.w),
                    fmt(el.h),
                    fmt(r),
                    attr(fill),
                    fmt(fill_opacity),
                    attr(outline_stroke),
                    fmt(outline_w),
                    if outline_w > 0.0 { draw_attrs(perimeter) } else { String::new() }
                )
            } else {
                let (rx, ry) = (el.w / 2.0, el.h / 2.0);
                let perimeter = PI * (3.0 * (rx + ry) - ((3.0 * rx + ry) * (rx + 3.0 * ry)).sqrt());
                format!(
                    "<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" fill=\"{}\" fill-opacity=\"{}\" stroke=\"{}\" stroke-width=\"{}\"{}/>",
                    fmt(el.x + rx),
                    fmt(el.y + ry),
                    fmt(rx),
                    fmt(ry),
                    attr(fill),
                    fmt(fill_opacity),
                    attr(outline_stroke),
                    fmt(outline_w),
                    if outline_w > 0.0 { draw_attrs(perimeter) } else { String::new() }
                )
            };
            let label = if el.text.as_deref().is_some_and(|t| !t.is_empty()) {
                text_block(
                    el,
                    s,
                    el.x + 12.0,
                    el.y,
                    el.w - 24.0,
                    el.h,
                    el.color.as_deref().unwrap_or("#f8fafc"),
                    true,
                    fill_opacity,
                    Some(el.align.as_deref().unwrap_or("middle")),
                )
            } else {
                String::new()
            };
            shape + &label
        }
        "line" | "arrow" => {
            let x2 = el.x2.unwrap_or(el.x + el.w);
            let y2 = el.y2.unwrap_or(el.y);
            let stroke = el.stroke.as_deref().unwrap_or("#e2e8f0");
            let sw = el.stroke_width.unwrap_or(4.0);
            let len = (x2 - el.x).hypot(y2 - el.y);
            let mut out = format!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\"{}/>",
                fmt(el.x),
                fmt(el.y),
                fmt(x2),
                fmt(y2),
                attr(stroke),
                fmt(sw),
                draw_attrs(len)
            );
            if el.kind == "arrow" && len > 0.0 && draw > 0.02 {
                let tip_x = el.x + (x2 - el.x) * draw;
                let tip_y = el.y + (y2 - el.y) * draw;
                let ang = (y2 - el.y).atan2(x2 - el.x);
                let size = (sw * 3.2).max(12.0);
                let _ = write!(
                    out,
                    "<polygon points=\"{},{} {},{} {},{}\" fill=\"{}\"/>",
                    fmt(tip_x),
                    fmt(tip_y),
                    fmt(tip_x - size * (ang - 0.45).cos()),
                    fmt(tip_y - size * (ang - 0.45).sin()),
                    fmt(tip_x - size * (ang + 0.45).cos()),
                    fmt(tip_y - size * (ang + 0.45).sin()),
                    attr(stroke)
                );
            }
            if let Some(text) = el.text.as_deref().filter(|t| !t.is_empty()) {
                let fs = el.font_size.unwrap_or(22.0);
                let _ = write!(
                    out,
                    "<text x=\"{}\" y=\"{}\" font-family=\"{}\" font-size=\"{}\" fill=\"{}\" text-anchor=\"middle\" opacity=\"{}\">{}</text>",
                    fmt((el.x + x2) / 2.0),
                    fmt((el.y + y2) / 2.0 - sw - 8.0),
                    attr(font_stack(el.font.as_deref())),
                    fmt(fs),
                    attr(el.color.as_deref().unwrap_or(stroke)),
                    fmt(draw),
                    esc(text)
                );
            }
            out
        }
        "icon" => {
            let size = el.font_size.unwrap_or(el.w.min(el.h) * 0.82);
            format!(
                "<text x=\"{}\" y=\"{}\" font-size=\"{}\" text-anchor=\"middle\" dominant-baseline=\"central\" fill=\"{}\" font-family=\"'Noto Color Emoji', 'Apple Color Emoji', 'Segoe UI Emoji', {}\">{}</text>",
                fmt(el.x + el.w / 2.0),
                fmt(el.y + el.h / 2.0),
                fmt(size),
                attr(el.color.as_deref().unwrap_or("#f8fafc")),
                attr(SANS),
                esc(el.text.as_deref().unwrap_or("★"))
            )
        }
        "image" => match el.src.as_deref() {
            // Exports inline images as data: URLs, so nothing is fetched at render time.
            Some(src) => format!(
                "<image xlink:href=\"{}\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"xMidYMid meet\"/>",
                attr(src),
                fmt(el.x),
                fmt(el.y),
                fmt(el.w),
                fmt(el.h)
            ),
            None => String::new(),
        },
        "path" => match el.d.as_deref() {
            Some(d) => {
                let stroke = el.stroke.as_deref().unwrap_or("#e2e8f0");
                let sw = el.stroke_width.unwrap_or(4.0);
                let fill = el.fill.as_deref().unwrap_or("none");
                let draw_part = if draw < 1.0 {
                    format!(" pathLength=\"1\" stroke-dasharray=\"1\" stroke-dashoffset=\"{}\"", fmt(1.0 - draw))
                } else {
                    dash.clone()
                };
                format!(
                    "<path transform=\"translate({} {})\" d=\"{}\" fill=\"{}\" fill-opacity=\"{}\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"{}/>",
                    fmt(el.x),
                    fmt(el.y),
                    attr(d),
                    attr(fill),
                    fmt(if draw < 1.0 { clamp01((draw - 0.6) / 0.4) } else { 1.0 }),
                    attr(stroke),
                    fmt(sw),
                    draw_part
                )
            }
            None => String::new(),
        },
        _ => String::new(),
    }
}

fn text_block(
    el: &Element,
    s: &State,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    color: &str,
    middle: bool,
    opacity: f32,
    align_override: Option<&str>,
) -> String {
    let text = el.text.as_deref().unwrap_or("");
    if text.is_empty() {
        return String::new();
    }
    let font = el.font.as_deref().unwrap_or("sans");
    let font_size = el.font_size.unwrap_or(if el.kind == "text" { 40.0 } else { 28.0 });
    let line_h = font_size * 1.25;
    let mut lines = wrap_text(text, font_size, w, font);
    if s.reveal_mode == Reveal::Type && s.reveal < 1.0 {
        let total: usize = lines.iter().map(|l| l.chars().count()).sum();
        let mut budget = (total as f32 * s.reveal).round() as usize;
        lines = lines
            .into_iter()
            .map(|l| {
                let n = l.chars().count().min(budget);
                budget -= n;
                l.chars().take(n).collect()
            })
            .collect();
    }
    let align = align_override.or(el.align.as_deref()).unwrap_or("start");
    let (anchor, ax) = match align {
        "middle" => ("middle", x + w / 2.0),
        "end" => ("end", x + w),
        _ => ("start", x),
    };
    let block_h = lines.len() as f32 * line_h;
    let top = if middle { y + (h - block_h) / 2.0 } else { y };
    let mut spans = String::new();
    for (i, line) in lines.iter().enumerate() {
        let body = if line.is_empty() { " ".to_string() } else { esc(line) };
        let _ = write!(
            spans,
            "<tspan x=\"{}\" y=\"{}\">{body}</tspan>",
            fmt(ax),
            fmt(top + line_h * i as f32 + font_size * 0.95)
        );
    }
    format!(
        "<text font-family=\"{}\" font-size=\"{}\" font-weight=\"{}\" fill=\"{}\" text-anchor=\"{anchor}\"{} xml:space=\"preserve\">{spans}</text>",
        attr(font_stack(Some(font))),
        fmt(font_size),
        if el.bold.unwrap_or(false) { 700 } else { 400 },
        attr(color),
        if opacity < 1.0 { format!(" opacity=\"{}\"", fmt(opacity)) } else { String::new() }
    )
}

fn estimate_width(text: &str, font_size: f32, font: &str) -> f32 {
    let factor = match font {
        "mono" => 0.6,
        "serif" => 0.5,
        _ => 0.53,
    };
    let units: f32 = text
        .chars()
        .map(|ch| {
            if (ch as u32) > 0x2e80 {
                1.8
            } else if ch.is_ascii_uppercase() || "mwMW".contains(ch) {
                1.2
            } else if "il.,'!|".contains(ch) {
                0.55
            } else {
                1.0
            }
        })
        .sum();
    units * font_size * factor
}

fn wrap_text(text: &str, font_size: f32, max_width: f32, font: &str) -> Vec<String> {
    let mut out = Vec::new();
    for para in text.split('\n') {
        if font == "mono" {
            out.push(para.to_string());
            continue;
        }
        let mut line = String::new();
        // Split keeping whitespace runs, like the TypeScript `split(/(\s+)/)`.
        let mut tokens: Vec<String> = Vec::new();
        let mut cur = String::new();
        let mut cur_ws: Option<bool> = None;
        for ch in para.chars() {
            let ws = ch.is_whitespace();
            if cur_ws.is_some_and(|c| c != ws) {
                tokens.push(std::mem::take(&mut cur));
            }
            cur.push(ch);
            cur_ws = Some(ws);
        }
        if !cur.is_empty() {
            tokens.push(cur);
        }
        for word in tokens {
            let candidate = format!("{line}{word}");
            if !line.trim().is_empty() && estimate_width(candidate.trim_end(), font_size, font) > max_width {
                out.push(line.trim_end().to_string());
                line = word.trim_start().to_string();
            } else {
                line = candidate;
            }
        }
        out.push(line.trim_end().to_string());
    }
    out
}
