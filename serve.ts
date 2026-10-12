/**
 * Minimal static file server for playing the game locally.
 *
 * Run with `deno task serve` (or `deno task serve 3000` for a custom port),
 * then open http://localhost:8000/ in a browser.
 *
 * Serves the project root: index.htm (bundled pacman.js) or debug.htm
 * (individual src/*.js files). Zero dependencies, Deno standard APIs only.
 */

const port = Number(Deno.args[0] ?? 8000);
const root = Deno.cwd();

// Content types for the assets this project serves (htm/js, sounds, font, icons).
const MIME: Record<string, string> = {
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

Deno.serve({ port }, async (request) => {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  if (pathname.includes("..")) {
    return new Response("forbidden", { status: 403 });
  }

  // this project's directory index
  const file = pathname.endsWith("/") ? pathname + "index.htm" : pathname;
  const type = MIME[file.slice(file.lastIndexOf(".")).toLowerCase()] ??
    "application/octet-stream";

  try {
    const body = (await Deno.open(root + file, { read: true })).readable;
    return new Response(body, { headers: { "content-type": type } });
  } catch {
    return new Response("not found", { status: 404 });
  }
});
