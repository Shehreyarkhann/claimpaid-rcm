// athena-shape-test.cjs — deploy #44: athenaOne list-response unwrapping.
// The Preview sandbox taught us /departments returns { departments: [...] },
// not a bare array ("(departments || []).map is not a function" in prod).
// listOf() must handle every shape athenaOne uses.
'use strict';
const athena = require('../server/src/ehr/athenahealth');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

check('bare array passes through', athena.listOf([{ departmentid: 1 }], 'departments').length === 1);
check('wrapped {departments:[...]} unwraps', athena.listOf({ totalcount: 2, departments: [{ departmentid: 1 }, { departmentid: 2 }] }, 'departments').length === 2);
check('wrapped {appointments:[...]} unwraps', athena.listOf({ appointments: [{ appointmentid: 9 }] }, 'appointments').length === 1);
check('wrapped {insurances:[...]} unwraps', athena.listOf({ insurances: [{ sequencenumber: 1 }] }, 'insurances').length === 1);
check('patient array [0] shape preserved', athena.listOf([{ firstname: 'A' }], 'patients')[0].firstname === 'A');
check('null -> []', athena.listOf(null, 'departments').length === 0);
check('undefined -> []', athena.listOf(undefined, 'departments').length === 0);
check('object without arrays -> []', athena.listOf({ error: 'x' }, 'departments').length === 0);
check('empty object -> []', athena.listOf({}, 'departments').length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
