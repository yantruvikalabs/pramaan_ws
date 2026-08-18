/**
 * The capability contract.
 *
 * WHY THIS FILE EXISTS: the mobile app and the web app both branch on these
 * exact key names to decide which sections EXIST (FRD BR-ROL-3). They are
 * separate codebases that cannot import this object — the mobile app is
 * outside the npm workspace, and the web app runs in a browser.
 *
 * A rename here is therefore silent: the client reads `undefined`, treats it
 * as false, and the feature simply vanishes with no error anywhere. That
 * already happened once — the API returned `seeTeam` while the app checked
 * `seeOwnTeam`, so every senior lost their team list and nothing logged a
 * complaint.
 *
 * So the key set is pinned here. Renaming a capability now fails the build
 * and forces whoever renames it to go and update the clients listed below.
 *
 *   CONSUMERS — update these when this test changes:
 *     apps/mobile/src/screens/HomeScreen.js   capabilities.seeTeam
 *     apps/web/components/Shell.js            capabilities.webPortal
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor } from '../src/lib/capabilities.js';
import { ROLE } from '../src/lib/vocabulary.js';

const EXPECTED_KEYS = [
  'importEmployees',
  'manageRoles',
  'manageShifts',
  'manageTeam',
  'markOwnAttendance',
  'recordLeave',
  'seeAllEmployees',
  'seeTeam',
  'webPortal',
];

describe('capability contract', () => {
  test('the key set is exactly what the clients branch on', () => {
    for (const role of Object.values(ROLE)) {
      assert.deepEqual(
        Object.keys(capabilitiesFor(role)).sort(),
        EXPECTED_KEYS,
        `capability keys changed for ${role} — update the consumers named at the top of this file`,
      );
    }
  });

  test('every capability is a real boolean, never undefined', () => {
    // undefined is the failure mode this whole file exists to prevent: a
    // client reads it, treats it as false, and the feature disappears.
    for (const role of Object.values(ROLE)) {
      for (const [key, value] of Object.entries(capabilitiesFor(role))) {
        assert.equal(typeof value, 'boolean', `${role}.${key} is ${typeof value}, not boolean`);
      }
    }
  });
});

describe('who can do what — FRD §2.1', () => {
  test('every role marks their own attendance', () => {
    for (const role of Object.values(ROLE)) {
      assert.equal(capabilitiesFor(role).markOwnAttendance, true, role);
    }
  });

  test('an employee sees no team', () => {
    const c = capabilitiesFor(ROLE.EMPLOYEE);
    assert.equal(c.seeTeam, false);
    assert.equal(c.manageTeam, false);
    assert.equal(c.seeAllEmployees, false);
  });

  test('a senior sees and manages a team, but not the whole company', () => {
    const c = capabilitiesFor(ROLE.SENIOR);
    assert.equal(c.seeTeam, true);
    assert.equal(c.manageTeam, true);
    assert.equal(c.seeAllEmployees, false, 'a senior must never see the whole company (BR-ROL-4)');
    assert.equal(c.importEmployees, false);
  });

  test('an admin sees everyone and can import', () => {
    const c = capabilitiesFor(ROLE.ADMIN);
    assert.equal(c.seeAllEmployees, true);
    assert.equal(c.importEmployees, true);
    assert.equal(c.manageRoles, false, 'only a super admin manages roles');
  });

  test('only a super admin manages roles', () => {
    assert.equal(capabilitiesFor(ROLE.SUPER_ADMIN).manageRoles, true);
  });

  test('the web portal is for admins only — FRD BR-WEB-1', () => {
    assert.equal(capabilitiesFor(ROLE.EMPLOYEE).webPortal, false);
    assert.equal(capabilitiesFor(ROLE.SENIOR).webPortal, false,
      'a senior signing in to the web portal is a bug — their whole product is the app');
    assert.equal(capabilitiesFor(ROLE.ADMIN).webPortal, true);
    assert.equal(capabilitiesFor(ROLE.SUPER_ADMIN).webPortal, true);
  });

  test('an unknown role gets nothing but its own attendance', () => {
    const c = capabilitiesFor('NOT_A_ROLE');
    assert.equal(c.markOwnAttendance, true);
    for (const [key, value] of Object.entries(c)) {
      if (key === 'markOwnAttendance') continue;
      assert.equal(value, false, `unknown role was granted ${key}`);
    }
  });
});
