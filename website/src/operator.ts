// Who runs this website. The imprint and the privacy notice name the operator, but the repository
// holds no operator data: the values come from build variables, so that a fork shows its own.
//
//   PUBLIC_OPERATOR_NAME     name of the person or the company
//   PUBLIC_OPERATOR_ADDRESS  postal address, one line per line of the variable
//   PUBLIC_OPERATOR_EMAIL    contact address, also for privacy requests
//   PUBLIC_OPERATOR_DETAILS  optional imprint lines, one per line: for example the company
//                            register number and court, the VAT ID, the chamber or the authority
//
// If the name, the address or the email is missing, `operator` is null and the pages say that this
// build has no operator details. The deploy workflows set REQUIRE_OPERATOR=true: then a missing
// value stops the build, so such a build never goes live.

const value = (raw: string | undefined) => raw?.trim() ?? "";
const lines = (raw: string | undefined) =>
  value(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const name = value(import.meta.env.PUBLIC_OPERATOR_NAME);
const address = lines(import.meta.env.PUBLIC_OPERATOR_ADDRESS);
const email = value(import.meta.env.PUBLIC_OPERATOR_EMAIL);
const details = lines(import.meta.env.PUBLIC_OPERATOR_DETAILS);

export type Operator = { name: string; address: string[]; email: string; details: string[] };

export const operator: Operator | null =
  name && address.length > 0 && email.includes("@") ? { name, address, email, details } : null;

if (!operator && process.env.REQUIRE_OPERATOR === "true") {
  throw new Error("REQUIRE_OPERATOR is set, but an operator name, address or email is missing.");
}
