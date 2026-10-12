/**
 * Build script.
 *
 *   1. builds 'pacman.js' by concatenating files specified in jsOrder
 *   2. updates the time stamp in index.htm (previous version kept in index.htm.bak)
 *   3. builds debug.htm with individual script includes
 *
 * Run with `deno task build` (see deno.json) or:
 *   deno run --allow-read=src,index.htm --allow-write=pacman.js,index.htm,index.htm.bak,debug.htm build.ts
 */

// Concatenation order matters: each file may use definitions from the files
// above it.
const jsOrder = [
  "inherit.js",
  "sound.js",
  "random.js",
  "game.js",
  "direction.js",
  "Map.js",
  "colors.js",
  "mapgen.js",
  "atlas.js",
  "renderers.js",
  "hud.js",
  "galagaStars.js",
  "Button.js",
  "Menu.js",
  "inGameMenu.js",
  "sprites.js",
  "Actor.js",
  "Ghost.js",
  "Player.js",
  "actors.js",
  "targets.js",
  "ghostCommander.js",
  "ghostReleaser.js",
  "elroyTimer.js",
  "energizer.js",
  "fruit.js",
  "executive.js",
  "states.js",
  "input.js",
  "cutscenes.js",
  "maps.js",
  "vcr.js",
  "main.js",
];

// AI agent harness (agent/). Appended after the game files so it can use
// their definitions; it defines `pacmanAgent`. Order matters here too.
const agentOrder = [
  "01-config.js",
  "02-provider.js",
  "03-gamestate.js",
  "04-controller.js",
  "05-main.js",
  "06-ui.js",
];

const output = "pacman.js";

// Header written at the top of the bundle.
const header = `
// Copyright 2012 Shaun Williams
//
//  This program is free software: you can redistribute it and/or modify
//  it under the terms of the GNU General Public License Version 3 as
//  published by the Free Software Foundation.
//
//  This program is distributed in the hope that it will be useful,
//  but WITHOUT ANY WARRANTY; without even the implied warranty of
//  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//  GNU General Public License for more details.

// ==========================================================================
// PAC-MAN
// an accurate remake of the original arcade game

// Based on original works by Namco, GCC, and Midway.
// Research by Jamey Pittman and Bart Grantham
// Developed by Shaun Williams

// ==========================================================================

(function(){
`;

/** Formats a date like the default `date` output, e.g. "Sat Oct 11 14:41:26 PDT 2026". */
function dateStamp(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("month")} ${get("day").padStart(2, "0")} ${get("hour")}:${get("minute")}:${get("second")} ${get("timeZoneName")} ${get("year")}`;
}

// 1. build pacman.js by concatenating files in order
let bundle = `${header}\n`; // echo appends one extra newline after the header
const includes: string[] = [];
for (const file of jsOrder) {
  // points firebug to correct file
  bundle += `//@line 1 "src/${file}"\n`;
  bundle += await Deno.readTextFile(`src/${file}`);
  includes.push(`<script src="src/${file}"></script>`);
}
for (const file of agentOrder) {
  bundle += `//@line 1 "agent/${file}"\n`;
  bundle += await Deno.readTextFile(`agent/${file}`);
  includes.push(`<script src="agent/${file}"></script>`);
}
bundle += "})();\n";
await Deno.writeTextFile(output, bundle);

// 2. update time stamp in index.htm, keeping the previous version in index.htm.bak
//    (same effect as `sed -i '.bak'`)
const indexHtml = await Deno.readTextFile("index.htm");
await Deno.writeTextFile("index.htm.bak", indexHtml);
const updatedHtml = indexHtml.replace(
  /last updated:[^\n<]*/, // [^\n<] keeps the match on one line, like sed
  () => `last updated: ${dateStamp()} -->`,
);
await Deno.writeTextFile("index.htm", updatedHtml);

// 3. build debug.htm from index.htm, replacing the bundle include with
//    individual script includes
const debugHtml = updatedHtml.replace(
  /^.*pacman\.js.*$/m,
  () => `\n${includes.join("\n")}\n`,
);
await Deno.writeTextFile("debug.htm", debugHtml);

console.log(
  `built ${output} from ${jsOrder.length} src + ${agentOrder.length} agent files, updated index.htm, wrote debug.htm`,
);
