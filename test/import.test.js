import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEmployeeCsv, validateImport, normalisePhone, validateOneEmployee,
} from '../src/lib/import.js';

const HEADER = 'employee_id,name,phone,role,reports_to,language';

function run(csv, existingIds = new Set()) {
  const { headers, records } = parseEmployeeCsv(csv);
  return validateImport(records, headers, existingIds);
}

const rejectionFor = (result, line) => result.rejected.find((r) => r.line === line);

describe('normalisePhone', () => {
  test('accepts a plain 10-digit mobile', () => {
    assert.equal(normalisePhone('9876543210'), '9876543210');
  });

  test('strips the formatting people actually use', () => {
    assert.equal(normalisePhone('+91 98765 43210'), '9876543210');
    assert.equal(normalisePhone('091-9876543210'), '9876543210');
    assert.equal(normalisePhone('98765-43210'), '9876543210');
  });

  test('rejects landlines and short numbers', () => {
    assert.equal(normalisePhone('1234567890'), null); // must start 6–9
    assert.equal(normalisePhone('12345'), null);
    assert.equal(normalisePhone(''), null);
  });
});

describe('file-level rejection', () => {
  test('a file with an aadhaar COLUMN is refused entirely', () => {
    // FRD BR-MST-9. If the column exists, no row in the file is safe.
    const result = run(`employee_id,name,phone,role,aadhaar\nEMP-1,A,9876543210,EMPLOYEE,x\n`);
    assert.ok(result.fileError);
    assert.match(result.fileError, /Aadhaar/);
    assert.equal(result.accepted.length, 0);
  });

  test('a missing required column is refused with the names', () => {
    const result = run(`employee_id,name\nEMP-1,A\n`);
    assert.ok(result.fileError);
    assert.match(result.fileError, /phone/);
    assert.match(result.fileError, /role/);
  });

  test('an unknown extra column is a warning, not a failure', () => {
    const result = run(`${HEADER},department\nEMP-1,A,9876543210,EMPLOYEE,,hi,Housekeeping\n`);
    assert.equal(result.fileError, null);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.warnings.length, 1);
  });
});

describe('row-level rejection — FRD BR-MST-1', () => {
  test('one bad row does not fail the batch', () => {
    const result = run(
      `${HEADER}\n` +
      `EMP-1,Ramesh,9876543210,EMPLOYEE,,hi\n` +
      `,Missing Id,9876543211,EMPLOYEE,,hi\n` +
      `EMP-3,Suresh,9876543212,EMPLOYEE,,hi\n`,
    );
    assert.equal(result.fileError, null);
    assert.equal(result.accepted.length, 2);
    assert.equal(result.rejected.length, 1);
  });

  test('every rejection carries a line number and a readable reason', () => {
    const result = run(`${HEADER}\n,Missing Id,9876543210,EMPLOYEE,,hi\n`);
    const bad = rejectionFor(result, 2);
    assert.ok(bad, 'expected a rejection on line 2');
    assert.equal(typeof bad.errors[0], 'string');
    assert.ok(bad.errors[0].length > 5, 'reason must be readable, not a code');
  });

  test('reports each distinct problem', () => {
    const result = run(
      `${HEADER}\n` +
      `EMP-1,,9876543210,EMPLOYEE,,hi\n` +          // no name
      `EMP-2,Suresh,12345,EMPLOYEE,,hi\n` +         // bad phone
      `EMP-3,Anil,9876543212,MANAGER,,hi\n` +       // bad role
      `EMP-4,Mohan,9876543213,EMPLOYEE,,fr\n`,      // bad language
    );
    assert.equal(result.rejected.length, 4);
    assert.match(rejectionFor(result, 2).errors[0], /name/);
    assert.match(rejectionFor(result, 3).errors[0], /phone/);
    assert.match(rejectionFor(result, 4).errors[0], /role/);
    assert.match(rejectionFor(result, 5).errors[0], /language/);
  });

  test('a duplicate id is rejected and points at the first use', () => {
    const result = run(
      `${HEADER}\n` +
      `EMP-1,Ramesh,9876543210,EMPLOYEE,,hi\n` +
      `EMP-1,Suresh,9876543211,EMPLOYEE,,hi\n`,
    );
    assert.equal(result.accepted.length, 1);
    assert.match(rejectionFor(result, 3).errors[0], /line 2/);
  });
});

