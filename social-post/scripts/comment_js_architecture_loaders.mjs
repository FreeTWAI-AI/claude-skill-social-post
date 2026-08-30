/** Conservative loader-shaped reference detection over lexical gate tokens. */

const LOADER_KINDS = new Map([
  ["createRequire", "create-require"],
  ["eval", "eval-loader"],
  ["Function", "function-loader"],
  ["require", "require"],
]);

function tokenCall(tokens, index) {
  return tokens[index + 1]?.type === "punct" && tokens[index + 1].value === "(";
}

function bracketReference(tokens, index) {
  const previous = tokens[index - 1];
  const close = tokens[index + 1];
  if (previous?.type !== "punct" || previous.value !== "[") return null;
  if (close?.type !== "punct" || close.value !== "]") return null;
  const call = tokens[index + 2]?.type === "punct" && tokens[index + 2].value === "(";
  if (tokens[index].value === "import") {
    return {
      kind: call ? "dynamic" : "loader-reference",
      argumentOffset: call ? 3 : null,
    };
  }
  const loaderKind = LOADER_KINDS.get(tokens[index].value);
  if (!loaderKind) return null;
  return {
    kind: call ? loaderKind : "loader-reference",
    argumentOffset: call ? 3 : null,
  };
}

export function loaderSyntaxAt(tokens, index) {
  const current = tokens[index];
  if (current.type === "string") return bracketReference(tokens, index);
  if (current.type !== "identifier" || current.value === "import") return null;
  const loaderKind = LOADER_KINDS.get(current.value);
  if (!loaderKind) return null;
  return {
    kind: tokenCall(tokens, index) ? loaderKind : "loader-reference",
    argumentOffset: tokenCall(tokens, index) ? 2 : null,
  };
}
