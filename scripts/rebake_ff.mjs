// FFMPEG re-bake (replaces the Pillow encoder). For each base: build the RGBA rebrand patch (static
// banner + placard/url zones, transparent elsewhere) and OVERLAY it onto every frame of the ORIGINAL
// ANIMATED source, then re-encode an animated AVIF with libsvtav1. AVIF sources feed ffmpeg directly
// (the animated sequence is the multi-frame video stream); our animated WebP sources can't be decoded
// by ffmpeg, so Pillow extracts their frames first and ffmpeg encodes from the PNG sequence.
//   node scripts/rebake_ff.mjs mythic-pack legend-pack-1dpaec ...
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";

const DIR = "public/images/claw";
const PATCH = "docs/research/packdetail/_patch";
const TMP = "docs/research/packdetail/_frames";
const PY = "C:/Users/PC/iopaint-venv/Scripts/python.exe";
const CRF = "30";
const ENC = ["-c:v", "libsvtav1", "-crf", CRF, "-pix_fmt", "yuv420p"];
const bases = process.argv.slice(2);
if (!bases.length) { console.log("usage: rebake_ff.mjs <base...>"); process.exit(1); }

execFileSync(PY, ["scripts/make_patch.py", ...bases], { stdio: "inherit" });

// AVIFs carry a 1-frame still + the animated sequence; pick the video stream with the most frames.
function animStream(src) {
  // JSON (read by field NAME) — ffprobe's CSV column order is NOT the requested order, which made a
  // positional parser read avg_frame_rate ("25/1") as nb_frames -> parseInt -> 25 (truncated output).
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v",
    "-show_entries", "stream=index,nb_frames,avg_frame_rate", "-of", "json", src]).toString());
  let best = { idx: 0, frames: 1 };
  for (const s of j.streams || []) {
    let frames = s.nb_frames && s.nb_frames !== "N/A" ? parseInt(s.nb_frames) : 0;
    if (!frames && s.avg_frame_rate && s.avg_frame_rate.includes("/")) {
      const [n, d] = s.avg_frame_rate.split("/").map(Number); frames = d ? Math.round((n / d) * 6) : 0;
    }
    if (frames > best.frames) best = { idx: s.index, frames };
  }
  return best;
}

const sizeKB = (f) => Math.round(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=size", "-of", "csv=p=0", f]).toString().trim() / 1024);

for (const base of bases) {
  const out = `${DIR}/${base}-anim.avif`;
  const patch = `${PATCH}/${base}.png`;
  const avif = `${DIR}/${base}-machine.avif`;
  const webp = `${DIR}/${base}-machine-src.webp`;
  try {
    if (existsSync(avif) && animStream(avif).frames >= 2) {
      const { idx, frames } = animStream(avif);
      // NOT -shortest: AVIFs carry a 1-frame/1s still stream, and -shortest truncates the output to
      // it (1s = 25f). Cap explicitly to the animated stream's frame count instead.
      execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
        "-i", avif, "-loop", "1", "-i", patch,
        "-filter_complex", `[0:v:${idx}][1:v]overlay=0:0:format=auto[o]`, "-map", "[o]",
        "-frames:v", String(frames), ...ENC, out], { stdio: "inherit", timeout: 180000 });
      console.log(`${base}: AVIF src stream 0:v:${idx} ${frames}f -> ${sizeKB(out)}KB`);
    } else if (existsSync(webp)) {
      const fdir = `${TMP}/${base}`;
      rmSync(fdir, { recursive: true, force: true }); mkdirSync(fdir, { recursive: true });
      execFileSync(PY, ["scripts/extract_frames.py", webp, fdir], { stdio: "inherit", timeout: 120000 });
      const nf = readdirSync(fdir).filter((f) => f.endsWith(".png")).length;
      // Cap to the extracted frame count. NOT -shortest: "-loop 1 -i patch" is an INFINITE stream, and
      // -shortest intermittently fails to terminate the overlay -> ffmpeg pegs every core forever (the
      // 23,000s-CPU runaway we hit). -frames:v <N> is deterministic, like the AVIF branch; timeout backstops.
      execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
        "-framerate", "25", "-i", `${fdir}/f%04d.png`, "-loop", "1", "-i", patch,
        "-filter_complex", `[0:v][1:v]overlay=0:0:format=auto[o]`, "-map", "[o]",
        "-frames:v", String(nf), ...ENC, out], { stdio: "inherit", timeout: 180000 });
      rmSync(fdir, { recursive: true, force: true });
      console.log(`${base}: WEBP src (Pillow ${nf}f) -> ${sizeKB(out)}KB`);
    } else {
      console.log(`${base}: SKIP (no animated source)`);
    }
  } catch (e) {
    console.log(`${base}: FAILED — ${e.message.split("\n")[0]}`);
  }
}
console.log("\nffmpeg re-bake done");