describe('Aadhaar in a value — Gate 1 criterion 2', () => {
  test('a row containing a valid Aadhaar is rejected, not stored', () => {
    const result = run(`${HEADER}\nEMP-1,Ramesh,9876543210,EMPLOYEE,,hi\n` +
                       `234123412346,Suresh,9876543211,EMPLOYEE,,hi\n`);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].employee_id, 'EMP-1');
    assert.match(rejectionFor(result, 3).errors[0], /Aadhaar/);
  });

  test('it is caught in any column, not only the id', () => {
    const result = run(`${HEADER}\nEMP-1,2341 2341 2346,9876543210,EMPLOYEE,,hi\n`);
    assert.equal(result.accepted.length, 0);
    assert.match(rejectionFor(result, 2).errors[0], /Aadhaar/);
  });

  test('the rejection message never echoes the number back', () => {
    // Reporting the value would write an Aadhaar to a log — the exact thing
    // BR-MST-7 forbids. The message names the COLUMN only.
    const result = run(`${HEADER}\n234123412346,Ramesh,9876543210,EMPLOYEE,,hi\n`);
    const message = JSON.stringify(result.rejected);
    assert.ok(!message.includes('234123412346'), 'the number leaked into the rejection');
  });

  test('an ordinary 12-digit employee id is still accepted', () => {
    const result = run(`${HEADER}\n234123412345,Ramesh,9876543210,EMPLOYEE,,hi\n`);
    assert.equal(result.accepted.length, 1);
  });
});

describe('the reporting tree — Gate 1 criterion 4', () => {
  test('reports_to may point further down the same file', () => {
    const result = run(
      `${HEADER}\n` +
      `EMP-1,Ramesh,9876543210,EMPLOYEE,EMP-2,hi\n` +
      `EMP-2,Suresh,9876543211,SENIOR,,hi\n`,
    );
    assert.equal(result.accepted.length, 2);
    assert.equal(result.rejected.length, 0);
  });

  test('reports_to may point at somebody already in the database', () => {
    const result = run(
      `${HEADER}\nEMP-1,Ramesh,9876543210,EMPLOYEE,EXISTING-1,hi\n`,
      new Set(['EXISTING-1']),
    );
    assert.equal(result.accepted.length, 1);
  });

  test('a senior who exists nowhere rejects that row, by name', () => {
    const result = run(`${HEADER}\nEMP-1,Ramesh,9876543210,EMPLOYEE,GHOST,hi\n`);
    assert.equal(result.accepted.length, 0);
    assert.match(rejectionFor(result, 2).errors[0], /GHOST/);
  });

  test('a deliberate cycle rejects every member and shows the loop', () => {
    const result = run(
      `${HEADER}\n` +
      `EMP-1,A,9876543210,SENIOR,EMP-2,hi\n` +
      `EMP-2,B,9876543211,SENIOR,EMP-3,hi\n` +
      `EMP-3,C,9876543212,SENIOR,EMP-1,hi\n`,
    );
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.length, 3);
    assert.match(rejectionFor(result, 2).errors[0], /loop/i);
    assert.match(rejectionFor(result, 2).errors[0], /EMP-1.*EMP-2.*EMP-3|EMP-2.*EMP-3.*EMP-1/);
  });

  test('self-reporting is rejected', () => {
    const result = run(`${HEADER}\nEMP-1,Ramesh,9876543210,EMPLOYEE,EMP-1,hi\n`);
    assert.equal(result.accepted.length, 0);
    assert.match(rejectionFor(result, 2).errors[0], /themselves/);
  });

  test('a cycle does not take down the valid rows around it', () => {
    const result = run(
      `${HEADER}\n` +
      `EMP-1,Good,9876543210,SENIOR,,hi\n` +
      `EMP-2,Also Good,9876543211,EMPLOYEE,EMP-1,hi\n` +
      `EMP-8,Loop A,9876543212,SENIOR,EMP-9,hi\n` +
      `EMP-9,Loop B,9876543213,SENIOR,EMP-8,hi\n`,
    );
    assert.equal(result.accepted.length, 2);
    assert.equal(result.rejected.length, 2);
  });
});

describe('defaults and normalisation', () => {
  test('language defaults to Hindi', () => {
    const result = run(`employee_id,name,phone,role\nEMP-1,Ramesh,9876543210,EMPLOYEE\n`);
    assert.equal(result.accepted[0].language, 'hi');
  });

  test('new employees start pending enrolment', () => {
    const result = run(`${HEADER}\nEMP-1,Ramesh,9876543210,EMPLOYEE,,hi\n`);
    assert.equal(result.accepted[0].status, 'ENROLMENT_PENDING');
  });

  test('headers are matched loosely — real files have caps and spaces', () => {
    const result = run(`Employee ID,Name,Phone,Role\nEMP-1,Ramesh,9876543210,employee\n`);
    assert.equal(result.fileError, null);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].role, 'EMPLOYEE');
  });
});

