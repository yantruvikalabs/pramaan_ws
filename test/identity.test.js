/**
 * Working out who is signing in.
 *
 * The stakes here are higher than they look. If classifyIdentifier and the
 * CSV importer ever disagree about what a phone number is, a person imported
 * one way cannot sign in the other way — and the symptom is "the OTP never
 * arrived", which is indistinguishable from a network problem and would be
 * miserable to diagnose down a phone line.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIdentifier,
  normaliseEmail,
  maskDestination,
  lookupFor,
} from '../src/lib/identity.js';
import { normalisePhone } from '../src/lib/phone.js';

describe('classifyIdentifier', () => {
  test('recognises the phone forms a real payroll export contains', () => {
    for (const input of [
      '9876543210',
      '+91 98765 43210',
      '091-9876543210',
      '09876543210',
      '+919876543210',
      '(98765) 43210',
    ]) {
      const result = classifyIdentifier(input);
      assert.equal(result?.kind, 'PHONE', `${input} should be a phone`);
      assert.equal(result.value, '9876543210', `${input} should normalise`);
    }
  });

  test('login and import normalise a number identically', () => {
    // The whole reason lib/phone.js exists. If this ever fails, somebody has
    // reintroduced a second implementation.
    for (const input of ['091-9876543210', '+91 98765 43210', '09876543210']) {
      assert.equal(classifyIdentifier(input).value, normalisePhone(input));
    }
  });

  test('an email is an email whatever the case or padding', () => {
    const result = classifyIdentifier('  Admin@Contractor.CO.IN ');
    assert.equal(result.kind, 'EMAIL');
    assert.equal(result.value, 'admin@contractor.co.in');
  });

  test('anything else is an employee ID', () => {
    assert.deepEqual(classifyIdentifier('EMP-0001'), {
      kind: 'EMPLOYEE_ID',
      value: 'EMP-0001',
    });
    assert.deepEqual(classifyIdentifier(' emp/17 '), {
      kind: 'EMPLOYEE_ID',
      value: 'emp/17',
    });
  });

  test('a number that is not an Indian mobile is rejected, not guessed at', () => {
    // Crucially NOT treated as an employee ID: silently looking up "12345"
    // as an ID would make a typo behave like a different person's account.
    for (const input of ['12345', '5555555555', '98765432101', '+1 555 010 9999']) {
      assert.equal(classifyIdentifier(input), null, `${input} should be rejected`);
    }
  });

  test('empty and oversized input is rejected', () => {
    assert.equal(classifyIdentifier(''), null);
    assert.equal(classifyIdentifier('   '), null);
    assert.equal(classifyIdentifier('x'.repeat(256)), null);
    assert.equal(classifyIdentifier(null), null);
    assert.equal(classifyIdentifier(12345), null);
  });

  test('a malformed email is rejected rather than read as an employee ID', () => {
    for (const input of ['not-an-email@', '@nodomain.com', 'two@@at.com', 'a@b']) {
      assert.equal(classifyIdentifier(input), null, `${input} should be rejected`);
    }
  });
});

describe('normaliseEmail', () => {
  test('lowercases, so a login always matches what was imported', () => {
    assert.equal(normaliseEmail('A.B@Example.COM'), 'a.b@example.com');
  });

  test('accepts the unusual but valid', () => {
    assert.equal(normaliseEmail('first+tag@sub.domain.co.in'), 'first+tag@sub.domain.co.in');
  });
});

describe('lookupFor', () => {
  test('an email address is asked for by email, everything else by SMS', () => {
    assert.equal(lookupFor({ kind: 'EMAIL', value: 'a@b.com' }).channel, 'EMAIL');
    assert.equal(lookupFor({ kind: 'PHONE', value: '9876543210' }).channel, 'SMS');
    assert.equal(lookupFor({ kind: 'EMPLOYEE_ID', value: 'EMP-1' }).channel, 'SMS');
  });

  test('the column matches the kind', () => {
    assert.equal(lookupFor({ kind: 'EMAIL', value: 'a@b.com' }).column, 'email');
    assert.equal(lookupFor({ kind: 'PHONE', value: '9876543210' }).column, 'phone');
    assert.equal(lookupFor({ kind: 'EMPLOYEE_ID', value: 'X' }).column, 'employee_id');
  });
});

describe('maskDestination', () => {
  test('a phone number keeps only its last four digits', () => {
    const masked = maskDestination('SMS', '9876543210', null);
    assert.equal(masked, '••••••3210');
    assert.ok(!masked.includes('98765'), 'must not reveal the leading digits');
  });

  test('an email keeps two characters and the domain', () => {
    assert.equal(maskDestination('EMAIL', null, 'ramesh@site.com'), 'ra••••@site.com');
  });

  test('never returns something it was not given', () => {
    assert.equal(maskDestination('SMS', null, null), null);
    assert.equal(maskDestination('EMAIL', null, null), null);
  });
});
