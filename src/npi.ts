// NPI validation, shared by the normalizer and the independent raw observer.

/** NPI check digit: Luhn over the prefix 80840 plus the first nine digits (CMS NPI standard). */
export function validNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const s = `80840${npi.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = Number(s[s.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}
