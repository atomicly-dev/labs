// Reads a lab's SQL file the way psql does, for the small part of psql that the labs use:
//
// - Statements end with `;`, or with `\gset`, which stores the row's columns in variables.
// - `:name` puts a variable's value into the SQL as it is, `:'name'` puts it in as a quoted
//   string literal, and `:"name"` as a quoted identifier.
// - Nothing inside quotes, dollar quotes, or comments changes, and `::` stays a cast.
//
// So the same file runs in the test and pasted into psql after `\set name value`.

import { escapeIdentifier, escapeLiteral } from "pg";

/**
 * @typedef {{ kind: "text", text: string } | { kind: "var", name: string, quote: "" | "'" | '"' }} Part
 * @typedef {{ parts: Part[], line: number, gset: null | { prefix: string } }} Statement
 */

/** Splits SQL text into statements. Throws an error with a line number for what it can't read. */
export function parseSqlFile(source) {
  /** @type {Statement[]} */
  const statements = [];
  /** @type {Part[]} */
  let parts = [];
  let text = "";
  let line = 1;
  let startLine = 0; // The line of the statement's first character that isn't a space or comment.
  let i = 0;

  const flushText = () => {
    if (text) parts.push({ kind: "text", text });
    text = "";
  };
  const endStatement = (gset) => {
    flushText();
    if (startLine) statements.push({ parts, line: startLine, gset });
    else if (gset) throw new SyntaxError(`line ${line}: \\gset has no query before it`);
    parts = [];
    startLine = 0;
  };
  // Copies source[i..end) into the current statement and counts its newlines.
  const take = (end) => {
    const chunk = source.slice(i, end);
    text += chunk;
    for (const ch of chunk) if (ch === "\n") line++;
    i = end;
  };
  const mark = () => {
    if (!startLine) startLine = line;
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (/\s/.test(ch)) {
      take(i + 1);
    } else if (ch === "-" && next === "-") {
      const end = source.indexOf("\n", i);
      take(end === -1 ? source.length : end);
    } else if (ch === "/" && next === "*") {
      let depth = 0;
      let j = i;
      while (j < source.length) {
        if (source.startsWith("/*", j)) (depth++, (j += 2));
        else if (source.startsWith("*/", j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      if (depth !== 0) throw new SyntaxError(`line ${line}: a /* comment never ends`);
      take(j);
    } else if (ch === "'") {
      mark();
      // E'...' strings allow backslash escapes. Standard strings only double the quote.
      const escapes = /[eE]$/.test(text) && !/[\w$]$/.test(text.slice(0, -1));
      let j = i + 1;
      for (;;) {
        if (j >= source.length) throw new SyntaxError(`line ${line}: a string never ends`);
        if (escapes && source[j] === "\\") j += 2;
        else if (source[j] === "'" && source[j + 1] === "'") j += 2;
        else if (source[j] === "'") break;
        else j++;
      }
      take(j + 1);
    } else if (ch === '"') {
      mark();
      let j = i + 1;
      for (;;) {
        if (j >= source.length) throw new SyntaxError(`line ${line}: a quoted name never ends`);
        if (source[j] === '"' && source[j + 1] === '"') j += 2;
        else if (source[j] === '"') break;
        else j++;
      }
      take(j + 1);
    } else if (ch === "$" && !/[\w$]$/.test(text)) {
      mark();
      const tag = /^\$([A-Za-z_][\w]*)?\$/.exec(source.slice(i));
      if (!tag) {
        take(i + 1);
        continue;
      }
      const end = source.indexOf(tag[0], i + tag[0].length);
      if (end === -1) throw new SyntaxError(`line ${line}: a ${tag[0]} quote never ends`);
      take(end + tag[0].length);
    } else if (ch === ":" && next === ":") {
      mark();
      take(i + 2);
    } else if (ch === ":" && /[A-Za-z_]/.test(next ?? "")) {
      mark();
      const name = /^[A-Za-z_]\w*/.exec(source.slice(i + 1))[0];
      flushText();
      parts.push({ kind: "var", name, quote: "" });
      i += 1 + name.length;
    } else if (ch === ":" && (next === "'" || next === '"')) {
      mark();
      const quoted = new RegExp(`^${next}([A-Za-z_]\\w*)${next}`).exec(source.slice(i + 1));
      if (!quoted) throw new SyntaxError(`line ${line}: write a variable as :${next}name${next}`);
      flushText();
      parts.push({ kind: "var", name: quoted[1], quote: next });
      i += 1 + quoted[0].length;
    } else if (ch === ";") {
      take(i + 1);
      endStatement(null);
    } else if (ch === "\\") {
      const end = source.indexOf("\n", i);
      const command = source.slice(i + 1, end === -1 ? source.length : end).trim();
      const gset = /^gset(?:\s+(\w+))?$/.exec(command);
      if (!gset) {
        throw new SyntaxError(
          `line ${line}: the test runs only SQL and \\gset, not \\${command.split(/\s/)[0]}`,
        );
      }
      i = end === -1 ? source.length : end;
      endStatement({ prefix: gset[1] ?? "" });
    } else {
      mark();
      take(i + 1);
    }
  }
  endStatement(null);
  return statements;
}

/** Puts the variables' values into a statement, the way psql does. */
export function interpolate(statement, vars) {
  let sql = "";
  for (const part of statement.parts) {
    if (part.kind === "text") {
      sql += part.text;
      continue;
    }
    if (!(part.name in vars)) {
      throw new Error(
        `the variable :${part.name} isn't set. ` +
          `This lab sets ${Object.keys(vars)
            .map((name) => `:${name}`)
            .join(", ")}.`,
      );
    }
    const value = String(vars[part.name]);
    if (part.quote === "'") sql += escapeLiteral(value);
    else if (part.quote === '"') sql += escapeIdentifier(value);
    else sql += value;
  }
  return sql.trim();
}

/** The statement's SQL with the variables' names, for messages. */
export function describe(statement) {
  const sql = statement.parts
    .map((part) => (part.kind === "text" ? part.text : `:${part.quote}${part.name}${part.quote}`))
    .join("")
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return sql.length > 90 ? `${sql.slice(0, 87)}...` : sql;
}
