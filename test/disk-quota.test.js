'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { usedProjectIds, nextProjectId } = require('../lib/disk-quota')
const { PROJECT_ID_BASE, MAX_CONCURRENT } = require('../lib/constants')

test.afterEach(() => {
  usedProjectIds.clear()
})

test('nextProjectId hands out sequential ids starting at the base', () => {
  assert.equal(nextProjectId(), PROJECT_ID_BASE)
  assert.equal(nextProjectId(), PROJECT_ID_BASE + 1)
  assert.equal(nextProjectId(), PROJECT_ID_BASE + 2)
})

test('nextProjectId reuses an id freed by the caller (usedProjectIds.delete)', () => {
  const first = nextProjectId()
  const second = nextProjectId()
  usedProjectIds.delete(first)
  assert.equal(nextProjectId(), first)
  assert.notEqual(second, first)
})

test('nextProjectId throws once the pool (2x MAX_CONCURRENT) is exhausted', () => {
  for (let i = 0; i < MAX_CONCURRENT * 2; i++) nextProjectId()
  assert.throws(() => nextProjectId(), /No available disk-quota project ids/)
})
