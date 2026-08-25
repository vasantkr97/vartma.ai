const values = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

export function toRoman(number) {
  if (!Number.isInteger(number) || number < 1 || number > 3999) {
    throw new RangeError("Roman numerals support integers from 1 through 3999");
  }
  let remaining = number;
  let output = "";
  for (const [value, numeral] of values) {
    while (remaining >= value) {
      output += numeral;
      remaining -= value;
    }
  }
  return output;
}
