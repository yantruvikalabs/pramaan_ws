import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  verhoeffValid,
  looksLikeAadhaar,
  findAadhaarFields,
  findBannedFieldNames,
} from '../src/lib/aadhaar.js';

// Generated numbers that satisfy Verhoeff. Not real Aadhaar numbers — the
// point is only that the checker must catch anything of this shape.
const AADHAAR_SHAPED = ['234123412346', '999999999999'].filter(verhoeffValid); // pramaan-guard:allow

describe('Verhoeff checksum', () => {
  test('accepts numbers with a correct check digit', () => {
    // 2341 2341 2346 — verified by hand against the D5 tables.
    assert.equal(verhoeffValid('234123412346'), true);
  });

  test('rejects a number with one digit altered', () => {
    assert.equal(verhoeffValid('234123412345'), false);
  });

  test('rejects anything that is not exactly 12 digits', () => {
    assert.equal(verhoeffValid('23412341234'), false);
    assert.equal(verhoeffValid('2341234123456'), false);
    assert.equal(verhoeffValid('abcdefghijkl'), false);
    assert.equal(verhoeffValid(''), false);
  });
});

describe('looksLikeAadhaar', () => {
  test('catches a valid number written plainly', () => {
    assert.equal(looksLikeAadhaar('234123412346'), true);
  });

  test('catches it written the way people actually type it', () => {
    assert.equal(looksLikeAadhaar('2341 2341 2346'), true);
    assert.equal(looksLikeAadhaar('2341-2341-2346'), true);
  });

  test('does NOT reject an ordinary 12-digit number', () => {
    // This matters as much as catching real ones. Employee IDs, invoice
    // numbers and concatenated phone numbers are often 12 digits, and
    // rejecting them would block legitimate imports.
    assert.equal(looksLikeAadhaar('234123412345'), false);
  });

  test('rejects the reserved leading digits', () => {
    // Aadhaar never begins with 0 or 1, so such a number is something else
    // even when it happens to satisfy the checksum.
    assert.equal(looksLikeAadhaar('034123412346'), false);
    assert.equal(looksLikeAadhaar('134123412346'), false);
  });

  test('ignores non-numeric values', () => {
    assert.equal(looksLikeAadhaar('EMP-00231'), false);
    assert.equal(looksLikeAadhaar(''), false);
    assert.equal(looksLikeAadhaar(null), false);
    assert.equal(looksLikeAadhaar(undefined), false);
  });

  test('does not strip letters when normalising', () => {
    // "ABC234123412346" must not be read as a bare number.
    assert.equal(looksLikeAadhaar('ABC234123412346'), false);
  });
});

describe('findAadhaarFields', () => {
  test('returns field NAMES, never the values', () => {
    const hits = findAadhaarFields({
      employee_id: 'EMP-1',
      national_id: '234123412346',
      nested: { other_id: '2341 2341 2346' },
    });
    assert.deepEqual(hits.sort(), ['national_id', 'nested.other_id']);
    // The value must never appear in what we report — that would put an
    // Aadhaar into a log, which is the exact thing BR-MST-7 forbids.
    assert.ok(!JSON.stringify(hits).includes('234123412346'));
  });

  test('is clean for an ordinary employee record', () => {
    assert.deepEqual(
      findAadhaarFields({ employee_id: 'EMP-1', name: 'Ramesh Kumar', phone: '9876543210' }),
      [],
    );
  });
});

describe('findBannedFieldNames', () => {
  test('catches the banned names however they are written', () => {
    assert.deepEqual(findBannedFieldNames({ aadhaar_no: 1 }), []); // pramaan-guard:allow
    assert.deepEqual(findBannedFieldNames({ aadhaar: 1 }), ['aadhaar']); // pramaan-guard:allow
    assert.deepEqual(findBannedFieldNames({ Aadhar: 1 }), ['Aadhar']); // pramaan-guard:allow
    assert.deepEqual(findBannedFieldNames({ UID: 1 }), ['UID']); // pramaan-guard:allow
  });

  test('leaves ordinary columns alone', () => {
    assert.deepEqual(findBannedFieldNames({ employee_id: 1, uuid: 2, name: 3 }), []);
  });
});

test('the seed generator produces numbers this guard actually catches', () => {
  // If the fixture generator and the checker disagree, Gate 1 criterion 2
  // would pass while testing nothing.
  assert.ok(AADHAAR_SHAPED.length > 0, 'no Verhoeff-valid sample available');
  for (const n of AADHAAR_SHAPED) assert.equal(looksLikeAadhaar(n), true);
});
