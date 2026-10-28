// Escapes a value for a Java .properties file (the format Gradle's Properties.load reads),
// used by the worker to hand signing passwords to the build without putting them in the
// build script. Uploaded keystore passwords can contain any character, so every one with
// special meaning in that format is escaped:
//   backslash → \\, newline/CR/tab/formfeed → \n \r \t \f, = : # ! and spaces → \= \: \# \! "\ ",
//   anything outside printable ASCII → \uXXXX (UTF-16 code units).
// Example: toJavaPropertiesValue("p@ss=w:rd é") → "p@ss\=w\:rd\ é"
export function toJavaPropertiesValue(value) {
  let out = "";
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\f") out += "\\f";
    else if ("=:#! ".includes(ch)) out += `\\${ch}`;
    else if (code < 0x20 || code > 0x7e) {
      // Characters outside the BMP become a surrogate pair, each written as \uXXXX.
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return out;
}
