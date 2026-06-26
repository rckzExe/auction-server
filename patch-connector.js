// postinstall patch — fixes tiktok-live-connector crash at index.js:278
// The library reads `response.status` where response can be undefined
// when TikTok returns no body. We patch the file to add a null check.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'node_modules', 'tiktok-live-connector', 'dist', 'index.js');

if (!fs.existsSync(filePath)) {
  console.log('⚠️ patch-connector: library not found, skipping');
  process.exit(0);
}

let src = fs.readFileSync(filePath, 'utf8');

// The crash: something like `if (response.status !== 200)`
// Patch: add a guard so undefined response doesn't crash
const patches = [
  // Pattern 1: direct .status read after await
  {
    find: /if\s*\(\s*response\.status/g,
    replace: 'if (response && response.status'
  },
  // Pattern 2: response.status in any expression
  {
    find: /response\.status\s*!==\s*200/g,
    replace: '(response && response.status !== 200)'
  },
  {
    find: /response\.status\s*===\s*200/g,
    replace: '(response && response.status === 200)'
  },
  // Pattern 3: destructuring or chaining after response
  {
    find: /const\s*\{\s*status\s*\}\s*=\s*response/g,
    replace: 'const { status } = (response || {})'
  }
];

let changed = false;
patches.forEach(({ find, replace }) => {
  const newSrc = src.replace(find, replace);
  if (newSrc !== src) {
    console.log('✅ patch-connector: applied patch for:', find.toString().slice(0,50));
    src = newSrc;
    changed = true;
  }
});

if (changed) {
  fs.writeFileSync(filePath, src);
  console.log('✅ patch-connector: tiktok-live-connector patched successfully');
} else {
  console.log('ℹ️ patch-connector: no patches needed (library may already be fixed)');
}
