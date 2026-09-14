// Packaged builds copy this same source into bundled-collector.cjs.
const fs = require('node:fs');
const path = require('node:path');
const bundled = path.join(__dirname, 'bundled-collector.cjs');
module.exports = require(fs.existsSync(bundled) ? bundled : '../extensions/pricescan-collector/background.js');