describe('scale — Gate 1 criterion 1', () => {
  test('2,000 clean rows all import', () => {
    const rows = [];
    for (let i = 1; i <= 2000; i++) {
      rows.push(`EMP-${String(i).padStart(4, '0')},Name ${i},${6000000000 + i},EMPLOYEE,,hi`);
    }
    const result = run(`${HEADER}\n${rows.join('\n')}\n`);
    assert.equal(result.fileError, null);
    assert.equal(result.accepted.length, 2000);
    assert.equal(result.rejected.length, 0);
  });

  test('2,000 rows with scattered faults report every bad line', () => {
    const rows = [];
    const badLines = new Set();
    for (let i = 1; i <= 2000; i++) {
      if (i % 250 === 0) {
        rows.push(`EMP-${String(i).padStart(4, '0')},Name ${i},BADPHONE,EMPLOYEE,,hi`);
        badLines.add(i + 1);
      } else {
        rows.push(`EMP-${String(i).padStart(4, '0')},Name ${i},${6000000000 + i},EMPLOYEE,,hi`);
      }
    }
    const result = run(`${HEADER}\n${rows.join('\n')}\n`);
    assert.equal(result.accepted.length, 1992);
    assert.equal(result.rejected.length, 8);
    for (const line of badLines) {
      assert.ok(rejectionFor(result, line), `line ${line} should have been reported`);
    }
  });
});

// ── Phone and email as login identifiers ───────────────────────────────────
// Phone became UNIQUE when it became something you can sign in with: an
// ambiguous identifier is not an identifier. Email is optional forever —
// most of a cleaning or catering workforce has no address — but where it
// exists it must be valid and belong to exactly one person.

const HEADER_E = 'employee_id,name,phone,email,role,reports_to,language';

function runE(csv, existing = new Set()) {
  const { headers, records } = parseEmployeeCsv(csv);
  return validateImport(records, headers, existing);
}

describe('one number, one person', () => {
  test('two rows sharing a phone: the second is rejected, naming the first line', () => {
    const result = runE([HEADER_E,
      'EMP-1,Ramesh,9876543210,,EMPLOYEE,,hi',
      'EMP-2,Suresh,9876543210,,EMPLOYEE,,hi',
    ].join('\n'));

    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].employee_id, 'EMP-1');
    const r = rejectionFor(result, 3);
    assert.ok(r.errors.some((e) => /Duplicate phone number/.test(e)));
    assert.ok(r.errors.some((e) => /line 2/.test(e)), 'must point at the row that has it');
  });

  test('the same number in a different format is still the same number', () => {
    const result = runE([HEADER_E,
      'EMP-1,Ramesh,9876543210,,EMPLOYEE,,hi',
      'EMP-2,Suresh,+91 98765 43210,,EMPLOYEE,,hi',
    ].join('\n'));
    assert.equal(result.accepted.length, 1, 'formatting must not defeat the check');
  });

  test('a number held by somebody already in the database names them', () => {
    const result = runE(
      [HEADER_E, 'EMP-2,Suresh,9876543210,,EMPLOYEE,,hi'].join('\n'),
      { ids: new Set(['EMP-1']), phones: new Map([['9876543210', 'EMP-1']]) },
    );
    assert.ok(rejectionFor(result, 2).errors.some((e) => /already belongs to employee "EMP-1"/.test(e)));
  });

  test('re-importing the SAME employee with their own number is not a clash', () => {
    // BR-MST-2: re-importing an existing employee updates them. Treating
    // their own phone as a duplicate would make every re-import fail.
    const result = runE(
      [HEADER_E, 'EMP-1,Ramesh Kumar,9876543210,,EMPLOYEE,,hi'].join('\n'),
      { ids: new Set(['EMP-1']), phones: new Map([['9876543210', 'EMP-1']]) },
    );
    assert.equal(result.rejected.length, 0);
    assert.equal(result.accepted.length, 1);
  });
});

