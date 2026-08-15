/**
 * Reading employees.
 *
 * One place, because `_id` IS `employee_id` and nothing outside this file
 * should have to know that. Every caller keeps working with `employee_id`
 * exactly as it did against MySQL — middleware, routes, the JWT `sub` claim and
 * the import all stay unchanged.
 */

import { col } from '../db/mongo.js';

/**
 * A stored document → the shape every caller already expects.
 *
 * `_id` is REMOVED, not just aliased. Spreading the document and adding
 * `employee_id` alongside leaves both in every API response — the storage key
 * leaking into the public contract, where clients would eventually start
 * reading it and the field could never be changed again. The mobile and web
 * apps know about `employee_id`; `_id` is nobody's business but this layer's.
 */
export const toEmployee = (d) => {
  if (!d) return null;
  const { _id, ...rest } = d;
  return { employee_id: _id, ...rest };
};

export async function getEmployee(employeeId) {
  if (!employeeId) return null;
  return toEmployee(await col('employees').findOne({ _id: employeeId }));
}

export async function getEmployees(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const rows = await col('employees').find({ _id: { $in: unique } }).toArray();
  return rows.map(toEmployee);
}

/**
 * Find one employee by any of the three login identifiers.
 *
 * `email` is matched only when a string was given: the field is null for most
 * of the workforce, and `{ email: null }` would match every one of them.
 */
export async function findByIdentifier({ employeeId = null, phone = null, email = null }) {
  const or = [];
  if (employeeId) or.push({ _id: employeeId });
  if (phone) or.push({ phone });
  if (email) or.push({ email });
  if (or.length === 0) return null;
  return toEmployee(await col('employees').findOne({ $or: or }));
}
