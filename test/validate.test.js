'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { isValidUuid } = require('../validate')

test('isValidUuid accepts a well-formed v4 uuid', () => {
  assert.equal(isValidUuid('f47ac10b-58cc-4372-a567-0e02b2c3d479'), true)
})

test('isValidUuid rejects a v1 uuid (wrong version nibble)', () => {
  assert.equal(isValidUuid('f47ac10b-58cc-1372-a567-0e02b2c3d479'), false)
})

test('isValidUuid rejects a non-string', () => {
  assert.equal(isValidUuid(12345), false)
  assert.equal(isValidUuid(null), false)
  assert.equal(isValidUuid(undefined), false)
})

test('isValidUuid rejects malformed strings', () => {
  assert.equal(isValidUuid('not-a-uuid'), false)
  assert.equal(isValidUuid(''), false)
  assert.equal(isValidUuid('f47ac10b-58cc-4372-a567-0e02b2c3d47'), false) // too short
})
