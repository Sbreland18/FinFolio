#!/usr/bin/env node
'use strict';
/**
 * Syntax-checks every source file and verifies that each ES module import
 * actually resolves on disk. Catches the two most common ways a renderer
 * breaks: a typo in a path, and a stray character in a file that only runs on
 * one screen.
 *
 *   npm run check
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const targets = [];

/**
 * A UTF-8 byte-order mark at the start of package.json breaks the build.
 * Node's `require` quietly strips one, so tests pass and only electron-builder
 * — which reads the file and calls JSON.parse itself — fails, with the unhelpful
 * "Unexpected token '﻿'". Some Windows editors and PowerShell's
 * Set-Content add it. Strip it here, before anything downstream trips over it.
 */
function repairByteOrderMarks() {
  const repaired = [];
  const candidates = ['package.json', 'package-lock.json', 'electron-builder.yml'];
  for (const name of candidates) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const buffer = fs.readFileSync(file);
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      fs.writeFileSync(file, buffer.subarray(3));
      repaired.push(name);
    }
  }
  return repaired;
}

const repairedFiles = repairByteOrderMarks();
for (const name of repairedFiles) {
  console.log(`• removed a byte-order mark from ${name} (it breaks electron-builder)`);
}

walk(path.join(root, 'src'));
walk(path.join(root, 'scripts'));

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      targets.push(full);
    }
  }
}

let failures = 0;
let checked = 0;

for (const file of targets) {
  const rel = path.relative(root, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    checked += 1;
  } catch (err) {
    failures += 1;
    const out = `${err.stdout || ''}${err.stderr || ''}`.trim();
    console.error(`\n✗ ${rel}\n${out}\n`);
  }
}

// Verify relative imports resolve.
const importRe = /(?:^|\n)\s*(?:import|export)[^'"]*from\s*['"](\.[^'"]+)['"]/g;
const dynamicRe = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
for (const file of targets) {
  const text = fs.readFileSync(file, 'utf8');
  for (const re of [importRe, dynamicRe]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const resolved = path.resolve(path.dirname(file), m[1]);
      if (!fs.existsSync(resolved)) {
        failures += 1;
        console.error(`✗ ${path.relative(root, file)} → missing import "${m[1]}"`);
      }
    }
  }
}

// Verify the renderer's stylesheets and entry script exist.
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:href|src)="([^":]+)"/g)) {
  const target = path.join(root, 'src', 'renderer', m[1]);
  if (!fs.existsSync(target)) {
    failures += 1;
    console.error(`✗ index.html → missing asset "${m[1]}"`);
  }
}

// The packager parses these itself, so prove they are readable the same way.
for (const name of ['package.json', 'package-lock.json']) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    failures += 1;
    console.error(`✗ ${name} is not valid JSON: ${err.message}`);
  }
}

// The version in package.json and package-lock.json must agree, or `npm ci`
// (which the release workflow uses) refuses to install.
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lockPath = path.join(root, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const lockVersion = lock.version || (lock.packages && lock.packages[''] && lock.packages[''].version);
    if (lockVersion && lockVersion !== pkg.version) {
      console.log(`• package-lock.json says ${lockVersion}, package.json says ${pkg.version} — run "npm install --package-lock-only" before publishing`);
    }
  }
} catch {
  /* already reported above */
}

if (failures) {
  console.error(`\n${failures} problem${failures === 1 ? '' : 's'} found in ${targets.length} files.`);
  process.exit(1);
}
console.log(`✓ ${checked} files parsed, all imports and assets resolve.`);