describe('email is optional, but never ambiguous', () => {
  test('a blank email is accepted and stored as null', () => {
    const result = runE([HEADER_E, 'EMP-1,Ramesh,9876543210,,EMPLOYEE,,hi'].join('\n'));
    assert.equal(result.rejected.length, 0);
    assert.equal(result.accepted[0].email, null);
  });

  test('a file with no email column at all still imports', () => {
    const result = run([HEADER, 'EMP-1,Ramesh,9876543210,EMPLOYEE,,hi'].join('\n'));
    assert.equal(result.rejected.length, 0);
    assert.equal(result.accepted[0].email, null);
  });

  test('a malformed address is rejected', () => {
    const result = runE([HEADER_E, 'EMP-1,Ramesh,9876543210,not-an-email,EMPLOYEE,,hi'].join('\n'));
    assert.ok(rejectionFor(result, 2).errors.some((e) => /not a valid email/.test(e)));
  });

  test('it is stored lowercased, so a login matches whatever the user types', () => {
    const result = runE([HEADER_E, 'EMP-1,Ramesh,9876543210,Ramesh@Site.COM,SENIOR,,hi'].join('\n'));
    assert.equal(result.accepted[0].email, 'ramesh@site.com');
  });

  test('two people cannot share an address, in the file or in the database', () => {
    const inFile = runE([HEADER_E,
      'EMP-1,Ramesh,9876543210,a@b.com,SENIOR,,hi',
      'EMP-2,Suresh,9876543211,A@B.com,SENIOR,,hi',
    ].join('\n'));
    assert.ok(rejectionFor(inFile, 3).errors.some((e) => /Duplicate email/.test(e)));

    const inDb = runE(
      [HEADER_E, 'EMP-2,Suresh,9876543211,a@b.com,SENIOR,,hi'].join('\n'),
      { ids: new Set(['EMP-1']), emails: new Map([['a@b.com', 'EMP-1']]) },
    );
    assert.ok(rejectionFor(inDb, 2).errors.some((e) => /already belongs to employee "EMP-1"/.test(e)));
  });
});

// ── Adding one person by hand ──────────────────────────────────────────────
// FR-MST-003. A contractor imports their payroll list once; after that people
// join one at a time. The point of these tests is that the FORM and the CSV
// agree — one validation implementation, not two sets of rules an admin has
// to learn separately.

describe('validateOneEmployee', () => {
  const good = {
    employee_id: 'EMP-5000',
    name: 'Sunita Devi',
    phone: '9876543210',
    role: 'EMPLOYEE',
    reports_to: 'EMP-0006',
    language: 'hi',
  };
  const withSenior = { ids: new Set(['EMP-0006']) };

  test('accepts a complete, valid employee', () => {
    const r = validateOneEmployee(good, withSenior);
    assert.equal(r.ok, true);
    assert.equal(r.employee.employee_id, 'EMP-5000');
    assert.equal(r.employee.status, 'ENROLMENT_PENDING');
  });

  test('a new employee always starts unenrolled — nobody is enrolled by a form', () => {
    // Enrolment is a face capture on a phone (Phase 4), never something an
    // administrator can assert on somebody's behalf from a web page.
    assert.equal(validateOneEmployee(good, withSenior).employee.status, 'ENROLMENT_PENDING');
  });

  test('reports every problem at once, not one per attempt', () => {
    const r = validateOneEmployee(
      { employee_id: '', name: '', phone: '123', role: 'MANAGER' },
      withSenior,
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 4, `expected several errors, got ${r.errors.length}`);
  });

  test('a senior who does not exist is refused, without mentioning a file', () => {
    // A form has no file. "not in this file or in the system" is a message
    // the reader has to translate, which means it failed. FRD UI-4.
    const r = validateOneEmployee({ ...good, reports_to: 'EMP-NOBODY' }, withSenior);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /is not an employee in the system/.test(e)));
    assert.ok(!r.errors.some((e) => /file/i.test(e)), 'a form must not talk about files');
  });

  test('nobody can report to themselves', () => {
    const r = validateOneEmployee({ ...good, reports_to: 'EMP-5000' }, withSenior);
    assert.equal(r.ok, false);
  });

  test('the form enforces the SAME identifier rules as the CSV', () => {
    const existing = {
      ids: new Set(['EMP-0006', 'EMP-1']),
      phones: new Map([['9876543210', 'EMP-1']]),
      emails: new Map([['taken@site.com', 'EMP-1']]),
    };

    const dupPhone = validateOneEmployee(good, existing);
    assert.equal(dupPhone.ok, false);
    assert.ok(dupPhone.errors.some((e) => /already belongs to employee "EMP-1"/.test(e)));

    const dupEmail = validateOneEmployee(
      { ...good, phone: '9876543211', email: 'Taken@Site.com' }, existing,
    );
    assert.equal(dupEmail.ok, false);
    assert.ok(dupEmail.errors.some((e) => /already belongs to employee "EMP-1"/.test(e)));
  });

  test('an Aadhaar in any field is refused, and never echoed back', () => {
    // 999999990019 satisfies Verhoeff. It must not appear in the response.
    const r = validateOneEmployee({ ...good, employee_id: '999999990019' }, withSenior);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /Aadhaar/i.test(e)));
    assert.ok(!JSON.stringify(r).includes('999999990019'), 'the number leaked into the response');
  });

  test('email is optional for a worker who has none', () => {
    const r = validateOneEmployee({ ...good, email: '' }, withSenior);
    assert.equal(r.ok, true);
    assert.equal(r.employee.email, null);
  });
});
