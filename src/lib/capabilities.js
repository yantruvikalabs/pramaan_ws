/**
 * What a role is allowed to do.
 *
 * This is the single source of truth for both clients. FRD BR-ROL-3: a
 * section a role is not entitled to is ABSENT from the screen, not greyed
 * out — so this object is the whole story and the clients render exactly
 * what is in it.
 *
 * Pure: no framework, no database, no request. It is imported by the API,
 * asserted by test/capabilities.test.js, and its key names are a contract
 * with apps/mobile and apps/web. Renaming a key here silently removes a
 * feature from every client, so the test pins the key set deliberately.
 */

import { ROLE, roleAtLeast, WEB_ROLES, TEAM_ROLES } from './vocabulary.js';

export function capabilitiesFor(role) {
  return {
    markOwnAttendance: true,          // everyone, always. FRD §2.1
    seeTeam: TEAM_ROLES.includes(role),
    manageTeam: TEAM_ROLES.includes(role),
    manageShifts: TEAM_ROLES.includes(role),
    recordLeave: TEAM_ROLES.includes(role),
    seeAllEmployees: roleAtLeast(role, ROLE.ADMIN),
    importEmployees: roleAtLeast(role, ROLE.ADMIN),
    manageRoles: roleAtLeast(role, ROLE.SUPER_ADMIN),
    webPortal: WEB_ROLES.includes(role),
  };
}
