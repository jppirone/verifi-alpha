// Unit test for the Florida fixed-width parser. The fixture is BUILT FROM THE PUBLISHED LAYOUT (positions in florida.ts), so it
// proves the parser reads the documented columns; it is synthetic, NOT a real Sunbiz record (see the report for why).
import assert from "node:assert/strict";
import { parseFlCorporateLine, parseFlCorporateFile, parseFlDate, FL_RECORD_LENGTH } from "../../supabase/functions/_shared/registry/florida.ts";
import { businessProblems } from "../../supabase/functions/_shared/registry/schema.ts";

function rec(parts: Array<[number, string]>): string {
  const b = Array(FL_RECORD_LENGTH).fill(" ");
  for (const [start, val] of parts) for (let i = 0; i < val.length; i++) b[start - 1 + i] = val[i];
  return b.join("");
}
const line = rec([
  [1, "L20000012345"], [13, "ACME WIDGET HOLDINGS, LLC"], [205, "A"], [206, "FLAL"], [221, "100 MAIN ST"], [305, "TAMPA"], [333, "FL"], [335, "33602"],
  [473, "03152020"], [481, "123456789     "], [495, "N"], [496, "07012024"], [545, "REGISTERED AGENTS INC"], [587, "C"],
  [669, "MGR "], [673, "P"], [674, "DOE JANE"], [797, "AMBR"], [801, "C"], [802, "PARENT CO LLC"],
]);
assert.equal(line.length, FL_RECORD_LENGTH);
const r = parseFlCorporateLine(line);
assert.ok(!("error" in r));
if ("error" in r) throw new Error(r.error);
assert.equal(r.entity_id, "L20000012345");
assert.equal(r.entity_name, "ACME WIDGET HOLDINGS, LLC");
assert.equal(r.status, "active");
assert.equal(r.registration_date, "2020-03-15");
assert.equal(r.entity_type, "Florida Limited Liability Company");
assert.equal(r.state, "FL");
assert.deepEqual((r.details as any).officers.map((o: any) => [o.name, o.title, o.kind]), [["DOE JANE", "MGR", "person"], ["PARENT CO LLC", "AMBR", "corporation"]]);
assert.equal((r.details as any).registered_agent, "REGISTERED AGENTS INC");
assert.deepEqual(businessProblems(r), []);

const inactive = parseFlCorporateLine(rec([[1, "P99000000001"], [13, "OLD CO"], [205, "I"], [206, "DOMP"], [473, "20010102"]]));
assert.ok(!("error" in inactive) && inactive.status === "inactive" && inactive.registration_date === "2001-01-02");

assert.equal(parseFlDate("03152020"), "2020-03-15");   // MMDDYYYY
assert.equal(parseFlDate("20200315"), "2020-03-15");   // YYYYMMDD
assert.equal(parseFlDate("13452020"), null);           // month 13 -> not a date, not guessed
assert.equal(parseFlDate("00000000"), null);
assert.equal(parseFlDate(null), null);

assert.ok("error" in parseFlCorporateLine("short"));
assert.ok("error" in parseFlCorporateLine(rec([[205, "A"]])));   // no id / name
const file = parseFlCorporateFile([line, "garbage", line.replace("L20000012345", "L20000099999")].join("\n") + "\n");
assert.equal(file.stats.parsed, 2); assert.equal(file.stats.rejected, 1); assert.equal(file.stats.rejectedSamples[0].line, 2);
console.log("florida parser: all assertions passed (synthetic layout-derived fixture)");
