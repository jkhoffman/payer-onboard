// Generic terminology knowledge: canonical code-system URIs and common mistakes.
// Payer-specific aliases live in the vendor layer (config), not here.

/** Wrong-but-common system URIs mapped to the canonical HL7 terminology URI. */
export const SYSTEM_ALIASES: Record<string, string> = {
  // The extension's StructureDefinition URL used where the CodeSystem URL belongs.
  'http://hl7.org/fhir/StructureDefinition/data-absent-reason': 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
  'http://hl7.org/fhir/data-absent-reason': 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
};

export const DATA_ABSENT = 'http://terminology.hl7.org/CodeSystem/data-absent-reason';
export const ICD10_CM = 'http://hl7.org/fhir/sid/icd-10-cm';
export const ADJUDICATION = 'http://terminology.hl7.org/CodeSystem/adjudication';
export const C4BB_ADJUDICATION = 'http://hl7.org/fhir/us/carin-bb/CodeSystem/C4BBAdjudication';
export const NPI = 'http://hl7.org/fhir/sid/us-npi';
export const CARIN_CLAIM_TYPE = 'http://terminology.hl7.org/CodeSystem/claim-type';

/** Codes defined by the base adjudication CodeSystem, so a missing system can be restored unambiguously. */
export const ADJUDICATION_CODES = new Set(['submitted', 'copay', 'eligible', 'deductible', 'unallocdeduct', 'eligpercent', 'tax', 'benefit']);
export const C4BB_ADJUDICATION_CODES = new Set(['coinsurance', 'noncovered', 'priorpayerpaid', 'paidbypatient', 'paidtoprovider', 'memberliability', 'discount', 'drugcost']);

/** Equivalent systems: the second is a less specific spelling of the first for the same code. */
export const SAME_CODE_SYSTEMS: Array<[string, string]> = [[ICD10_CM, 'http://hl7.org/fhir/sid/icd-10']];
