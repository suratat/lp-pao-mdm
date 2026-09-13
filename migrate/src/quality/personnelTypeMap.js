const map = require('../../config/personnel-type-map.json');

function mapPersonnelType(raw) {
  if (!raw) return null;
  const key = raw.trim();
  return map[key] ?? null;
}

module.exports = { mapPersonnelType };
