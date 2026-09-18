'use strict';
const config = require('./runtime-bindings.json');
function credential(key) {
  const ref = config.credentials[key];
  if (!ref?.id || !ref?.name) {
    throw new Error(`Missing ${key}: save its credential in n8n and record its ID/name in cbm/app/runtime-bindings.json.`);
  }
  return structuredClone(ref);
}
module.exports = {config, credential};
