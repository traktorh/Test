const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const output = path.join(root, "dist");

fs.mkdirSync(output, { recursive: true });

for (const file of ["index.html", "styles.css", "app-local.js", "images"]) {
  fs.cpSync(path.join(root, file), path.join(output, file), { recursive: true });
}

console.log("Static site built in dist/");
