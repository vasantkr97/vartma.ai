export function parseCsv(source) {
  if (typeof source !== "string") throw new TypeError("CSV source must be a string");
  if (source === "") return [];
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field === "") quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new SyntaxError("Unterminated quoted CSV field");
  if (field !== "" || row.length > 0 || !/[\r\n]$/u.test(source)) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
