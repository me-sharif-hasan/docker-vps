'use strict'

// Simple UUID v4 format validator
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidUuid(str) {
  return typeof str === 'string' && UUID_REGEX.test(str)
}

module.exports = { isValidUuid }
