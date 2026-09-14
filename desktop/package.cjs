const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
async function build() {
  const { packager } = await import('@electron/packager');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pricescan-desktop-build-'));
  for (const file of fs.readdirSync(__dirname)) {
    if (/\.(cjs|html|css|js|json)$/.test(file) && file !== 'package-lock.json') fs.copyFileSync(path.join(__dirname, file), path.join(stage, file));
  }
  fs.copyFileSync(path.join(__dirname, '../extensions/pricescan-collector/background.js'), path.join(stage, 'bundled-collector.cjs'));
  const output = path.join(__dirname, '../artifacts/pricescan-desktop', new Date().toISOString().replace(/[:.]/g, '-'));
  const paths = await packager({ dir: stage, name: 'PriceScan Desktop', appBundleId: 'com.d2blue.pricescan.desktop', platform: 'darwin', arch: process.arch,
    electronVersion: require('./package.json').devDependencies.electron, out: output, asar: true, prune: true });
  for (const directory of paths) {
    const bundle = path.join(directory, 'PriceScan Desktop.app');
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', bundle], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
    fs.writeFileSync(path.join(directory, '.pricescan-ready'), 'local-development-ad-hoc-signature\n');
  }
  console.log(paths.join('\n'));
}
build().catch(error => { console.error(error.message); process.exitCode = 1; });
