'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseBytesStr, parseMemToMB } = require('../lib/container-stats')

test('parseBytesStr parses plain bytes', () => {
  assert.equal(parseBytesStr('512B'), 512)
})

test('parseBytesStr parses MiB with podman\'s "iB" suffix', () => {
  assert.equal(parseBytesStr('1.5MiB'), 1.5 * 1024 * 1024)
})

test('parseBytesStr parses GB', () => {
  assert.equal(parseBytesStr('2GB'), 2 * 1024 * 1024 * 1024)
})

test('parseBytesStr defaults to 0 for an unparseable string', () => {
  assert.equal(parseBytesStr('garbage'), 0)
})

test('parseBytesStr handles the bare number with no unit (treated as bytes)', () => {
  assert.equal(parseBytesStr('100'), 100)
})

test('parseMemToMB converts MiB input to MB-scale output consistently with parseBytesStr', () => {
  assert.equal(parseMemToMB('100MiB'), 100)
})

test('parseMemToMB converts GiB input to MB-scale output', () => {
  assert.equal(parseMemToMB('1GiB'), 1024)
})
