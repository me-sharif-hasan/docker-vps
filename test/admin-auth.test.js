'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { checkAdminKey } = require('../lib/admin-auth')

function fakeReply() {
  const calls = []
  return {
    calls,
    code(c) { calls.push({ code: c }); return this },
    send(body) { calls.push({ send: body }); return this }
  }
}

test('checkAdminKey allows everything when ADMIN_KEY is unset (dev mode)', () => {
  delete process.env.ADMIN_KEY
  const reply = fakeReply()
  const result = checkAdminKey({ headers: {}, query: {} }, reply)
  assert.equal(result, undefined)
  assert.equal(reply.calls.length, 0)
})

test('checkAdminKey accepts a matching header key', () => {
  process.env.ADMIN_KEY = 'secret123'
  const reply = fakeReply()
  const result = checkAdminKey({ headers: { 'x-admin-key': 'secret123' }, query: {} }, reply)
  assert.equal(result, undefined)
  assert.equal(reply.calls.length, 0)
  delete process.env.ADMIN_KEY
})

test('checkAdminKey accepts a matching query key', () => {
  process.env.ADMIN_KEY = 'secret123'
  const reply = fakeReply()
  const result = checkAdminKey({ headers: {}, query: { key: 'secret123' } }, reply)
  assert.equal(result, undefined)
  delete process.env.ADMIN_KEY
})

test('checkAdminKey rejects a wrong key with 401 and returns false', () => {
  process.env.ADMIN_KEY = 'secret123'
  const reply = fakeReply()
  const result = checkAdminKey({ headers: {}, query: { key: 'wrong' } }, reply)
  assert.equal(result, false)
  assert.deepEqual(reply.calls[0], { code: 401 })
  assert.deepEqual(reply.calls[1], { send: { success: false, error: 'Unauthorized' } })
  delete process.env.ADMIN_KEY
})
